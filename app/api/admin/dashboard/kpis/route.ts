/**
 * GET /api/admin/dashboard/kpis — platform-wide KPI bundle.
 *
 * Super-admin only. Returns 16 cross-tenant KPIs in a single
 * response. Computed via lib/admin-analytics/kpis.ts with 90s
 * in-process caching.
 *
 * Why expose this as an API route vs. server-rendering?
 *   The dashboard server-renders the first paint, but auto-refresh
 *   (every 60s) hits this route from the client. Keeps the page
 *   navigation snappy + avoids a full server round-trip per tick.
 *
 * Response shape: KpiBundle (see lib/admin-analytics/kpis.ts).
 * Never throws — per-KPI failures land inside the bundle as
 * `error` fields rather than 500-ing the whole response.
 */

import { NextResponse } from "next/server";
import { computeAllKpis } from "@/lib/admin-analytics/kpis";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    // Allow ?fresh=1 to bypass the 90s cache for a manual refresh.
    // We don't parse the query here yet — the cache shim is already
    // memoized; if the dashboard later wants forced refresh, it can
    // pass { skipCache: true }.
    const bundle = await computeAllKpis();
    return NextResponse.json(bundle, {
      headers: {
        // Discourage stale CDN/browser caches at this layer — the
        // server-side 90s memo is the authoritative cache.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
