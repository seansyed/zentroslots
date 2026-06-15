import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { authUrl } from "@/lib/calendar/microsoft";
import { isProviderEnabled, readEnabledIntegrations } from "@/lib/integrations";
import { mintCalendarMobileState } from "@/lib/calendar/oauth-mobile";

export const dynamic = "force-dynamic";

// GET /api/calendar/microsoft/connect/mobile
//
// Bearer-authenticated mobile entry point. Returns the Microsoft consent
// URL the app opens in the system browser, carrying a short-lived signed
// state that binds this user+tenant. Mirrors the Google mobile-connect
// route. Web connect (cookie-based redirect) is untouched.
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

    const state = await mintCalendarMobileState({
      userId: user.id,
      tenantId: user.tenantId,
      provider: "microsoft",
    });
    return NextResponse.json({ authUrl: authUrl(state) });
  } catch (err) {
    return errorResponse(err);
  }
}
