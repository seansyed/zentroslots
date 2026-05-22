import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  bookingOccurrences,
  bookingSeries,
  serviceStaff,
  services,
  tenants,
  users,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { assertCanCreateRecurringSeries } from "@/lib/billing/capabilities";
import { getPlan } from "@/lib/plans";
import { validateRecurrenceRuleString } from "@/lib/recurrence/validateRecurrence";

// GET /api/tenant/booking-series
//
// List all series for the caller-tenant. Tenant-isolated.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const statusFilter = req.nextUrl.searchParams.get("status");

    const conds = [eq(bookingSeries.tenantId, admin.tenantId)];
    if (statusFilter && ["active", "paused", "cancelled", "completed"].includes(statusFilter)) {
      conds.push(eq(bookingSeries.status, statusFilter));
    }

    const [rows, allServices, staffList] = await Promise.all([
      db
        .select({
          id: bookingSeries.id,
          serviceId: bookingSeries.serviceId,
          staffUserId: bookingSeries.staffUserId,
          customerName: bookingSeries.customerName,
          customerEmail: bookingSeries.customerEmail,
          recurrenceRule: bookingSeries.recurrenceRule,
          startLocal: bookingSeries.startLocal,
          timezone: bookingSeries.timezone,
          endDate: bookingSeries.endDate,
          occurrenceCount: bookingSeries.occurrenceCount,
          status: bookingSeries.status,
          lastMaterializedIndex: bookingSeries.lastMaterializedIndex,
          createdAt: bookingSeries.createdAt,
          updatedAt: bookingSeries.updatedAt,
          serviceName: services.name,
          staffName: users.name,
        })
        .from(bookingSeries)
        .leftJoin(services, eq(services.id, bookingSeries.serviceId))
        .leftJoin(users, eq(users.id, bookingSeries.staffUserId))
        .where(and(...conds))
        .orderBy(desc(bookingSeries.createdAt))
        .limit(200),
      db
        .select({ id: services.id, name: services.name })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)))
        .orderBy(asc(services.name)),
      db
        .select({ id: users.id, name: users.name, timezone: users.timezone })
        .from(users)
        .where(eq(users.tenantId, admin.tenantId))
        .orderBy(asc(users.name)),
    ]);

    return NextResponse.json({ series: rows, services: allServices, staff: staffList });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/tenant/booking-series — create a new series.
const createSchema = z.object({
  serviceId: z.string().uuid(),
  staffUserId: z.string().uuid(),
  customerName: z.string().min(1).max(120),
  customerEmail: z.string().email(),
  recurrenceRule: z.string().min(5),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "YYYY-MM-DDTHH:MM:SS"),
  timezone: z.string().default("UTC"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  occurrenceCount: z.number().int().positive().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = createSchema.parse(await req.json());

    // ── Plan gate (Phase 16K hardening) ──────────────────────────
    // Recurring scheduling is Pro+. Free tenants who already saved
    // a series before enforcement landed keep that row + the cron
    // continues to materialize it; NEW writes are blocked here with
    // a 402 carrying an honest upgrade message.
    const tenantRow = await db.query.tenants.findFirst({
      where: eq(tenants.id, admin.tenantId),
      columns: { currentPlan: true },
    });
    const plan = getPlan(tenantRow?.currentPlan);
    try {
      assertCanCreateRecurringSeries(plan);
    } catch (err) {
      // Audit the blocked attempt so admins see the upgrade-pathway
      // pressure honestly + ops can debug billing disputes.
      audit({
        tenantId: admin.tenantId,
        action: "billing.enforcement_denied",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "billing",
        metadata: { capability: "recurring_series", plan: plan.id },
        ipAddress: ipFromHeaders(req.headers),
      });
      throw err;
    }

    // Validate the recurrence rule.
    const ruleResult = validateRecurrenceRuleString(body.recurrenceRule);
    if (!ruleResult.ok) {
      throw new HttpError(400, `Recurrence rule: ${ruleResult.reason}`);
    }

    // Validate service belongs to tenant and the staff delivers it.
    const svc = await db.query.services.findFirst({
      where: and(eq(services.id, body.serviceId), eq(services.tenantId, admin.tenantId)),
    });
    if (!svc) throw new HttpError(404, "Service not found in workspace");

    const staffLink = await db.query.serviceStaff.findFirst({
      where: and(
        eq(serviceStaff.serviceId, body.serviceId),
        eq(serviceStaff.userId, body.staffUserId),
        eq(serviceStaff.tenantId, admin.tenantId)
      ),
    });
    if (!staffLink) throw new HttpError(404, "Staff doesn't deliver this service");

    const [row] = await db
      .insert(bookingSeries)
      .values({
        tenantId: admin.tenantId,
        serviceId: body.serviceId,
        staffUserId: body.staffUserId,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        recurrenceRule: body.recurrenceRule,
        startLocal: body.startLocal,
        timezone: body.timezone,
        endDate: body.endDate ?? null,
        occurrenceCount: body.occurrenceCount ?? null,
        notes: body.notes ?? null,
        status: "active",
      })
      .returning();

    audit({
      tenantId: admin.tenantId,
      action: "booking_series.create",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "booking_series",
      entityId: row.id,
      metadata: {
        serviceId: body.serviceId,
        staffUserId: body.staffUserId,
        rule: body.recurrenceRule,
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/tenant/booking-series — pause / resume / cancel a series.
const patchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["pause", "resume", "cancel"]),
});

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = patchSchema.parse(await req.json());

    const existing = await db.query.bookingSeries.findFirst({
      where: and(eq(bookingSeries.id, body.id), eq(bookingSeries.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Series not found");

    let nextStatus: string;
    if (body.action === "pause") nextStatus = "paused";
    else if (body.action === "resume") nextStatus = "active";
    else nextStatus = "cancelled";

    await db
      .update(bookingSeries)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(bookingSeries.id, existing.id));

    if (body.action === "cancel") {
      // Cancel any scheduled-but-not-yet-materialized occurrences. The
      // already-materialized bookings are LEFT ALONE — admins can
      // cancel them individually if they want (rule #14: never
      // corrupt existing bookings).
      await db
        .update(bookingOccurrences)
        .set({ status: "cancelled", failureReason: "series_cancelled" })
        .where(
          and(
            eq(bookingOccurrences.bookingSeriesId, existing.id),
            eq(bookingOccurrences.status, "scheduled")
          )
        );
    }

    audit({
      tenantId: admin.tenantId,
      action: `booking_series.${body.action}`,
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "booking_series",
      entityId: existing.id,
      metadata: { from: existing.status, to: nextStatus },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
