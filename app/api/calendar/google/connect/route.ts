import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { authUrl } from "@/lib/calendar/google";
import { isProviderEnabled, readEnabledIntegrations } from "@/lib/integrations";

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
//
// Workspace gate (migration 0035): if the tenant has explicitly
// disabled the Google Calendar integration, NEW connect attempts are
// rejected with 403. Existing connections remain visible and the
// booking engine keeps honoring their busy events — disabling only
// blocks the create-new path. See lib/integrations.ts.
export async function GET() {
  try {
    const user = await requireRole(["admin", "staff", "manager"]);

    const [row] = await db
      .select({ enabledIntegrations: tenants.enabledIntegrations })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId));
    const enabled = readEnabledIntegrations(row?.enabledIntegrations);
    if (!isProviderEnabled(enabled, "google_calendar")) {
      throw new HttpError(403, "Google Calendar is disabled by your workspace admin");
    }

    return NextResponse.redirect(authUrl(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
