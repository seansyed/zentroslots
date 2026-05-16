import type { MetadataRoute } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";

const APP_BASE_URL = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${APP_BASE_URL}/`,         changeFrequency: "weekly",  priority: 1.0 },
    { url: `${APP_BASE_URL}/pricing`,  changeFrequency: "monthly", priority: 0.9 },
    { url: `${APP_BASE_URL}/features`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${APP_BASE_URL}/about`,    changeFrequency: "yearly",  priority: 0.5 },
  ];

  // Public tenant profiles. Cap at 5,000 — past that, build a proper
  // chunked sitemap.
  const rows = await db
    .select({ slug: tenants.slug, updatedAt: tenants.updatedAt })
    .from(tenants)
    .where(eq(tenants.active, true))
    .limit(5000);

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
