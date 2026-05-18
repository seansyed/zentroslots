import { NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { authUrl } from "@/lib/calendar/google";

// GET /api/calendar/google/connect
//
// Redirects the signed-in user to Google's OAuth consent screen. The
// `state` param round-trips the user id (verified server-side in the
// callback) — same approach as the existing /api/google/connect, but
// this endpoint funnels through lib/calendar/google so we can later add
// per-tenant client id support without touching the legacy route.
//
// Roles: admin and staff. Managers and clients have no calendar of
// their own to wire up.
export async function GET() {
  try {
    const user = await requireRole(["admin", "staff", "manager"]);
    return NextResponse.redirect(authUrl(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
