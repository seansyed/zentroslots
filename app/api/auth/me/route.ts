import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/auth";
import { getTenantById } from "@/lib/tenant";
import { isGoogleConnected } from "@/lib/calendar/connections";

export async function GET() {
  try {
    const user = await requireUser();
    const tenant = await getTenantById(user.tenantId);

    // Wave A — source of truth migration. Previously this read the
    // plaintext `users.google_refresh_token` column, which we are
    // phasing out (migration 0044). The encrypted `calendar_connections`
    // table is now canonical; `isGoogleConnected` checks for an active
    // row there. We INTENTIONALLY don't merge the old flag — once
    // migration 0044 has run, every active user has a connection row,
    // and falling back would just re-introduce the plaintext dependency
    // we're removing.
    const googleConnected = await isGoogleConnected(user.id);

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      googleConnected,
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            active: tenant.active,
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
