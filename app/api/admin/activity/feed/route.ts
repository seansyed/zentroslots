/**
 * GET /api/admin/activity/feed — SA-5 activity stream.
 *
 * Query params:
 *   cursor        ISO timestamp; rows older than this returned
 *   limit         page size (default 50, capped 100)
 *   kinds         comma-separated kind filter
 *   tenantId      restrict to one tenant
 *   since         ISO inclusive window start
 *   until         ISO exclusive window end
 *   q             full-text search (summary + raw action)
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchActivityFeed } from "@/lib/admin-analytics/activity";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const url = new URL(req.url);
    const sp = url.searchParams;
    const page = await fetchActivityFeed({
      cursor: sp.get("cursor"),
      limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : 50,
      kinds: sp.get("kinds")?.split(",").map((s) => s.trim()).filter(Boolean) ?? undefined,
      tenantId: sp.get("tenantId"),
      since: sp.get("since"),
      until: sp.get("until"),
      search: sp.get("q"),
    });
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
