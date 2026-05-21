import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  availabilityOverrides,
  calendarConnections,
  serviceStaff,
  services,
  users,
} from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

/**
 * GET /api/tenant/routing/eligibility-warnings
 *
 * Surfaces real backend states that would cause the routing engine to
 * skip staff. Powers the "Eligibility safeguards" section on the
 * Routing Intelligence Center. Every warning is observable today; no
 * invented diagnostics.
 *
 *   - servicesWithNoStaff:        services that have zero rows in
 *                                  service_staff. These will return
 *                                  empty pools and the engine will
 *                                  fail with no_available_staff.
 *   - calendarsWithErrors:        calendar_connections rows where
 *                                  last_error is set. The engine still
 *                                  trusts the cached freebusy until
 *                                  OAuth recovers.
 *   - staffOnPtoToday:            staff with an unavailable=true
 *                                  override row for today.
 *   - staffWithoutCalendar:       staff that exist but have no active
 *                                  calendar connection. Their external
 *                                  busy time is invisible to routing.
 */
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const tenantId = admin.tenantId;
    const today = new Date().toISOString().slice(0, 10);

    const [
      activeServices,
      pairRows,
      staffRows,
      calRows,
      ptoRows,
    ] = await Promise.all([
      db
        .select({ id: services.id, name: services.name })
        .from(services)
        .where(and(eq(services.tenantId, tenantId), eq(services.isActive, 1))),
      db
        .select({ serviceId: serviceStaff.serviceId, userId: serviceStaff.userId })
        .from(serviceStaff)
        .where(eq(serviceStaff.tenantId, tenantId)),
      db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(eq(users.tenantId, tenantId)),
      db
        .select({
          id: calendarConnections.id,
          userId: calendarConnections.userId,
          provider: calendarConnections.provider,
          status: calendarConnections.status,
          lastError: calendarConnections.lastError,
          lastErrorAt: calendarConnections.lastErrorAt,
        })
        .from(calendarConnections)
        .where(eq(calendarConnections.tenantId, tenantId)),
      db
        .select({
          userId: availabilityOverrides.userId,
          date: availabilityOverrides.date,
          unavailable: availabilityOverrides.unavailable,
        })
        .from(availabilityOverrides)
        .where(
          and(
            eq(availabilityOverrides.date, today),
            eq(availabilityOverrides.unavailable, true),
          ),
        ),
    ]);

    // Filter PTO rows to this tenant's staff only (overrides table
    // doesn't carry tenantId; users does).
    const staffNonClient = staffRows.filter((s) => s.role !== "client");
    const tenantUserIds = new Set(staffNonClient.map((s) => s.id));
    const tenantPto = ptoRows.filter((r) => tenantUserIds.has(r.userId));
    const userNameById = new Map(staffRows.map((s) => [s.id, s.name]));

    // services with no eligible staff
    const staffByService = new Map<string, string[]>();
    for (const p of pairRows) {
      const arr = staffByService.get(p.serviceId) ?? [];
      arr.push(p.userId);
      staffByService.set(p.serviceId, arr);
    }
    const servicesWithNoStaff = activeServices
      .filter((s) => (staffByService.get(s.id)?.length ?? 0) === 0)
      .map((s) => ({ id: s.id, name: s.name }));

    // calendar connections with errors (active + last_error set)
    const calendarsWithErrors = calRows
      .filter((c) => c.lastError && c.status !== "deleted")
      .map((c) => ({
        connectionId: c.id,
        userId: c.userId,
        userName: userNameById.get(c.userId) ?? "(unknown)",
        provider: c.provider,
        lastError: c.lastError,
        lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
      }));

    // staff that exist with no active calendar at all
    const activeConnByUser = new Map<string, boolean>();
    for (const c of calRows) {
      if (c.status === "active") activeConnByUser.set(c.userId, true);
    }
    const staffWithoutCalendar = staffNonClient
      .filter((s) => !activeConnByUser.has(s.id))
      .map((s) => ({ userId: s.id, userName: s.name }));

    // staff on PTO today
    const staffOnPtoToday = tenantPto.map((r) => ({
      userId: r.userId,
      userName: userNameById.get(r.userId) ?? "(unknown)",
      date: r.date,
    }));

    return NextResponse.json({
      servicesWithNoStaff,
      calendarsWithErrors,
      staffOnPtoToday,
      staffWithoutCalendar,
      counts: {
        servicesWithNoStaff: servicesWithNoStaff.length,
        calendarsWithErrors: calendarsWithErrors.length,
        staffOnPtoToday: staffOnPtoToday.length,
        staffWithoutCalendar: staffWithoutCalendar.length,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

