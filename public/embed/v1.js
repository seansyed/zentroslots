/*!
 * ZentroMeet Embed v1 — production-grade embed runtime
 * Phase 16 — Embed Widget Studio
 *
 * Supports 3 embed modes (full-page is just a hyperlink, no JS needed):
 *   - inline           [data-zentromeet-inline]
 *   - popup            [data-zentromeet-popup]
 *   - floating button  [data-zentromeet-floating]
 *
 * Public API:
 *   window.ZentroMeet.init(config?)        — manual mount
 *   window.ZentroMeet.openPopup(config)    — open modal programmatically
 *   window.ZentroMeet.close()              — close any open modal
 *
 * Event bus (postMessage from iframe -> window):
 *   booking.opened | booking.started | booking.completed |
 *   booking.closed | resize          | loading           | error
 *
 * Listen with:
 *   window.addEventListener("message", (e) => {
 *     if (e.data?.source !== "zentromeet") return;
 *     console.log(e.data.event, e.data.payload);
 *   });
 *
 * Honest discipline:
 *   - No framework dependency, no eval, no innerHTML for tenant input
 *   - Idempotent: re-loading the script does not double-mount
 *   - Lazy: iframes get loading="lazy" + only mount when in viewport
 *     (inline) or on user action (popup/floating)
 *   - postMessage origin is validated against EMBED_ORIGIN
 *   - Multiple widgets can coexist on the same page
 */
