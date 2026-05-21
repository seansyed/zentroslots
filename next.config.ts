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
};

export default nextConfig;
