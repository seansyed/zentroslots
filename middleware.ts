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

export async function middleware(req: NextRequest) {
  // We only rewrite the EXACT root path. Booking sub-paths
  // (/u/[slug]/[serviceSlug], /reschedule/[token], etc.) already
  // contain everything they need and shouldn't be touched.
  const pathname = req.nextUrl.pathname;
  if (pathname !== "/") {
    return NextResponse.next();
  }

  const rawHost = req.headers.get("host")?.split(":")[0] ?? "";
  if (!rawHost) return NextResponse.next();
  if (isCanonicalHost(rawHost)) return NextResponse.next();

  const resolved = await resolveTenantByHostname(rawHost);
  if (!resolved) {
    // Unknown / unverified hostname — pass through. Next will serve
    // the default landing page (or whatever lives at /).
    return NextResponse.next();
  }

  // Rewrite root → /u/{slug}. The customer's URL stays as
  // https://book.acme.com/, Next renders the public profile page,
  // and internal links (/u/{slug}/{serviceSlug}, /reschedule/...) keep
  // working unchanged.
  const target = req.nextUrl.clone();
  target.pathname = `/u/${resolved.slug}`;
  return NextResponse.rewrite(target);
}
