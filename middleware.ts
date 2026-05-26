/**
 * Custom-domain hostname routing — Phase 15A.
 *
 * Runs on EVERY non-asset request. For canonical hosts (the app's own
 * domain, localhost, and direct IPs), it passes through immediately
 * with zero DB work. For every other hostname it consults the
 * cached tenant_domains index and — if the host is verified — rewrites
 * the root path to the corresponding /u/[slug] route.
 *
 * Safety guarantees (CRITICAL — see brief Part 10):
 *
 *   - The matcher excludes /api/*, /_next/*, static files, robots, sitemap.
 *   - Canonical hosts (app.zentromeet.com, localhost, raw IPs) short-
 *     circuit BEFORE any DB work — no risk of breaking app surfaces.
 *   - Only the EXACT root path (/) is rewritten. Every other path
 *     (/dashboard/*, /reschedule/*, /u/*, /embed/*, etc.) passes
 *     through unchanged so existing routes keep working.
 *   - On any DB failure, resolveTenantByHostname returns null and we
 *     pass through — never crash, never redirect-loop.
 *   - Negative cache entries (60s TTL) prevent the DB from being hit
 *     on every request for hosts that aren't claimed.
 *
 * Why node runtime: this middleware imports lib/domains.ts which
 * imports db/client.ts → postgres-js. Edge runtime can't load native
 * pg drivers. The Next.js Node middleware runtime is opted-in via
 * next.config.ts → experimental.nodeMiddleware.
 */

import { NextResponse, type NextRequest } from "next/server";

import { isCanonicalHost, resolveTenantByHostname } from "@/lib/domains";

export const runtime = "nodejs";

export const config = {
  // Only run for surfaces that can legitimately serve a public booking
  // root. Excludes:
  //   - /api/*       (server routes, never need a rewrite)
  //   - /_next/*     (build assets, served verbatim)
  //   - common static files in /public
  //   - dashboard surfaces — never rewrite admin pages
  matcher: [
    "/((?!api/|_next/|favicon\\.ico|robots\\.txt|sitemap\\.xml|dashboard/|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js|woff|woff2|ttf|map)).*)",
  ],
};

/**
 * Stabilization Wave — correlation id injection.
 *
 * Generates (or preserves) `x-request-id` on every middleware-matched
 * request. The id is propagated to the downstream Next.js route via
 * a forwarded request header AND mirrored onto the response so the
 * browser/uptime monitor can pin a customer-reported issue to the
 * server logs.
 *
 * Performance: crypto.randomUUID is sub-microsecond. The header set
 * is O(1). Total per-request overhead is unmeasurable.
 */
function pickOrMintRequestId(req: NextRequest): string {
  const existing = req.headers.get("x-request-id");
  if (existing && existing.length >= 8 && existing.length <= 128) {
    return existing;
  }
  try {
    return crypto.randomUUID();
  } catch {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
}

function withRequestId(req: NextRequest, res: NextResponse, reqId: string): NextResponse {
  res.headers.set("x-request-id", reqId);
  return res;
}

export async function middleware(req: NextRequest) {
  const reqId = pickOrMintRequestId(req);
  const pathname = req.nextUrl.pathname;

  // We only rewrite the EXACT root path. Booking sub-paths
  // (/u/[slug]/[serviceSlug], /reschedule/[token], etc.) already
  // contain everything they need and shouldn't be touched.
  if (pathname !== "/") {
    // Forward the request id into the downstream handler via a
    // mutated request header, mirror it on the response.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-request-id", reqId);
    return withRequestId(
      req,
      NextResponse.next({ request: { headers: requestHeaders } }),
      reqId,
    );
  }

  const rawHost = req.headers.get("host")?.split(":")[0] ?? "";
  if (!rawHost) {
    return withRequestId(req, NextResponse.next(), reqId);
  }
  if (isCanonicalHost(rawHost)) {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-request-id", reqId);
    return withRequestId(
      req,
      NextResponse.next({ request: { headers: requestHeaders } }),
      reqId,
    );
  }

  const resolved = await resolveTenantByHostname(rawHost);
  if (!resolved) {
    // Unknown / unverified hostname — pass through. Next will serve
    // the default landing page (or whatever lives at /).
    return withRequestId(req, NextResponse.next(), reqId);
  }

  // Rewrite root → /u/{slug}. The customer's URL stays as
  // https://book.acme.com/, Next renders the public profile page,
  // and internal links (/u/{slug}/{serviceSlug}, /reschedule/...) keep
  // working unchanged.
  const target = req.nextUrl.clone();
  target.pathname = `/u/${resolved.slug}`;
  return withRequestId(req, NextResponse.rewrite(target), reqId);
}