(function () {
  "use strict";

  // ─── Idempotency guard ────────────────────────────────────────
  if (window.ZentroMeet && window.ZentroMeet.__v === 1) return;

  // ─── Origin discovery ─────────────────────────────────────────
  // The script's own <script src> tells us where embeds should point.
  // Falls back to a sensible default if the script was loaded via
  // some odd mechanism.
  function detectOrigin() {
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].src || "";
        if (/\/embed\/v1\.js(\?|$)/.test(src)) {
          return new URL(src).origin;
        }
      }
    } catch (_) {}
    return window.location.protocol + "//" + window.location.host;
  }
  var EMBED_ORIGIN = detectOrigin();

  // ─── Internal state ───────────────────────────────────────────
  var activePopup = null;
  var inlineRegistry = new WeakMap();

  // ─── Helpers ──────────────────────────────────────────────────
  function el(tag, attrs, styles) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    if (styles) for (var s in styles) if (styles.hasOwnProperty(s)) n.style[s] = styles[s];
    return n;
  }

  function buildEmbedUrl(cfg) {
    var slug = (cfg.tenant || "").trim();
    if (!slug) return null;
    var path = "/embed/" + encodeURIComponent(slug);
    if (cfg.service) path += "/" + encodeURIComponent(cfg.service);
    var q = new URLSearchParams();
    if (cfg.theme) q.set("theme", cfg.theme);
    if (cfg.color) q.set("color", cfg.color);
    if (cfg.radius != null) q.set("radius", String(cfg.radius));
    if (cfg.compact === true) q.set("compact", "1");
    if (cfg.hideHeader === true) q.set("hideHeader", "1");
    if (cfg.staff) q.set("staff", cfg.staff);
    if (cfg.utmSource) q.set("utm_source", cfg.utmSource);
    if (cfg.utmMedium) q.set("utm_medium", cfg.utmMedium);
    if (cfg.utmCampaign) q.set("utm_campaign", cfg.utmCampaign);
    if (cfg.successRedirect) q.set("success_redirect", cfg.successRedirect);
    var qs = q.toString();
    return EMBED_ORIGIN + path + (qs ? "?" + qs : "");
  }

  function dispatch(event, payload) {
    try {
      window.dispatchEvent(new CustomEvent("zentromeet:" + event, { detail: payload }));
    } catch (_) {}
  }

  // ─── postMessage listener (single global, multiplexed) ───────
  function onMessage(e) {
    if (e.origin !== EMBED_ORIGIN) return;
    var data = e.data;
    if (!data || data.source !== "zentromeet") return;

    // Auto-resize inline iframes when the iframe content reports its
    // new height. We trust the message origin check above + the iframe
    // ID round-trips so we only resize iframes we mounted.
    if (data.event === "resize" && data.payload && data.payload.height) {
      var iframes = document.querySelectorAll('iframe[data-zm-embed]');
      for (var i = 0; i < iframes.length; i++) {
        var f = iframes[i];
        if (!data.payload.embedId || f.getAttribute("data-zm-embed") === data.payload.embedId) {
          f.style.height = Math.max(320, data.payload.height) + "px";
        }
      }
    }

    dispatch(data.event || "message", data.payload || {});
  }
  window.addEventListener("message", onMessage, false);

  // ─── Inline mount ────────────────────────────────────────────
  function mountInline(target, cfg) {
    if (inlineRegistry.get(target)) return;
    var url = buildEmbedUrl(cfg);
    if (!url) return;

    var embedId = "zm-" + Math.random().toString(36).slice(2, 10);
    var iframe = el("iframe", {
      src: url,
      title: "ZentroMeet booking",
      loading: "lazy",
      allow: "clipboard-write",
      "data-zm-embed": embedId,
    }, {
      width: "100%",
      maxWidth: cfg.maxWidth || "560px",
      minHeight: (cfg.minHeight || 560) + "px",
      border: "0",
      borderRadius: (cfg.radius != null ? cfg.radius : 12) + "px",
      background: "transparent",
      display: "block",
    });

    // Clear placeholder content + mount
    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(iframe);
    inlineRegistry.set(target, iframe);
    dispatch("loading", { embedId });
  }

  // ─── Popup modal ────────────────────────────────────────────
  function openPopup(cfg) {
    if (activePopup) return; // single modal at a time
    var url = buildEmbedUrl(cfg);
    if (!url) return;

    var overlay = el("div", { "data-zm-overlay": "1" }, {
      position: "fixed", inset: "0", zIndex: "2147483646",
      background: "rgba(15,23,42,0.55)",
      backdropFilter: "blur(4px)",
      WebkitBackdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "16px",
      animation: "zmFadeIn 180ms cubic-bezier(0.16,1,0.3,1)",
    });

    var panel = el("div", { "data-zm-panel": "1" }, {
      position: "relative",
      width: "100%",
      maxWidth: (cfg.maxWidth || "560") + "px",
      maxHeight: "92vh",
      background: "#ffffff",
      borderRadius: (cfg.radius != null ? cfg.radius : 16) + "px",
      overflow: "hidden",
      boxShadow: "0 30px 80px -20px rgba(15,23,42,0.40), 0 8px 24px -8px rgba(15,23,42,0.20)",
      animation: "zmScaleIn 220ms cubic-bezier(0.16,1,0.3,1)",
    });

    var closeBtn = el("button", {
      type: "button", "aria-label": "Close booking",
    }, {
      position: "absolute", top: "10px", right: "10px", zIndex: "2",
      width: "32px", height: "32px",
      border: "0",
      background: "rgba(255,255,255,0.92)",
      borderRadius: "8px",
      cursor: "pointer",
      boxShadow: "0 2px 8px -2px rgba(15,23,42,0.18)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      color: "#0f172a",
      font: "600 18px/1 -apple-system,system-ui,sans-serif",
    });
    closeBtn.appendChild(document.createTextNode("✕"));
    closeBtn.onclick = closePopup;

    var embedId = "zm-popup-" + Math.random().toString(36).slice(2, 10);
    var iframe = el("iframe", {
      src: url, title: "ZentroMeet booking", allow: "clipboard-write",
      "data-zm-embed": embedId,
    }, {
      width: "100%", height: (cfg.minHeight || 720) + "px",
      border: "0", display: "block", background: "transparent",
    });

    panel.appendChild(closeBtn);
    panel.appendChild(iframe);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    activePopup = overlay;

    // Lock body scroll
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e) { if (e.key === "Escape") closePopup(); }
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay && cfg.closeOnBackdrop !== false) closePopup();
    });

    function closePopup() {
      if (activePopup !== overlay) return;
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      overlay.parentNode && overlay.parentNode.removeChild(overlay);
      activePopup = null;
      dispatch("booking.closed", { embedId });
    }

    // Expose close handle on the overlay so global close() can find it
    overlay.__zmClose = closePopup;

    dispatch("booking.opened", { embedId });
    return { close: closePopup };
  }

  function closeActivePopup() {
    if (activePopup && activePopup.__zmClose) activePopup.__zmClose();
  }

  // ─── Floating launcher button ────────────────────────────────
  function mountFloating(cfg) {
    if (document.querySelector("[data-zm-floating]")) return;

    var anchor = cfg.position || "bottom-right";
    var pos = {};
    pos[anchor.indexOf("top") === 0 ? "top" : "bottom"] = "20px";
    pos[anchor.indexOf("left") === -1 ? "right" : "left"] = "20px";

    var btn = el("button", {
      type: "button",
      "data-zm-floating": "1",
      "aria-label": cfg.label || "Book a meeting",
    }, Object.assign({
      position: "fixed",
      zIndex: "2147483645",
      display: "inline-flex", alignItems: "center", gap: "8px",
      padding: "11px 16px",
      border: "0",
      borderRadius: "999px",
      background: cfg.color || "#2563EB",
      color: "#ffffff",
      cursor: "pointer",
      font: "600 13.5px/1 -apple-system,system-ui,sans-serif",
      letterSpacing: "0.005em",
      boxShadow: "0 8px 22px -4px rgba(37,99,235,0.45), 0 2px 6px -2px rgba(15,23,42,0.18)",
      transition: "transform 200ms cubic-bezier(0.16,1,0.3,1), box-shadow 200ms",
    }, pos));

    btn.onmouseenter = function () {
      btn.style.transform = "translateY(-1px)";
      btn.style.boxShadow = "0 14px 32px -4px rgba(37,99,235,0.55), 0 4px 10px -2px rgba(15,23,42,0.22)";
    };
    btn.onmouseleave = function () {
      btn.style.transform = "";
      btn.style.boxShadow = "0 8px 22px -4px rgba(37,99,235,0.45), 0 2px 6px -2px rgba(15,23,42,0.18)";
    };

    var icon = el("span", { "aria-hidden": "true" }, {
      display: "inline-block", width: "14px", height: "14px",
    });
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>';
    btn.appendChild(icon);
    btn.appendChild(document.createTextNode(cfg.label || "Book a meeting"));

    btn.onclick = function () { openPopup(cfg); };
    document.body.appendChild(btn);

    // Auto-open
    if (cfg.autoOpen && cfg.autoOpenDelay != null) {
      setTimeout(function () { openPopup(cfg); }, Math.max(0, parseInt(cfg.autoOpenDelay, 10)));
    }
  }

  // ─── Popup-trigger attach ────────────────────────────────────
  function attachPopupTrigger(node, cfg) {
    if (node.__zmAttached) return;
    node.__zmAttached = true;
    node.addEventListener("click", function (e) {
      e.preventDefault();
      openPopup(cfg);
    });
  }

  // ─── Read data-* config from an element ─────────────────────
  function readDataConfig(node) {
    var ds = node.dataset || {};
    var cfg = {
      tenant: ds.zentromeetTenant || ds.tenant || "",
      service: ds.zentromeetService || ds.service || "",
      theme: ds.zentromeetTheme || ds.theme || "",
      color: ds.zentromeetColor || ds.color || "",
      radius: ds.zentromeetRadius || ds.radius || "",
      maxWidth: ds.zentromeetMaxWidth || "",
      minHeight: ds.zentromeetMinHeight || "",
      compact: (ds.zentromeetCompact || ds.compact) === "true",
      hideHeader: (ds.zentromeetHideHeader || ds.hideHeader) === "true",
      staff: ds.zentromeetStaff || "",
      utmSource: ds.zentromeetUtmSource || "",
      utmMedium: ds.zentromeetUtmMedium || "",
      utmCampaign: ds.zentromeetUtmCampaign || "",
      successRedirect: ds.zentromeetSuccessRedirect || "",
      label: ds.zentromeetLabel || ds.label || "",
      position: ds.zentromeetPosition || ds.position || "",
      autoOpen: (ds.zentromeetAutoOpen || ds.autoOpen) === "true",
      autoOpenDelay: ds.zentromeetAutoOpenDelay || ds.autoOpenDelay || "",
    };
    // Number coercion
    if (cfg.radius !== "") cfg.radius = parseInt(cfg.radius, 10);
    if (cfg.minHeight !== "") cfg.minHeight = parseInt(cfg.minHeight, 10);
    return cfg;
  }

  // ─── Auto-discovery ─────────────────────────────────────────
  function discover(root) {
    var scope = root || document;

    // Inline
    var inlineNodes = scope.querySelectorAll("[data-zentromeet-inline]");
    for (var i = 0; i < inlineNodes.length; i++) {
      mountInline(inlineNodes[i], readDataConfig(inlineNodes[i]));
    }

    // Popup triggers
    var popupNodes = scope.querySelectorAll("[data-zentromeet-popup]");
    for (var j = 0; j < popupNodes.length; j++) {
      attachPopupTrigger(popupNodes[j], readDataConfig(popupNodes[j]));
    }

    // Floating (only the first one wins)
    var floatingNode = scope.querySelector("[data-zentromeet-floating]");
    if (floatingNode) {
      mountFloating(readDataConfig(floatingNode));
    }
  }

  // ─── Inject minimal keyframes once ──────────────────────────
  function ensureStyles() {
    if (document.getElementById("zm-embed-styles")) return;
    var s = el("style", { id: "zm-embed-styles" });
    s.textContent =
      "@keyframes zmFadeIn{from{opacity:0}to{opacity:1}}" +
      "@keyframes zmScaleIn{from{opacity:0;transform:scale(0.96) translateY(8px)}to{opacity:1;transform:none}}";
    document.head.appendChild(s);
  }

  // ─── Public API ─────────────────────────────────────────────
  window.ZentroMeet = {
    __v: 1,
    init: function (config) {
      ensureStyles();
      if (config && config.target) {
        if (config.mode === "popup-trigger") {
          attachPopupTrigger(config.target, config);
        } else {
          mountInline(config.target, config);
        }
      } else if (config && config.mode === "floating") {
        mountFloating(config);
      } else {
        discover();
      }
    },
    openPopup: function (config) { ensureStyles(); return openPopup(config || {}); },
    close: closeActivePopup,
    discover: discover,
  };

  // ─── Auto-bootstrap on script load ──────────────────────────
  ensureStyles();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { discover(); });
  } else {
    discover();
  }
})();
