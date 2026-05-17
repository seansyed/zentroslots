import { NextRequest, NextResponse } from "next/server";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { availability, bookings, serviceStaff, services, users } from "@/db/schema";
import { errorResponse, HttpError, requireRole, requireUser } from "@/lib/auth";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  bio: z.string().max(2000).nullable().optional(),
  specialties: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  timezone: z.string().max(64).optional(),
  primaryLocationId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    const staff = await db.query.users.findFirst({
      where: and(eq(users.id, id), eq(users.tenantId, caller.tenantId), inArray(users.role, ["staff", "manager"])),
    });
    if (!staff) throw new HttpError(404, "Staff not found");

    const [assignedServices, weeklyRules, completed30, cancelled30, upcoming] = await Promise.all([
      db
        .select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes, color: services.color })
        .from(serviceStaff)
        .innerJoin(services, eq(services.id, serviceStaff.serviceId))
        .where(and(eq(serviceStaff.userId, id), eq(serviceStaff.tenantId, caller.tenantId))),
      db
        .select()
        .from(availability)
        .where(eq(availability.userId, id)),
      db
        .select({ n: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, caller.tenantId),
            eq(bookings.staffUserId, id),
            eq(bookings.status, "completed"),
            gte(bookings.startAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
          )
        ),
      db
        .select({ n: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, caller.tenantId),
            eq(bookings.staffUserId, id),
            eq(bookings.status, "cancelled"),
            gte(bookings.startAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
          )
        ),
      db
        .select({
          id: bookings.id,
          startAt: bookings.startAt,
          endAt: bookings.endAt,
          status: bookings.status,
          clientName: bookings.clientName,
          clientEmail: bookings.clientEmail,
          meetLink: bookings.meetLink,
          serviceName: services.name,
        })
        .from(bookings)
        .innerJoin(services, eq(services.id, bookings.serviceId))
        .where(
          and(
            eq(bookings.tenantId, caller.tenantId),
            eq(bookings.staffUserId, id),
            gte(bookings.startAt, new Date())
          )
        )
        .orderBy(bookings.startAt)
        .limit(10),
    ]);

    return NextResponse.json({
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        timezone: staff.timezone,
        avatarUrl: staff.avatarUrl,
        bio: staff.bio,
        specialties: staff.specialties,
        primaryLocationId: staff.primaryLocationId,
        departmentId: staff.departmentId,
        googleConnected: Boolean(staff.googleRefreshToken),
      },
      assignedServices,
      weeklyAvailability: weeklyRules,
      stats: {
        completed30d: Number(completed30[0]?.n ?? 0),
        cancelled30d: Number(cancelled30[0]?.n ?? 0),
      },
      upcoming,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());

    const staff = await db.query.users.findFirst({
      where: and(eq(users.id, id), eq(users.tenantId, admin.tenantId), inArray(users.role, ["staff", "manager"])),
    });
    if (!staff) throw new HttpError(404, "Staff not found");

    const { serviceIds, ...userFields } = body;

    if (Object.keys(userFields).length > 0) {
      await db
        .update(users)
        .set({ ...userFields, updatedAt: new Date() })
        .where(eq(users.id, id));
    }

    // Replace the service assignment set if provided. Tenant-scoped insert.
    if (serviceIds) {
      // Validate all services belong to tenant.
      const own = await db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId)));
      const ownIds = new Set(own.map((s) => s.id));
      for (const sid of serviceIds) {
        if (!ownIds.has(sid)) throw new HttpError(400, "Service not in workspace");
      }
      await db.transaction(async (tx) => {
        await tx
          .delete(serviceStaff)
          .where(and(eq(serviceStaff.userId, id), eq(serviceStaff.tenantId, admin.tenantId)));
        if (serviceIds.length > 0) {
          await tx.insert(serviceStaff).values(
            serviceIds.map((sid) => ({
              serviceId: sid,
              userId: id,
              tenantId: admin.tenantId,
            }))
          );
        }
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
