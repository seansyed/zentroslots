import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, locations } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { audit } from "@/lib/audit";

// Same validator shape as POST /api/locations. Kept in lock-step
// with that route's create schema so both surfaces enforce the
// identical column constraints.

const logoUrlSchema = z
  .string()
  .max(500)
  .refine(
    (v) => v.startsWith("/uploads/locations/") || /^https?:\/\//.test(v),
    { message: "logoUrl must be an https URL or a /uploads/locations/ path" },
  );

const locationTypeSchema = z.enum(["physical", "virtual", "hybrid"]);

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  address: z.string().max(500).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  locationType: locationTypeSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
  logoUrl: logoUrlSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());

    const existing = await db.query.locations.findFirst({
      where: and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Location not found");

    if (Object.keys(body).length === 0) {
      return NextResponse.json(existing);
    }

    const [row] = await db
      .update(locations)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)))
      .returning();

    audit({
      tenantId: admin.tenantId,
      action: "location.update",
      entityType: "location",
      entityId: row.id,
      actorUserId: admin.id,
      actorLabel: admin.name,
      metadata: { name: row.name, changes: Object.keys(body) },
    });

    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;

    const existing = await db.query.locations.findFirst({
      where: and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Location not found");

    // System-protected locations (migration 0037) cannot be deleted.
    // The Virtual Hub gets auto-spawned by ensureVirtualHub() and is
    // referenced by virtual-mode staff assignments — removing it
    // would orphan those rows. Operators who want to "remove" it
    // should instead set every staff member off virtual delivery.
    if (existing.isSystem) {
      throw new HttpError(
        409,
        "System locations cannot be deleted. The Virtual Hub is auto-managed by the platform.",
      );
    }

    // Soft-delete when any booking references the location. Hard-
    // delete only when there are zero references — keeps historical
    // bookings intact and preserves audit / reporting accuracy.
    const linked = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.tenantId, admin.tenantId), eq(bookings.locationId, id)))
      .limit(1);

    if (linked.length > 0) {
      await db
        .update(locations)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)));

      audit({
        tenantId: admin.tenantId,
        action: "location.archive",
        entityType: "location",
        entityId: id,
        actorUserId: admin.id,
        actorLabel: admin.name,
        metadata: { name: existing.name, reason: "bookings_referenced" },
      });

      return NextResponse.json({ ok: true, archived: true });
    }

    await db
      .delete(locations)
      .where(and(eq(locations.id, id), eq(locations.tenantId, admin.tenantId)));

    audit({
      tenantId: admin.tenantId,
      action: "location.delete",
      entityType: "location",
      entityId: id,
      actorUserId: admin.id,
      actorLabel: admin.name,
      metadata: { name: existing.name },
    });

    return NextResponse.json({ ok: true, deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
