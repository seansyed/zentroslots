/**
 * GET /api/admin/system-health/feed — SA-3 Section D / SA-5 live feed.
 *
 * Query params:
 *   cursor    — ISO timestamp; rows older than this returned
 *   limit     — page size (default 50, capped 100)
 *   kinds     — comma-separated kind filter
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
    const cursor = url.searchParams.get("cursor");
    const limitStr = url.searchParams.get("limit");
    const kindsStr = url.searchParams.get("kinds");
    const limit = limitStr ? parseInt(limitStr, 10) : 50;
    const kinds = kindsStr ? kindsStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const page = await fetchActivityFeed({ cursor, limit, kinds });
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
