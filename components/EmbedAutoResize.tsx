"use client";

import * as React from "react";

/**
 * Phase 16 — Embed runtime bridge.
 *
 * Mounted inside the /embed/* iframe. Two responsibilities:
 *
 *   1. Auto-resize: a ResizeObserver on the document body posts the
 *      current scrollHeight to the parent window so the embed runtime
 *      (public/embed/v1.js) can resize the iframe to fit. Without this
 *      the iframe is fixed-height and the customer gets internal
 *      scrollbars or wasted whitespace.
 *
 *   2. Event bus: dispatches lifecycle events to the parent via
 *      postMessage. Currently fires "booking.opened" on mount; other
 *      events ("booking.started", "booking.completed", "error") plug in
 *      when the BookingFlow component surfaces them.
 *
 * All messages tagged { source: "zentromeet", event, payload }.
 *
 * Honest discipline: no global side effects beyond two listeners +
 * one observer, all torn down on unmount. No tracking pixels — that's
 * the dedicated EmbedPixel component's job.
 */
export default function EmbedAutoResize({
  embedId,
  slug,
  serviceSlug,
}: {
  embedId?: string;
  slug: string;
  serviceSlug?: string;
}) {
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    // Only run when actually iframed — parent === window means
    // someone opened /embed/... directly in a browser tab and we
    // don't need to message anyone.
    if (window.parent === window) return;

    function post(event: string, payload: Record<string, unknown> = {}) {
      try {
        window.parent.postMessage(
          {
            source: "zentromeet",
            event,
            payload: { embedId, slug, serviceSlug, ...payload },
          },
          "*",
        );
      } catch {
        /* ignore */
      }
    }

    function measureAndPost() {
      const h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      post("resize", { height: h });
    }

    // Initial open
    post("booking.opened", {});
    measureAndPost();

    // ResizeObserver — fires on every layout change inside the iframe
    let ro: ResizeObserver | null = null;
    if ("ResizeObserver" in window) {
      ro = new ResizeObserver(() => measureAndPost());
      ro.observe(document.body);
    }

    // Fallback poll for browsers without RO (Safari < 13). Light:
    // 1Hz only; cancels on unmount.
    const id = window.setInterval(measureAndPost, 1000);

    return () => {
      window.clearInterval(id);
      if (ro) ro.disconnect();
      try {
        post("booking.closed", {});
      } catch {
        /* ignore */
      }
    };
  }, [embedId, slug, serviceSlug]);

  return null;
}
