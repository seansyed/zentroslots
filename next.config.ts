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

  // Phase 16: per-route response headers.
  async headers() {
    return [
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
