import type { MetadataRoute } from "next";

const APP_BASE_URL = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/u/"],
        disallow: ["/api/", "/dashboard/", "/admin/", "/cancel/", "/reschedule/"],
      },
    ],
    sitemap: `${APP_BASE_URL}/sitemap.xml`,
  };
}
