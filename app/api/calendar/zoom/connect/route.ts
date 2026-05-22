import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { authUrl } from "@/lib/calendar/zoom";
import { isProviderEnabled, readEnabledIntegrations } from "@/lib/integrations";

// GET /api/calendar/zoom/connect — Wave D
//
// Redirects the signed-in user to Zoom's OAuth consent screen. The
// `state` param round-trips the user id (verified server-side in the
// callback) so OAuth replay can't pin a token to the wrong user —
// same contract as the Google + Microsoft connect routes.
//
// Roles: admin / manager / staff. Clients don't host meetings.
//
// Workspace gate: the `zoom` provider key in `tenants.enabled_integrations`
// controls whether NEW Zoom connect attempts are allowed. Existing
// connections remain visible and continue producing Zoom meetings;
// disabling only blocks the create-new path. See lib/integrations.ts.
export async function GET() {
  try {
    const user = await requireRole(["admin", "staff", "manager"]);

    const [row] = await db
      .select({ enabledIntegrations: tenants.enabledIntegrations })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId));
    const enabled = readEnabledIntegrations(row?.enabledIntegrations);
    if (!isProviderEnabled(enabled, "zoom")) {
      throw new HttpError(403, "Zoom is disabled by your workspace admin");
    }

    return NextResponse.redirect(authUrl(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
