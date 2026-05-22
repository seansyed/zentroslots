import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookingRules, services, tenants } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { assertCanWriteBookingRule } from "@/lib/billing/capabilities";
import { getPlan } from "@/lib/plans";

// GET /api/tenant/booking-rules
//
// Tenant-isolated. Returns:
//   - tenantDefault (null if not set)
//   - serviceRules array
//   - services list (for the scope picker)
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);

    const [rules, allServices] = await Promise.all([
      db
        .select()
        .from(bookingRules)
        .where(eq(bookingRules.tenantId, admin.tenantId))
        .orderBy(asc(bookingRules.createdAt)),
      db
        .select({ id: services.id, name: services.name, slug: services.slug })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)))
        .orderBy(asc(services.name)),
    ]);

    return NextResponse.json({
      tenantDefault: rules.find((r) => r.serviceId === null && r.locationId === null) ?? null,
      serviceRules: rules.filter((r) => r.serviceId !== null),
      services: allServices,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/tenant/booking-rules
//
// Upserts a rule by scope: tenant default (no serviceId) or service-specific.
const putSchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().default(true),
  minNoticeMinutes: z.number().int().nonnegative().nullable().optional(),
  maxAdvanceDays: z.number().int().nonnegative().nullable().optional(),
  maxBookingsPerDay: z.number().int().nonnegative().nullable().optional(),
  maxBookingsPerCustomerPerDay: z.number().int().nonnegative().nullable().optional(),
  maxConcurrentBookings: z.number().int().nonnegative().nullable().optional(),
  cooldownMinutes: z.number().int().nonnegative().nullable().optional(),
  // Each item validated as a YYYY-MM-DD date string.
  blackoutDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")).default([]),
  requireBusinessHours: z.boolean().default(false),
  // {0..6: {start: "HH:MM", end: "HH:MM"}}
  businessHours: z
    .record(
      z.string().regex(/^[0-6]$/, "day of week 0..6"),
      z.object({
        start: z.string().regex(/^\d{2}:\d{2}$/, "HH:MM"),
        end: z.string().regex(/^\d{2}:\d{2}$/, "HH:MM"),
      })
    )
    .default({}),
});

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = putSchema.parse(await req.json());
    const serviceId = body.serviceId ?? null;

    // ── Plan gate (Phase 16K hardening) ──────────────────────────
    // Booking rules are Pro+. Existing rules continue to enforce —
    // this blocks NEW writes only.
    const tenantRow = await db.query.tenants.findFirst({
      where: eq(tenants.id, admin.tenantId),
      columns: { currentPlan: true },
    });
    const plan = getPlan(tenantRow?.currentPlan);
    try {
      assertCanWriteBookingRule(plan);
    } catch (err) {
      audit({
        tenantId: admin.tenantId,
        action: "billing.enforcement_denied",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "billing",
        metadata: { capability: "booking_rules", plan: plan.id, serviceId },
        ipAddress: ipFromHeaders(req.headers),
      });
      throw err;
    }

    if (serviceId) {
      const svc = await db.query.services.findFirst({
        where: and(eq(services.id, serviceId), eq(services.tenantId, admin.tenantId)),
      });
      if (!svc) throw new HttpError(404, "Service not found in workspace");
    }

    const existing = await db.query.bookingRules.findFirst({
      where: and(
        eq(bookingRules.tenantId, admin.tenantId),
        serviceId
          ? eq(bookingRules.serviceId, serviceId)
          : isNull(bookingRules.serviceId),
        isNull(bookingRules.locationId)
      ),
    });

    const values = {
      enabled: body.enabled,
      minNoticeMinutes: body.minNoticeMinutes ?? null,
      maxAdvanceDays: body.maxAdvanceDays ?? null,
      maxBookingsPerDay: body.maxBookingsPerDay ?? null,
      maxBookingsPerCustomerPerDay: body.maxBookingsPerCustomerPerDay ?? null,
      maxConcurrentBookings: body.maxConcurrentBookings ?? null,
      cooldownMinutes: body.cooldownMinutes ?? null,
      blackoutDates: body.blackoutDates,
      requireBusinessHours: body.requireBusinessHours,
      businessHours: body.businessHours,
      updatedAt: new Date(),
    };

    let id: string;
    if (existing) {
      await db.update(bookingRules).set(values).where(eq(bookingRules.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await db
        .insert(bookingRules)
        .values({
          tenantId: admin.tenantId,
          serviceId,
          locationId: null,
          ...values,
        })
        .returning({ id: bookingRules.id });
      id = row.id;
    }

    audit({
      tenantId: admin.tenantId,
      action: serviceId ? "booking_rules.service_update" : "booking_rules.tenant_default_update",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "booking_rule",
      entityId: id,
      metadata: {
        serviceId,
        enabled: body.enabled,
        hasBlackouts: body.blackoutDates.length > 0,
        hasBusinessHours: Object.keys(body.businessHours).length > 0,
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing id");

    const existing = await db.query.bookingRules.findFirst({
      where: and(eq(bookingRules.id, id), eq(bookingRules.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Rule not found");

    await db.delete(bookingRules).where(eq(bookingRules.id, id));

    audit({
      tenantId: admin.tenantId,
      action: "booking_rules.delete",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "booking_rule",
      entityId: id,
      metadata: { serviceId: existing.serviceId },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
