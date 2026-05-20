import { NextRequest, NextResponse } from "next/server";
import { and, asc, countDistinct, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, departments, serviceStaff, users } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected hex like #2563eb").nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
});

/**
 * GET /api/departments — list departments for the calling tenant
 * with per-department operational counts derived honestly from
 * existing tables. No new tables, no schema changes.
 *
 *   staffCount       — COUNT(users) WHERE departmentId = dept.id
 *   serviceCount     — DISTINCT COUNT(serviceStaff.serviceId) for
 *                      staff whose departmentId = dept.id
 *                      (services don't have a departmentId column —
 *                      they belong to a department transitively via
 *                      the staff that deliver them)
 *   bookingsLast30d  — COUNT(bookings) WHERE departmentId = dept.id
 *                      AND createdAt >= now() - 30 days
 *
 * Tenant-scoped via requireUser() and explicit tenantId predicates
 * on every clause.
 */
export async function GET() {
  try {
    const caller = await requireUser();

    const rows = await db
      .select()
      .from(departments)
      .where(eq(departments.tenantId, caller.tenantId))
      .orderBy(asc(departments.name));

    if (rows.length === 0) {
      return NextResponse.json([]);
    }

    const now = new Date();
    const last30dStart = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

    // Staff per department
    const staffCounts = await db
      .select({
        departmentId: users.departmentId,
        c: sql<number>`count(*)::int`,
      })
      .from(users)
      .where(and(eq(users.tenantId, caller.tenantId)))
      .groupBy(users.departmentId);

    // Services per department — service-staff pairs joined to user
    // department. We DISTINCT-count service ids per dept so a
    // service with two staff in the same dept still counts as 1.
    const serviceCounts = await db
      .select({
        departmentId: users.departmentId,
        c: countDistinct(serviceStaff.serviceId),
      })
      .from(serviceStaff)
      .innerJoin(users, eq(users.id, serviceStaff.userId))
      .where(eq(serviceStaff.tenantId, caller.tenantId))
      .groupBy(users.departmentId);

    // Bookings volume per department (last 30d)
    const bookingCounts = await db
      .select({
        departmentId: bookings.departmentId,
        c: sql<number>`count(*)::int`,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, caller.tenantId),
          gte(bookings.createdAt, last30dStart),
        ),
      )
      .groupBy(bookings.departmentId);

    const staffMap = new Map(staffCounts.map((r) => [r.departmentId, r.c]));
    const serviceMap = new Map(serviceCounts.map((r) => [r.departmentId, Number(r.c)]));
    const bookingMap = new Map(bookingCounts.map((r) => [r.departmentId, r.c]));

    return NextResponse.json(
      rows.map((r) => ({
        ...r,
        staffCount: Number(staffMap.get(r.id) ?? 0),
        serviceCount: Number(serviceMap.get(r.id) ?? 0),
        bookingsLast30d: Number(bookingMap.get(r.id) ?? 0),
      })),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = createSchema.parse(await req.json());

    const [row] = await db
      .insert(departments)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        color: body.color ?? null,
        description: body.description ?? null,
      })
      .returning();

    audit({
      tenantId: admin.tenantId,
      action: "department.create",
      entityType: "department",
      entityId: row.id,
      actorUserId: admin.id,
      actorLabel: admin.name,
      metadata: { name: row.name },
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
