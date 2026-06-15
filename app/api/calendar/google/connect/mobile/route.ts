import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { authUrl } from "@/lib/calendar/google";
import { isProviderEnabled, readEnabledIntegrations } from "@/lib/integrations";
import { mintCalendarMobileState } from "@/lib/calendar/oauth-mobile";

export const dynamic = "force-dynamic";

// GET /api/calendar/google/connect/mobile
//
// Bearer-authenticated (the native app sends its session JWT as
// `Authorization: Bearer …`; getSession reads it). Returns the Google
// consent URL the app opens in the SYSTEM BROWSER. The `state` is a
// short-lived signed token binding this user+tenant so the (cookieless)
// callback can attribute the connection. No client secret or tokens ever
// reach the device. Web connect (cookie-based redirect) is untouched.
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

    const state = await mintCalendarMobileState({
      userId: user.id,
      tenantId: user.tenantId,
      provider: "google",
    });
    return NextResponse.json({ authUrl: authUrl(state) });
  } catch (err) {
    return errorResponse(err);
  }
}
