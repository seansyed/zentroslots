import type { NextConfig } from "next";

// Build-config note: lint + typecheck are intentionally skipped at
// `next build` time so deploys on the small EC2 instance don't stall
// in the post-compile type-check phase (which can take 90s+ and
// regularly OOM'd the 1.9GB box). Type safety is preserved via
// `tsc --noEmit` running locally before every commit and via the
// strict-mode editor surface — so this is a deploy-performance
// optimization, not a correctness compromise. ESLint similarly runs
// in CI/editor, not at build time.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
    // Phase 15A: custom-domain middleware queries the DB to resolve
    // hostnames → tenant slugs. The Node.js runtime is required for
    // postgres-js; the Edge runtime can't load it. Stable runtime
    // option in Next 15.x — the type definitions lag behind the
    // shipped feature flag, so we cast through `unknown`.
    nodeMiddleware: true,
  } as NextConfig["experimental"] & { nodeMiddleware: boolean },

  // Phase 16 + Stabilization Wave: per-route response headers.
  async headers() {
    // Stabilization Wave — global security baseline applied to every
    // app surface that isn't explicitly overridden below (embed
    // iframes deliberately opt out of the strict frame policy).
    const securityBaseline = [
      // Stop browsers from MIME-sniffing responses. Mitigates a class
      // of injection where an HTML payload is served from a route
      // expected to return JSON.
      { key: "X-Content-Type-Options", value: "nosniff" },
      // Refuse to be embedded except by ourselves. Embed routes opt
      // out below via the more permissive entry.
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      // Don't leak full URLs (including query strings) to third
      // parties on outbound links.
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Tell browsers we WILL always serve over HTTPS. Caddy/Nginx
      // does the redirect at the edge; this header tells the browser
      // to remember it for the next 6 months. includeSubDomains
      // intentionally omitted — customer custom domains may not be
      // SSL'd yet on first claim.
      { key: "Strict-Transport-Security", value: "max-age=15552000" },
      // Minimal feature-policy: deny camera/microphone/payment/etc
      // unless explicitly opted in. We're not a media app.
      {
        key: "Permissions-Policy",
        value:
          "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(self), usb=()",
      },
      // Cross-origin isolation: deny embedding our cookies/state in
      // a foreign window context that we didn't authorize.
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    ];

    return [
      // Global baseline — applies to every path that doesn't have
      // a more specific rule below.
      {
        source: "/:path*",
        headers: securityBaseline,
      },
      {
        // Allow third-party sites to iframe the booking flow. Without
        // these headers some browsers / proxies inject X-Frame-Options:
        // DENY by default and the embed renders blank. CSP frame-
        // ancestors is the modern equivalent and is honored by all
        // current browsers.
        source: "/embed/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *;" },
          { key: "X-Frame-Options", value: "ALLOWALL" },
          // Embed iframes shouldn't be referrer-leaked beyond the host.
          { key: "Referrer-Policy", value: "no-referrer-when-downgrade" },
        ],
      },
      {
        // Embed runtime is meant to be cached aggressively at the edge.
        // Versioned via the /v1/ path segment — bumping to /v2/ when
        // we ship breaking changes preserves backward compatibility.
        source: "/embed/v1.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
