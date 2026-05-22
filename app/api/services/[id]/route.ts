import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, departments, serviceStaff, services, tenants, users } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { canActivateService, getPlan } from "@/lib/plans";
import { serviceDeliveryModesSchema } from "@/lib/workforce-location";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(80).optional(),
  description: z.string().nullable().optional(),
  durationMinutes: z.number().int().min(5).max(8 * 60).optional(),
  price: z.number().int().min(0).optional(),
  bufferBefore: z.number().int().min(0).max(240).optional(),
  bufferAfter: z.number().int().min(0).max(240).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  isActive: z.union([z.number().int().min(0).max(1), z.boolean()]).optional(),
  // Wave A removed zoom + teams because both silently failed.
  // Wave C re-enabled teams — Microsoft Graph adapter creates Teams
  // online meetings as part of event creation. Zoom remains out
  // until a Zoom adapter ships.
  videoProvider: z.enum(["google_meet", "teams", "none"]).optional(),
  staffUserIds: z.array(z.string().uuid()).optional(),
  // Direct department ownership (migration 0032). Pass `null` to
  // clear the assignment, a uuid to assign, or omit to leave the
  // current value unchanged. Tenant-scoped validation below.
  departmentId: z.string().uuid().nullable().optional(),
  // Service delivery compatibility (migration 0037). jsonb array of
  // allowed modes. Default at the DB layer is `["virtual","in_person"]`
  // so existing services stay bookable in both modes. Future routing
  // filter intersects this with each staff's per-day location type
  // — never gates slot generation directly.
  deliveryModes: serviceDeliveryModesSchema.optional(),
});

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());

    const existing = await db.query.services.findFirst({
      where: and(eq(services.id, id), eq(services.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Service not found");

    // Validate department assignment (if changing) belongs to this
    // tenant. `null` clears ownership; `undefined` leaves it alone.
    if (body.departmentId !== undefined && body.departmentId !== null) {
      const dept = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, body.departmentId), eq(departments.tenantId, admin.tenantId)));
      if (dept.length === 0) {
        throw new HttpError(403, "Department not in this workspace");
      }
    }

    const { staffUserIds, isActive, ...rest } = body;
    const updates: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    const nextIsActive =
      typeof isActive === "boolean" ? (isActive ? 1 : 0)
      : typeof isActive === "number" ? isActive
      : undefined;
    if (nextIsActive !== undefined) updates.isActive = nextIsActive;

    // ── Plan cap enforcement on reactivation (Phase 18) ────────
    // If the operator is flipping a previously-inactive service
    // back to active, the active-services count goes up by 1.
    // Block when the new count would exceed the plan cap. Same
    // shared helper as POST /api/services so UI + API never drift.
    if (nextIsActive === 1 && existing.isActive !== 1) {
      const [tenantRow] = await db
        .select({ currentPlan: tenants.currentPlan })
        .from(tenants)
        .where(eq(tenants.id, admin.tenantId));
      const plan = getPlan(tenantRow?.currentPlan ?? null);
      const [activeCountRow] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)));
      const activeCount = Number(activeCountRow?.c ?? 0);
      const capability = canActivateService(plan, activeCount);
      if (!capability.allowed) {
        throw new HttpError(403, capability.reason ?? "Plan limit reached");
      }
    }

    if (Object.keys(updates).length > 1) {
      await db
        .update(services)
        .set(updates)
        .where(and(eq(services.id, id), eq(services.tenantId, admin.tenantId)));
    }

    if (staffUserIds) {
      // Validate staff in tenant
      const own = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, admin.tenantId), inArray(users.id, staffUserIds)));
      if (own.length !== staffUserIds.length) throw new HttpError(400, "Staff not in workspace");
      await db.transaction(async (tx) => {
        await tx
          .delete(serviceStaff)
          .where(and(eq(serviceStaff.serviceId, id), eq(serviceStaff.tenantId, admin.tenantId)));
        if (staffUserIds.length > 0) {
          await tx.insert(serviceStaff).values(
            staffUserIds.map((u) => ({ serviceId: id, userId: u, tenantId: admin.tenantId }))
          );
        }
      });
    }

    const fresh = await db.query.services.findFirst({
      where: and(eq(services.id, id), eq(services.tenantId, admin.tenantId)),
    });
    return NextResponse.json(fresh);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;

    const existing = await db.query.services.findFirst({
      where: and(eq(services.id, id), eq(services.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Service not found");

    // Soft-delete if any bookings exist; hard-delete only when safe.
    const linked = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.tenantId, admin.tenantId), eq(bookings.serviceId, id)))
      .limit(1);

    if (linked.length > 0) {
      await db
        .update(services)
        .set({ isActive: 0, updatedAt: new Date() })
        .where(eq(services.id, id));
      return NextResponse.json({ ok: true, archived: true });
    }

    await db.delete(services).where(eq(services.id, id));
    return NextResponse.json({ ok: true, deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
