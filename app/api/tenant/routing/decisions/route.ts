import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, bookings, services, users } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

/**
 * GET /api/tenant/routing/decisions
 *
 * Recent routing decisions, sourced from the audit_logs trail that
 * /api/bookings POST writes on every booking.create event. The route
 * already stores routingMode + routingReason in audit metadata — this
 * endpoint surfaces it for the operator console without a DB schema
 * change. Filter excludes "direct" (customer-picked) so the feed is
 * specifically the ENGINE's recent decisions.
 *
 * Admin/manager only.
 */
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);

    // Pull recent booking.create audit rows for this tenant.
    const rows = await db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        entityId: auditLogs.entityId,
        actorLabel: auditLogs.actorLabel,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, admin.tenantId),
          eq(auditLogs.action, "booking.create"),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);

    // Filter to rows that record an engine decision. The booking POST
    // writes routingMode "direct" for customer-picked staff — those
    // aren't routing decisions, so we drop them.
    type Meta = {
      routingMode?: string;
      routingReason?: string | null;
      staffId?: string;
      serviceId?: string;
      startAt?: string;
    };
    const engineRows = rows.filter((r) => {
      const m = (r.metadata as Meta) ?? {};
      return m.routingMode && m.routingMode !== "direct";
    });

    // Bulk-resolve service + staff names (single query each).
    const staffIds = Array.from(
      new Set(
        engineRows
          .map((r) => (r.metadata as Meta).staffId)
          .filter((x): x is string => Boolean(x)),
      ),
    );
    const serviceIds = Array.from(
      new Set(
        engineRows
          .map((r) => (r.metadata as Meta).serviceId)
          .filter((x): x is string => Boolean(x)),
      ),
    );

    const [staffRows, serviceRows] = await Promise.all([
      staffIds.length > 0
        ? db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, staffIds))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      serviceIds.length > 0
        ? db
            .select({ id: services.id, name: services.name })
            .from(services)
            .where(inArray(services.id, serviceIds))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const staffById = new Map(staffRows.map((s) => [s.id, s.name]));
    const serviceById = new Map(serviceRows.map((s) => [s.id, s.name]));

    // Resolve which bookings still exist (some may have been cancelled).
    const bookingIds = engineRows
      .map((r) => r.entityId)
      .filter((x): x is string => Boolean(x));
    const stillLiveStatusById = new Map<string, string>();
    if (bookingIds.length > 0) {
      const bookingRows = await db
        .select({ id: bookings.id, status: bookings.status })
        .from(bookings)
        .where(inArray(bookings.id, bookingIds));
      for (const b of bookingRows) stillLiveStatusById.set(b.id, b.status);
    }

    const decisions = engineRows.slice(0, 30).map((r) => {
      const m = (r.metadata as Meta) ?? {};
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        bookingId: r.entityId,
        bookingStatus: r.entityId ? stillLiveStatusById.get(r.entityId) ?? "deleted" : "deleted",
        clientLabel: r.actorLabel ?? null,
        serviceId: m.serviceId ?? null,
        serviceName: m.serviceId ? serviceById.get(m.serviceId) ?? null : null,
        staffId: m.staffId ?? null,
        staffName: m.staffId ? staffById.get(m.staffId) ?? null : null,
        startAt: m.startAt ?? null,
        routingMode: m.routingMode ?? null,
        routingReason: m.routingReason ?? null,
      };
    });

    return NextResponse.json({
      decisions,
      todayCount: engineRows.filter((r) => {
        const ms = r.createdAt.getTime();
        return Date.now() - ms < 24 * 60 * 60 * 1000;
      }).length,
      totalCount: engineRows.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
