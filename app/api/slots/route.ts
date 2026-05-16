import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { serviceStaff, services, users } from "@/db/schema";
import { getAvailableSlots } from "@/lib/availability";
import { errorResponse, HttpError } from "@/lib/auth";
import { assertResourcesShareTenant } from "@/lib/tenant";
import { slotsQuerySchema } from "@/lib/validation";

export async function GET(req: NextRequest) {
  try {
    const params = slotsQuerySchema.parse({
      serviceId: req.nextUrl.searchParams.get("serviceId"),
      staffUserId: req.nextUrl.searchParams.get("staffUserId"),
      date: req.nextUrl.searchParams.get("date"),
      timezone: req.nextUrl.searchParams.get("timezone"),
    });

    // Resolve both resources and verify they belong to the same tenant
    // BEFORE handing off to the engine. The engine is tenant-agnostic
    // by design (it's pure scheduling math); this guard is the contract.
    const [service, staff] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, params.serviceId) }),
      db.query.users.findFirst({ where: eq(users.id, params.staffUserId) }),
    ]);

    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Service not found");
    }
    if (!staff) throw new HttpError(404, "Staff not found");

    assertResourcesShareTenant(service, staff);

    // Also require the staff to actually deliver this service.
    const link = await db.query.serviceStaff.findFirst({
      where: and(
        eq(serviceStaff.serviceId, service.id),
        eq(serviceStaff.userId, staff.id),
        eq(serviceStaff.tenantId, service.tenantId)
      ),
    });
    if (!link) throw new HttpError(404, "Staff does not deliver this service");

    const slots = await getAvailableSlots(params);

    // ─── Apply booking rules AFTER the engine — engine signature stays ──
    const now = Date.now();
    const minNoticeMs = (service.minNoticeMinutes ?? 0) * 60_000;
    const maxAdvanceMs = service.maxAdvanceDays ? service.maxAdvanceDays * 24 * 60 * 60_000 : null;
    const filtered = slots.filter((iso) => {
      const t = new Date(iso).getTime();
      if (t - now < minNoticeMs) return false;
      if (maxAdvanceMs !== null && t - now > maxAdvanceMs) return false;
      return true;
    });

    return NextResponse.json({ slots: filtered });
  } catch (err) {
    return errorResponse(err);
  }
}
