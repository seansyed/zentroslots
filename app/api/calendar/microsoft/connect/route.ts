import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { authUrl } from "@/lib/calendar/microsoft";
import { isProviderEnabled, readEnabledIntegrations } from "@/lib/integrations";

// GET /api/calendar/microsoft/connect — Wave C
//
// Mirrors /api/calendar/google/connect but redirects to the Microsoft
// identity-platform consent screen. The `state` param round-trips the
// user id (verified server-side in the callback) so OAuth replay
// attacks can't pin a token to the wrong user.
//
// Roles: admin / manager / staff. Clients have no calendar of their
// own to wire up.
//
// Workspace gate (migration 0035): the `outlook` provider key in
// `tenants.enabled_integrations` controls whether NEW Microsoft
// connect attempts are allowed. Existing connections remain visible
// and the booking engine keeps honoring their busy events — disabling
// only blocks the create-new path.
export async function GET() {
  try {
    const user = await requireRole(["admin", "staff", "manager"]);

    const [row] = await db
      .select({ enabledIntegrations: tenants.enabledIntegrations })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId));
    const enabled = readEnabledIntegrations(row?.enabledIntegrations);
    if (!isProviderEnabled(enabled, "outlook")) {
      throw new HttpError(403, "Microsoft Outlook is disabled by your workspace admin");
    }

    return NextResponse.redirect(authUrl(user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
