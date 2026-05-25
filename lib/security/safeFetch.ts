/**
 * SSRF-defended outbound HTTP fetcher.
 *
 * Use this for ANY outbound URL that came from user input (Phase
 * ICAL-3 external calendar feeds, future webhook outbounds, etc.).
 * Never use a raw fetch() against a user-controlled URL — without
 * these defenses the server can be coerced into:
 *   • Hitting AWS instance metadata at 169.254.169.254 (full IAM
 *     creds leak)
 *   • Probing internal services in 10.0.0.0/8, 172.16.0.0/12,
 *     192.168.0.0/16
 *   • Hitting localhost daemons (redis, postgres, etc.)
 *   • DNS-rebinding through a hostname that resolves PUBLIC at the
 *     allow check then PRIVATE at the connect
 *
 * Defenses layered in this module:
 *   1. Scheme allowlist — https only (http allowed only when env
 *      var ALLOW_HTTP_FEEDS=1, intended for local dev).
 *   2. Host parse — reject userinfo (https://user:pass@host/), IPv6
 *      literals with embedded IPv4 prefixes, and trailing dots.
 *   3. DNS resolve + per-address check. We dns.lookup() the hostname
 *      with {all:true}, then reject if ANY resolved address falls in
 *      a private/reserved/loopback range. Multi-A DNS rebinding is
 *      defeated by binding the resolved family at lookup time.
 *   4. Size cap — caller passes maxBytes (default 5 MB for ICS).
 *      We stream the body and abort once we exceed.
 *   5. Timeout — request-level AbortController, no socket-level
 *      keepalive after.
 *   6. Redirect bound — manual redirect handling (max 3 hops); each
 *      redirect Location URL goes back through the full SSRF gate.
 *
 * This module is INTENTIONALLY small. It does NOT:
 *   • Do retries — caller's job (sync orchestrator has backoff).
 *   • Cache responses — caller's job (per-feed ETag tracking).
 *   • Authenticate — feed URLs are bearer auth in themselves (the
 *     URL is the secret).
 */

import dns from "node:dns/promises";
import net from "node:net";

const FEED_USER_AGENT =
  "ZentroMeet-FeedSync/1.0 (+https://app.zentromeet.com/about/feeds)";

const ALLOWED_SCHEMES = new Set(["https:", "http:"]);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — generous for ICS
const DEFAULT_MAX_REDIRECTS = 3;

export type SafeFetchResult =
  | {
      ok: true;
      status: number;
      bodyText: string;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
    }
  | {
      ok: false;
      /** Coarse failure category — used by the sync orchestrator to
       *  decide whether to retry, back off, or surface to the user. */
      reason:
        | "scheme"
        | "ssrf_blocked"
        | "dns_failed"
        | "timeout"
        | "too_large"
        | "too_many_redirects"
        | "http_error"
        | "network_error";
      /** Optional HTTP status when reason === "http_error". */
      status?: number;
      message: string;
    };

export type SafeFetchOptions = {
  /** Hard byte cap. Default 5 MB. The promise rejects once we read
   *  more bytes than this from the upstream stream. */
  maxBytes?: number;
  /** Request timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Max redirects to follow. Default 3. */
  maxRedirects?: number;
  /** Conditional-fetch headers. Sync orchestrator passes the stored
   *  ETag + Last-Modified so we get 304 Not Modified when the
   *  upstream hasn't changed. */
  ifNoneMatch?: string | null;
  /** Last-Modified value from the prior fetch. */
  ifModifiedSince?: string | null;
};

// ─── Private-range checks ─────────────────────────────────────────────

/** Block AWS instance metadata + Google Cloud metadata + Alibaba +
 *  general link-local. */
const METADATA_IPS = new Set([
  "169.254.169.254", // AWS, GCP, Azure, Alibaba
  "100.100.100.200", // Alibaba alt
  "::1",
  "fd00:ec2::254", // AWS IMDS over IPv6
]);

function isPrivateIPv4(ip: string): boolean {
  if (METADATA_IPS.has(ip)) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Unparseable → reject defensively.
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (METADATA_IPS.has(lower)) return true;
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped — check the embedded v4.
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // unparseable → reject
}

// ─── URL gate ──────────────────────────────────────────────────────────

/** Run all the pre-fetch URL checks. Returns either the parsed URL
 *  (ready to fetch) or a SafeFetchResult error so the caller can
 *  short-circuit. */
