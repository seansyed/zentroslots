import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import {
  PROVIDER_CATALOG,
  PROVIDER_IDS,
  integrationToggleSchema,
  isProviderEnabled,
  readEnabledIntegrations,
  type EnabledIntegrations,
  type ProviderId,
} from "@/lib/integrations";

// /api/tenant/integrations/providers — workspace-level provider
// enablement (migration 0035). Per-staff calendar connections live
// in calendarConnections + are surfaced through /api/calendar/* and
// /api/users/[id]/calendar-connections. This route only ENABLES
// providers globally; it never touches OAuth tokens.

export async function GET() {
  try {
    const caller = await requireUser();

    const [row] = await db
      .select({ enabledIntegrations: tenants.enabledIntegrations })
      .from(tenants)
      .where(eq(tenants.id, caller.tenantId));

    const enabled = readEnabledIntegrations(row?.enabledIntegrations);

    return NextResponse.json({
      providers: PROVIDER_IDS.map((id) => ({
        ...PROVIDER_CATALOG[id],
        enabled: isProviderEnabled(enabled, id),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = integrationToggleSchema.parse(await req.json());

    const [row] = await db
      .select({ enabledIntegrations: tenants.enabledIntegrations })
      .from(tenants)
      .where(eq(tenants.id, admin.tenantId));

    const current: EnabledIntegrations = readEnabledIntegrations(row?.enabledIntegrations);
    const id = body.provider as ProviderId;
    current[id] = {
      enabled: body.enabled,
      // Preserve the original enabledAt timestamp across toggles so
      // analytics can see when a tenant FIRST turned the provider
      // on — operationally useful for support traces.
      enabledAt: body.enabled
        ? current[id]?.enabledAt ?? new Date().toISOString()
        : current[id]?.enabledAt,
    };

    await db
      .update(tenants)
      .set({
        enabledIntegrations: current,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, admin.tenantId));

    return NextResponse.json({
      ok: true,
      providers: PROVIDER_IDS.map((p) => ({
        ...PROVIDER_CATALOG[p],
        enabled: isProviderEnabled(current, p),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
