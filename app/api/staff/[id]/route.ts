import { NextRequest, NextResponse } from "next/server";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  availability,
  bookings,
  locations,
  serviceStaff,
  services,
  staffLocationAssignments,
  users,
} from "@/db/schema";
import { errorResponse, HttpError, requireRole, requireUser } from "@/lib/auth";
import {
  deliveryModeSchema,
  readDaysOfWeek,
  type DeliveryMode,
  type LocationType,
} from "@/lib/workforce-location";
import { isGoogleConnected, isMicrosoftConnected } from "@/lib/calendar/connections";

// Accept either a full http(s) URL OR a local upload path served by
// Next out of /public — see /api/users/[id]/avatar (multipart upload
// strategy added in migration 0033 phase). z.string().url() would
// reject local paths like "/uploads/avatars/abc.jpg", which we now
// produce ourselves.
const avatarUrlSchema = z
  .string()
  .max(500)
  .refine(
    (v) => v.startsWith("/uploads/avatars/") || /^https?:\/\//.test(v),
    { message: "avatarUrl must be an https URL or a /uploads/avatars/ path" },
  );

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  bio: z.string().max(2000).nullable().optional(),
  specialties: z.string().max(500).nullable().optional(),
  avatarUrl: avatarUrlSchema.nullable().optional(),
  timezone: z.string().max(64).optional(),
  primaryLocationId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
  // Public-facing identity columns (migration 0033). Both nullable
  // — render paths fall back to `name` / omit title when null.
  publicDisplayName: z.string().max(120).nullable().optional(),
  publicTitle: z.string().max(120).nullable().optional(),
  // Workforce delivery mode (migration 0037). Changing this here
  // performs a column update only — the actual location pivot
  // lives at PUT /api/staff/[id]/locations. Switching to
  // "virtual" without any virtual assignment is fine; the pivot
  // PUT will lazy-spawn the Virtual Hub on next save.
  deliveryMode: deliveryModeSchema.optional(),
});

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    const staff = await db.query.users.findFirst({
      // Workforce = admin + manager + staff. Admins are first-class
      // workforce members (see /api/staff GET, lib/billing/seats,
      // lib/quotas). Only `client` rows are excluded from this
      // workforce lookup.
      where: and(eq(users.id, id), eq(users.tenantId, caller.tenantId), inArray(users.role, ["admin", "manager", "staff"])),
    });
    if (!staff) throw new HttpError(404, "Staff not found");

    // Wave A — `googleConnected` flag now reads from the encrypted
    // `calendar_connections` table, not the legacy plaintext column.
    // Run it in parallel with the existing five queries to avoid
    // adding a serial round-trip.
    const [assignedServices, weeklyRules, completed30, cancelled30, upcoming, locationRows, googleConnected, microsoftConnected] = await Promise.all([
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
      // Location pivot (migration 0037). The Profile tab's
      // "Location assignments" + "Weekly presence" sections read
      // from this. Slot generation never does.
      db
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
            eq(staffLocationAssignments.staffId, id),
            eq(staffLocationAssignments.tenantId, caller.tenantId),
          ),
        ),
      // Wave A — encrypted-connection-table source of truth for the
      // Google-connected flag. See lib/calendar/connections.ts.
      isGoogleConnected(id),
      // Wave C — same source of truth, Microsoft side. Additive — old
      // consumers reading only `googleConnected` continue to behave
      // identically; new consumers can OR the two flags to render an
      // accurate "any calendar connected" signal.
      isMicrosoftConnected(id),
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
        // Public-facing identity (migration 0033)
        publicDisplayName: staff.publicDisplayName,
        publicTitle: staff.publicTitle,
        primaryLocationId: staff.primaryLocationId,
        departmentId: staff.departmentId,
        googleConnected,
        microsoftConnected,
        // Workforce delivery mode (migration 0037). Defaults to
        // 'hybrid' for any staff predating the migration — most
        // permissive setting, no observable booking change.
        deliveryMode: (staff.deliveryMode ?? "hybrid") as DeliveryMode,
      },
      assignedServices,
      weeklyAvailability: weeklyRules,
      locationAssignments: locationRows.map((r) => ({
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
      // Workforce = admin + manager + staff (matches GET above).
      where: and(eq(users.id, id), eq(users.tenantId, admin.tenantId), inArray(users.role, ["admin", "manager", "staff"])),
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