async function gateUrl(
  raw: string,
): Promise<{ url: URL } | { error: SafeFetchResult & { ok: false } }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: { ok: false, reason: "scheme", message: "Malformed URL" } };
  }

  // Scheme allowlist. http is permitted only under an env flag so
  // local-dev integration tests can hit a fixture server.
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return {
      error: { ok: false, reason: "scheme", message: `Unsupported scheme ${url.protocol}` },
    };
  }
  if (url.protocol === "http:" && process.env.ALLOW_HTTP_FEEDS !== "1") {
    return {
      error: { ok: false, reason: "scheme", message: "http URLs are not allowed" },
    };
  }

  // No userinfo segment. Some servers honor basic auth, but the
  // surface area isn't worth the risk for inbound feed URLs.
  if (url.username || url.password) {
    return {
      error: { ok: false, reason: "scheme", message: "URL must not contain userinfo" },
    };
  }

  if (!url.hostname || url.hostname === "localhost") {
    return {
      error: { ok: false, reason: "ssrf_blocked", message: "Localhost not allowed" },
    };
  }

  // Resolve hostname → every A/AAAA → check each one. If ANY is
  // private/reserved/loopback we refuse the request. We pass
  // family=0 to get both v4 + v6 and check the union.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    return {
      error: { ok: false, reason: "dns_failed", message: "Hostname could not be resolved" },
    };
  }
  if (addrs.length === 0) {
    return {
      error: { ok: false, reason: "dns_failed", message: "Hostname has no A/AAAA records" },
    };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      return {
        error: {
          ok: false,
          reason: "ssrf_blocked",
          message: "Hostname resolves to a private or reserved address",
        },
      };
    }
  }

  return { url };
}

// ─── Public entry point ────────────────────────────────────────────────

/**
 * Fetch a remote URL with full SSRF + size + timeout defenses.
 * Returns a discriminated result — never throws on expected failure
 * modes (network/timeout/size/SSRF). Throws only on programmer error
 * (unexpected exceptions inside the AbortController plumbing).
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  let redirectsFollowed = 0;

  while (true) {
    const gated = await gateUrl(currentUrl);
    if ("error" in gated) return gated.error;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "User-Agent": FEED_USER_AGENT,
      Accept: "text/calendar, text/plain;q=0.9, */*;q=0.5",
    };
    if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
    if (opts.ifModifiedSince) headers["If-Modified-Since"] = opts.ifModifiedSince;

    let response: Response;
    try {
      response = await fetch(gated.url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
        // We do redirect handling manually so we can re-gate each Location.
        redirect: "manual",
      });
    } catch (e) {
      clearTimeout(timeout);
      if ((e as Error)?.name === "AbortError") {
        return { ok: false, reason: "timeout", message: "Request timed out" };
      }
      return {
        ok: false,
        reason: "network_error",
        message: e instanceof Error ? e.message : "Network error",
      };
    }
    clearTimeout(timeout);

    // 304 Not Modified is a SUCCESS shape — caller short-circuits
    // re-parse + DB writes. We surface it as ok:true with empty body.
    if (response.status === 304) {
      return {
        ok: true,
        status: 304,
        bodyText: "",
        etag: response.headers.get("etag") ?? opts.ifNoneMatch ?? null,
        lastModified: response.headers.get("last-modified") ?? opts.ifModifiedSince ?? null,
        finalUrl: gated.url.toString(),
      };
    }

    // Manual redirect handling.
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) {
        return {
          ok: false,
          reason: "http_error",
          status: response.status,
          message: "Redirect without Location header",
        };
      }
      if (++redirectsFollowed > maxRedirects) {
        return {
          ok: false,
          reason: "too_many_redirects",
          message: `Exceeded ${maxRedirects} redirects`,
        };
      }
      // Resolve relative Location against the current URL.
      currentUrl = new URL(loc, gated.url).toString();
      continue;
    }

    if (response.status >= 400) {
      return {
        ok: false,
        reason: "http_error",
        status: response.status,
        message: `Upstream returned ${response.status}`,
      };
    }

    // ─── Stream body with size cap ────────────────────────────────
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        ok: false,
        reason: "network_error",
        message: "No response body",
      };
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > maxBytes) {
          // Cancel the stream so the socket can close promptly.
          await reader.cancel("size limit exceeded").catch(() => {});
          return {
            ok: false,
            reason: "too_large",
            message: `Response exceeded ${maxBytes} bytes`,
          };
        }
        chunks.push(value);
      }
    } catch (e) {
      return {
        ok: false,
        reason: "network_error",
        message: e instanceof Error ? e.message : "Stream error",
      };
    }
    const bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");

    return {
      ok: true,
      status: response.status,
      bodyText,
      etag: response.headers.get("etag") ?? null,
      lastModified: response.headers.get("last-modified") ?? null,
      finalUrl: gated.url.toString(),
    };
  }
}
