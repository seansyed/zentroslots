import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, departments, services, users } from "@/db/schema";
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
 * existing tables. No new tables, no destructive schema changes.
 *
 *   staffCount             — COUNT(users) WHERE departmentId = dept.id
 *   serviceCount           — COUNT(services) WHERE departmentId = dept.id
 *                            (primary signal, migration 0032 column)
 *   assignedServiceNames   — up to 3 service names owned by this dept
 *                            (alphabetical) for the department card
 *                            preview chips
 *   bookingsLast30d        — COUNT(bookings) WHERE departmentId = dept.id
 *                            AND createdAt >= now() - 30 days
 *
 * Note: previously serviceCount was derived transitively (a service
 * "belonged to" a department if any of its staff did). After
 * migration 0032 the service has a direct `departmentId` column and
 * that is now the source of truth. Services still unassigned simply
 * don't count toward any department.
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

    // Services per department — primary ownership column from
    // migration 0032. We also pull each service name so the
    // department card can render assigned-service chips.
    const ownedServices = await db
      .select({
        departmentId: services.departmentId,
        name: services.name,
      })
      .from(services)
      .where(eq(services.tenantId, caller.tenantId));

    const serviceCountMap = new Map<string, number>();
    const serviceNameMap = new Map<string, string[]>();
    for (const s of ownedServices) {
      if (!s.departmentId) continue;
      serviceCountMap.set(s.departmentId, (serviceCountMap.get(s.departmentId) ?? 0) + 1);
      const list = serviceNameMap.get(s.departmentId) ?? [];
      list.push(s.name);
      serviceNameMap.set(s.departmentId, list);
    }
    for (const [, list] of serviceNameMap) {
      list.sort((a, b) => a.localeCompare(b));
    }

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
    const bookingMap = new Map(bookingCounts.map((r) => [r.departmentId, r.c]));

    return NextResponse.json(
      rows.map((r) => ({
        ...r,
        staffCount: Number(staffMap.get(r.id) ?? 0),
        serviceCount: Number(serviceCountMap.get(r.id) ?? 0),
        assignedServiceNames: (serviceNameMap.get(r.id) ?? []).slice(0, 3),
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
