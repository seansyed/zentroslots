import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { locations, staffLocationAssignments, users } from "@/db/schema";
import { errorResponse, HttpError, isManagerial, requireUser } from "@/lib/auth";
import {
  assertValidLocationAssignments,
  ensureVirtualHub,
  locationAssignmentsPutSchema,
  readDaysOfWeek,
  type DeliveryMode,
  type LocationType,
} from "@/lib/workforce-location";

// GET / PUT /api/staff/[id]/locations
//
// Per-staff location assignments (migration 0037 — the pivot the
// routing engine has been waiting for). One row per
// (staff, location), with optional day-of-week restriction and at
// most one isPrimary=true.
//
// Identity gate (matches /api/users/[id]/calendar-connections):
//   • Self read/write — always allowed
//   • Non-self — admin/manager in the same tenant only.
//     Cross-tenant always 404 (never disclose existence).
//
// Validation is delegated to lib/workforce-location's
// assertValidLocationAssignments() so the rule set stays in one
// place and the future bulk-assign UI can call the same checker.
//
// IMPORTANT (core invariant): this endpoint does NOT modify
// availability rules. Availability stays staff-owned; locations
// are a separate context layer the future routing-presence filter
// reads ABOVE slot generation. No booking-engine code paths touch
// this table today.

async function loadTargetStaff(
  callerTenantId: string,
  callerId: string,
  callerRole: string,
  targetId: string,
) {
  const target = await db.query.users.findFirst({
    where: and(eq(users.id, targetId), eq(users.tenantId, callerTenantId)),
  });
  if (!target) throw new HttpError(404, "Staff not found");
  if (target.role === "client") throw new HttpError(404, "Staff not found");

  if (callerId !== targetId && !isManagerial(callerRole as "admin" | "manager" | "staff" | "client")) {
    throw new HttpError(403, "Forbidden");
  }
  return target;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const target = await loadTargetStaff(caller.tenantId, caller.id, caller.role, id);

    const rows = await db
      .select({
        id: staffLocationAssignments.id,
        locationId: staffLocationAssignments.locationId,
        daysOfWeek: staffLocationAssignments.daysOfWeek,
        isPrimary: staffLocationAssignments.isPrimary,
        locationName: locations.name,
        locationType: locations.locationType,
        logoUrl: locations.logoUrl,
        isActive: locations.isActive,
        isSystem: locations.isSystem,
      })
      .from(staffLocationAssignments)
      .innerJoin(locations, eq(locations.id, staffLocationAssignments.locationId))
      .where(
        and(
          eq(staffLocationAssignments.staffId, target.id),
          eq(staffLocationAssignments.tenantId, caller.tenantId),
        ),
      );

    return NextResponse.json({
      deliveryMode: (target.deliveryMode ?? "hybrid") as DeliveryMode,
      assignments: rows.map((r) => ({
        id: r.id,
        locationId: r.locationId,
        locationName: r.locationName,
        locationType: (r.locationType ?? "physical") as LocationType,
        logoUrl: r.logoUrl ?? null,
        isActive: r.isActive,
        isSystem: r.isSystem,
        daysOfWeek: readDaysOfWeek(r.daysOfWeek),
        isPrimary: r.isPrimary,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const target = await loadTargetStaff(caller.tenantId, caller.id, caller.role, id);

    const body = locationAssignmentsPutSchema.parse(await req.json());

    const deliveryMode = (target.deliveryMode ?? "hybrid") as DeliveryMode;

    // Verify every location belongs to this tenant before touching
    // the pivot. Cross-tenant location_ids must never sneak in even
    // via admin role.
    let locationRows: Array<{
      id: string;
      locationType: string;
      isActive: boolean;
    }> = [];
    if (body.assignments.length > 0) {
      const ids = Array.from(new Set(body.assignments.map((a) => a.locationId)));
      const found = await db
        .select({
          id: locations.id,
          locationType: locations.locationType,
          isActive: locations.isActive,
        })
        .from(locations)
        .where(
          and(
            eq(locations.tenantId, caller.tenantId),
            inArray(locations.id, ids),
          ),
        );
      const foundIds = new Set(found.map((r) => r.id));
      for (const a of body.assignments) {
        if (!foundIds.has(a.locationId)) {
          throw new HttpError(400, "Location not in workspace");
        }
      }
      locationRows = found;
    }
    const typeById = new Map(
      locationRows.map((r) => [r.id, (r.locationType ?? "physical") as LocationType]),
    );

    // Run the Phase 10 validation rule-set. Throws with a
    // human-readable message on violation.
    assertValidLocationAssignments(
      deliveryMode,
      body.assignments.map((a) => ({
        locationId: a.locationId,
        locationType: typeById.get(a.locationId) ?? "physical",
        daysOfWeek: a.daysOfWeek,
        isPrimary: a.isPrimary,
      })),
    );

    // Virtual-only staff need a virtual surface attached. If the
    // submitted set doesn't include one, lazy-spawn the tenant's
    // Virtual Hub and prepend it as a non-primary any-day
    // assignment. Hybrid staff get the same convenience iff no
    // virtual surface is in the set AND no physical assignments
    // either (degenerate case).
    let augmentedAssignments = body.assignments.map((a) => ({
      locationId: a.locationId,
      daysOfWeek: a.daysOfWeek,
      isPrimary: a.isPrimary,
    }));

    if (deliveryMode === "virtual") {
      const hasVirtual = augmentedAssignments.some((a) => {
        const t = typeById.get(a.locationId);
        return t === "virtual" || t === "hybrid";
      });
      if (!hasVirtual) {
        const hub = await ensureVirtualHub(caller.tenantId);
        augmentedAssignments = [
          {
            locationId: hub.id,
            daysOfWeek: [],
            isPrimary: augmentedAssignments.every((a) => !a.isPrimary),
          },
          ...augmentedAssignments,
        ];
      }
    }

    // Transactional replace — mirrors PUT /api/availability so the
    // semantics stay familiar: send the full desired set, we replace
    // atomically. No partial updates / deltas.
    await db.transaction(async (tx) => {
      await tx
        .delete(staffLocationAssignments)
        .where(
          and(
            eq(staffLocationAssignments.staffId, target.id),
            eq(staffLocationAssignments.tenantId, caller.tenantId),
          ),
        );
      if (augmentedAssignments.length > 0) {
        await tx.insert(staffLocationAssignments).values(
          augmentedAssignments.map((a) => ({
            tenantId: caller.tenantId,
            staffId: target.id,
            locationId: a.locationId,
            daysOfWeek: a.daysOfWeek,
            isPrimary: a.isPrimary,
          })),
        );
      }
    });

    return NextResponse.json({ ok: true, count: augmentedAssignments.length });
  } catch (err) {
    return errorResponse(err);
  }
}
