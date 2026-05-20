import { redirect } from "next/navigation";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  availabilityOverrides,
  locations,
  serviceStaff,
  staffLocationAssignments,
  tenants,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import ExceptionsClient, {
  type ExceptionRow,
  type WorkforceLite,
} from "@/components/dashboard/ExceptionsClient";
import { readDaysOfWeek } from "@/lib/workforce-location";

// Workforce Exceptions & Coverage Center (Phase 16D).
//
// This page used to be a tiny per-user override editor
// (OverridesManager). It now presents the full exception stack:
//
//   1. Weekly rules        — staff availability + workspace fallback
//   2. Overrides           — date-scoped exceptions (this page)
//   3. Resolved availability — resolver output (engine-side)
//   4. Booking coverage    — surfaces eligible for booking
//
// Storage is UNCHANGED — availability_overrides remains per-user.
// Workspace-level and Location-level scopes are scaffolded honestly
// as "Coming soon" because the data model doesn't yet support
// tenant_holidays / location_closures. We never fabricate that
// functionality.
//
// Engine, resolver, slot generation, and existing APIs are
// untouched. Existing POST/DELETE/bulk endpoints are reused.

export const dynamic = "force-dynamic";

export default async function OverridesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard/login");

  const isAdmin = user.role === "admin" || user.role === "manager";
  const today = new Date().toISOString().slice(0, 10);
  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);

  // Workforce — admin sees everyone; staff sees only themselves.
  const workforceRows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      timezone: users.timezone,
      avatarUrl: users.avatarUrl,
      deliveryMode: users.deliveryMode,
      publicDisplayName: users.publicDisplayName,
      publicTitle: users.publicTitle,
    })
    .from(users)
    .where(
      and(
        eq(users.tenantId, user.tenantId),
        inArray(users.role, ["admin", "manager", "staff"]),
      ),
    );
  const allWorkforceIds = workforceRows.map((u) => u.id);

  // Restrict the exception fetch to the caller for non-admins. The
  // POST/DELETE endpoints already enforce this on the server, but
  // we never surface other people's overrides in the UI either.
  const targetUserIds = isAdmin ? allWorkforceIds : [user.id];

  const overrideRowsRaw = targetUserIds.length > 0
    ? await db
        .select({
          id: availabilityOverrides.id,
          userId: availabilityOverrides.userId,
          date: availabilityOverrides.date,
          unavailable: availabilityOverrides.unavailable,
          startTime: availabilityOverrides.startTime,
          endTime: availabilityOverrides.endTime,
          reason: availabilityOverrides.reason,
          createdAt: availabilityOverrides.createdAt,
        })
        .from(availabilityOverrides)
        .where(
          and(
            eq(availabilityOverrides.tenantId, user.tenantId),
            inArray(availabilityOverrides.userId, targetUserIds),
            gte(availabilityOverrides.date, today),
          ),
        )
    : [];

  // Per-staff service count + location assignments — drive the
  // "Coverage impact" section on each exception card. Honest data:
  // we know how many services they're assigned to + which
  // locations are affected; we DON'T fabricate slot counts.
  let serviceCounts = new Map<string, number>();
  let locationsByStaff = new Map<string, Array<{ id: string; name: string; type: "physical" | "virtual" | "hybrid" }>>();
  if (allWorkforceIds.length > 0) {
    const svcCountsRows = await db
      .select({
        userId: serviceStaff.userId,
        c: sql<number>`count(*)::int`,
      })
      .from(serviceStaff)
      .where(
        and(
          eq(serviceStaff.tenantId, user.tenantId),
          inArray(serviceStaff.userId, allWorkforceIds),
        ),
      )
      .groupBy(serviceStaff.userId);
    serviceCounts = new Map(svcCountsRows.map((r) => [r.userId, Number(r.c)]));

    const locRows = await db
      .select({
        staffId: staffLocationAssignments.staffId,
        locationId: staffLocationAssignments.locationId,
        locationName: locations.name,
        locationType: locations.locationType,
        daysOfWeek: staffLocationAssignments.daysOfWeek,
        isPrimary: staffLocationAssignments.isPrimary,
      })
      .from(staffLocationAssignments)
      .innerJoin(locations, eq(locations.id, staffLocationAssignments.locationId))
      .where(
        and(
          eq(staffLocationAssignments.tenantId, user.tenantId),
          inArray(staffLocationAssignments.staffId, allWorkforceIds),
        ),
      );
    for (const r of locRows) {
      const list = locationsByStaff.get(r.staffId) ?? [];
      list.push({
        id: r.locationId,
        name: r.locationName,
        type: ((r.locationType ?? "physical") as "physical" | "virtual" | "hybrid"),
      });
      locationsByStaff.set(r.staffId, list);
      // daysOfWeek read just to validate the column shape — not
      // surfaced on the override card itself.
      readDaysOfWeek(r.daysOfWeek);
    }
  }

  // Compose the exception timeline rows the client will render.
  const workforceById = new Map(workforceRows.map((u) => [u.id, u]));
  const exceptions: ExceptionRow[] = overrideRowsRaw.map((o) => {
    const w = workforceById.get(o.userId);
    return {
      id: o.id,
      userId: o.userId,
      staffName: w?.publicDisplayName ?? w?.name ?? "Unknown",
      staffRole: (w?.role ?? "staff") as "admin" | "manager" | "staff",
      staffTitle: w?.publicTitle ?? null,
      staffAvatarUrl: w?.avatarUrl ?? null,
      staffTimezone: w?.timezone ?? "UTC",
      deliveryMode: ((w?.deliveryMode ?? "hybrid") as "in_person" | "virtual" | "hybrid"),
      date: o.date,
      unavailable: o.unavailable,
      startTime: o.startTime ? o.startTime.slice(0, 5) : null,
      endTime: o.endTime ? o.endTime.slice(0, 5) : null,
      reason: o.reason ?? null,
      affectedServiceCount: serviceCounts.get(o.userId) ?? 0,
      affectedLocations: locationsByStaff.get(o.userId) ?? [],
    };
  });
  // Sort by date ascending. Same-day groups still feel chronological
  // because createdAt isn't surfaced — but date is the only ordering
  // signal the operator actually cares about.
  exceptions.sort((a, b) => a.date.localeCompare(b.date));

  // KPI derivations — all real data:
  //   • totalUpcoming           — count over the next 30 days
  //   • vacationsNext30dStaff   — distinct staff with full-day off in <=30d
  //   • fullDayBlocks           — total unavailable=true entries
  //   • partialDayBlocks        — total unavailable=false entries
  const upcomingNext30 = exceptions.filter((e) => e.date <= in30Days);
  const totalUpcoming = upcomingNext30.length;
  const vacationsNext30dStaff = new Set(
    upcomingNext30.filter((e) => e.unavailable).map((e) => e.userId),
  ).size;
  const fullDayBlocks = upcomingNext30.filter((e) => e.unavailable).length;
  const partialDayBlocks = upcomingNext30.filter((e) => !e.unavailable).length;

  const workforceLite: WorkforceLite[] = workforceRows
    .map((u) => ({
      id: u.id,
      displayName: u.publicDisplayName ?? u.name,
      title: u.publicTitle ?? null,
      role: u.role as "admin" | "manager" | "staff",
      timezone: u.timezone ?? "UTC",
      avatarUrl: u.avatarUrl ?? null,
      deliveryMode: ((u.deliveryMode ?? "hybrid") as "in_person" | "virtual" | "hybrid"),
    }))
    .sort((a, b) => {
      const order = { admin: 0, manager: 1, staff: 2 } as const;
      if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
      return a.displayName.localeCompare(b.displayName);
    });

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Workforce exceptions"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Working hours", href: "/dashboard/availability" },
        { label: "Exceptions" },
      ]}
    >
      <ExceptionsClient
        isAdmin={isAdmin}
        callerUserId={user.id}
        callerTimezone={user.timezone ?? "UTC"}
        workforce={workforceLite}
        exceptions={exceptions}
        kpis={{
          totalUpcoming,
          vacationsNext30dStaff,
          fullDayBlocks,
          partialDayBlocks,
          workforceCount: allWorkforceIds.length,
        }}
      />
    </Shell>
  );
}
