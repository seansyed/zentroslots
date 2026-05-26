/**
 * GET /api/admin/security/permissions — permission + admin action stream.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchPermissionEvents } from "@/lib/admin-analytics/security";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 50;
    const cursor = url.searchParams.get("cursor");
    const page = await fetchPermissionEvents({ limit, cursor });
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
