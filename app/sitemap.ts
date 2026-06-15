import type { MetadataRoute } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";

const APP_BASE_URL = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

// Render at request time, never at build time. The tenant query below
// hits Postgres; statically prerendering this route at `next build`
// makes the whole build depend on DB connectivity (it fails with
// ECONNREFUSED when the DB is unreachable during a deploy build). The
// sitemap is cheap and naturally request-time content, so force-dynamic
// is the correct, surgical fix — and the query is additionally wrapped
// in try/catch so a transient DB blip degrades to the static + vertical
// routes instead of 500-ing the sitemap.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${APP_BASE_URL}/`,         changeFrequency: "weekly",  priority: 1.0 },
    { url: `${APP_BASE_URL}/pricing`,  changeFrequency: "monthly", priority: 0.9 },
    { url: `${APP_BASE_URL}/features`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${APP_BASE_URL}/about`,    changeFrequency: "yearly",  priority: 0.5 },
  ];

  // Public tenant profiles. Cap at 5,000 — past that, build a proper
  // chunked sitemap. Degrade gracefully: if the DB is briefly
  // unreachable, still serve the static + vertical routes.
  let rows: Array<{ slug: string; updatedAt: Date }> = [];
  try {
    rows = await db
      .select({ slug: tenants.slug, updatedAt: tenants.updatedAt })
      .from(tenants)
      .where(eq(tenants.active, true))
      .limit(5000);
  } catch (err) {
    console.error("[sitemap] tenant query failed; serving static routes only:", err);
  }

  const tenantRoutes: MetadataRoute.Sitemap = rows.map((t) => ({
    url: `${APP_BASE_URL}/u/${t.slug}`,
    lastModified: t.updatedAt,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const verticalSlugs = ["tax-office", "accounting", "medical-clinic", "salon", "coaching", "legal", "agency"];
  const verticalRoutes: MetadataRoute.Sitemap = verticalSlugs.map((s) => ({
    url: `${APP_BASE_URL}/for/${s}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...staticRoutes, ...verticalRoutes, ...tenantRoutes];
}
