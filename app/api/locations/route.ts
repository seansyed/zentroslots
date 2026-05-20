import { NextRequest, NextResponse } from "next/server";
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, locations, users } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertCanAddLocation } from "@/lib/quotas";

// Path validator shared with the avatar upload endpoint — accepts
// either a full http(s) URL or a /uploads/ path written by the
// location-logo upload route. z.string().url() would reject our
// local paths, so we hand-roll the check.
const logoUrlSchema = z
  .string()
  .max(500)
  .refine(
    (v) => v.startsWith("/uploads/locations/") || /^https?:\/\//.test(v),
    { message: "logoUrl must be an https URL or a /uploads/locations/ path" },
  );

// `location_type` is a varchar in DB; Zod is the only gatekeeper.
// Adding a new type later (e.g. "popup", "satellite") is a one-line
// change here + UI catalog — no migration.
const locationTypeSchema = z.enum(["physical", "virtual", "hybrid"]);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  address: z.string().max(500).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  // Phase 15A identity additions.
  locationType: locationTypeSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
  logoUrl: logoUrlSchema.nullable().optional(),
});

export async function GET() {
  try {
    const caller = await requireUser();

    // Base location rows.
    const rows = await db
      .select()
      .from(locations)
      .where(eq(locations.tenantId, caller.tenantId))
      .orderBy(asc(locations.name));

    if (rows.length === 0) return NextResponse.json([]);

    const locationIds = rows.map((r) => r.id);

    // Operational counters per location (Phase 15A intelligence chips).
    // All three queries are tenant-scoped and grouped by locationId.
    const last30dStart = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    // Note: services don't currently have a direct `location_id`
    // column (services are routed to locations transitively through
    // booking-rules + staff primary location). We honest-zero the
    // serviceCount until a future migration adds the column. Staff
    // and booking counts ARE direct columns and are real.
    const [staffCounts, bookingCounts] = await Promise.all([
      db
        .select({
          locationId: users.primaryLocationId,
          c: sql<number>`count(*)::int`,
        })
        .from(users)
        .where(
          and(
            eq(users.tenantId, caller.tenantId),
            inArray(users.role, ["admin", "manager", "staff"]),
            inArray(users.primaryLocationId, locationIds),
          ),
        )
        .groupBy(users.primaryLocationId),
      db
        .select({
          locationId: bookings.locationId,
          c: sql<number>`count(*)::int`,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, caller.tenantId),
            inArray(bookings.locationId, locationIds),
            gte(bookings.createdAt, last30dStart),
          ),
        )
        .groupBy(bookings.locationId),
    ]);

    const staffMap = new Map(staffCounts.map((r) => [r.locationId, Number(r.c)]));
    const bookingMap = new Map(bookingCounts.map((r) => [r.locationId, Number(r.c)]));

    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        address: r.address,
        timezone: r.timezone,
        phone: r.phone,
        email: r.email,
        isActive: r.isActive,
        // Phase 15A identity fields
        locationType: r.locationType,
        logoUrl: r.logoUrl,
        // notes is admin-only; included in the authenticated GET so
        // the edit drawer can pre-fill, but the public booking
        // surfaces never select this column.
        notes: r.notes,
        // Operational counters. serviceCount stays 0 until a
        // future migration adds services.location_id — we never
        // fabricate a number when the column doesn't exist.
        staffCount: staffMap.get(r.id) ?? 0,
        serviceCount: 0,
        bookingsLast30d: bookingMap.get(r.id) ?? 0,
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

    // Plan gating (Phase 15A). Throws 402 with a clear upgrade
    // message when over cap. Free-tier tenants with grandfathered
    // rows above the new cap can read + edit them but cannot create
    // new ones.
    await assertCanAddLocation(admin.tenantId);

    const [row] = await db
      .insert(locations)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        address: body.address ?? null,
        timezone: body.timezone ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        locationType: body.locationType ?? "physical",
        notes: body.notes ?? null,
        logoUrl: body.logoUrl ?? null,
      })
      .returning();

    audit({
      tenantId: admin.tenantId,
      action: "location.create",
      entityType: "location",
      entityId: row.id,
      actorUserId: admin.id,
      actorLabel: admin.name,
      metadata: { name: row.name, type: row.locationType },
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// `count` is only imported above to enable future health checks
// referencing the locations table — keep the import surface stable.
void count;
