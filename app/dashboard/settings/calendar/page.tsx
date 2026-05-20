import { redirect } from "next/navigation";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarConnections,
  calendarSyncLogs,
  serviceStaff,
  services,
  tenants,
  users,
} from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import CalendarConnectionsClient, {
  type BookingImpact,
  type CalendarKpis,
  type ConnectionRow,
  type StaffLite,
  type SyncLogRow,
} from "@/components/dashboard/CalendarConnectionsClient";

export const metadata = { title: "Calendar infrastructure" };
export const dynamic = "force-dynamic";

// Calendar infrastructure (Phase 17).
//
// This page used to be the primary OAuth setup surface. The
// architectural truth is that calendars are STAFF-OWNED — the
// data model has always been per-userId — so setup belongs on
// the Staff Profile drawer (Calendar tab). This page now monitors
// the infrastructure across the workforce: which staff are
// connected, who needs to reconnect, sync error rates, recent
// activity.
//
// Strict scope:
//   • Admin / manager: see every staff member's connection state
//   • Staff: see only their own row + a link back to their profile
//
// No backend changes. The OAuth endpoints, sync engine, and
// connection storage remain untouched.

export default async function CalendarInfrastructurePage(props: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const managerial = isManagerial(user.role);

  // Workforce roster (admin + manager + staff). Clients excluded —
  // they aren't part of the workforce that owns connections.
  // Admins see everyone; staff see only themselves.
  const workforceRows = managerial
    ? await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          avatarUrl: users.avatarUrl,
          publicDisplayName: users.publicDisplayName,
          publicTitle: users.publicTitle,
          timezone: users.timezone,
        })
        .from(users)
        .where(
          and(
            eq(users.tenantId, user.tenantId),
            inArray(users.role, ["admin", "manager", "staff"]),
          ),
        )
    : [
        {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatarUrl: user.avatarUrl,
          publicDisplayName: user.publicDisplayName ?? null,
          publicTitle: user.publicTitle ?? null,
          timezone: user.timezone ?? "UTC",
        },
      ];

  const workforce: StaffLite[] = workforceRows
    .map((u) => ({
      id: u.id,
      displayName: u.publicDisplayName ?? u.name,
      name: u.name,
      email: u.email,
      role: u.role as "admin" | "manager" | "staff",
      avatarUrl: u.avatarUrl ?? null,
      title: u.publicTitle ?? null,
      timezone: u.timezone ?? "UTC",
    }))
    .sort((a, b) => {
      const order = { admin: 0, manager: 1, staff: 2 } as const;
      if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
      return a.displayName.localeCompare(b.displayName);
    });

  // Connections + recent logs — same shape the page used before.
  const connectionRows = await db
    .select({
      id: calendarConnections.id,
      userId: calendarConnections.userId,
      provider: calendarConnections.provider,
      status: calendarConnections.status,
      accountEmail: calendarConnections.accountEmail,
      calendarId: calendarConnections.calendarId,
      lastSyncedAt: calendarConnections.lastSyncedAt,
      lastError: calendarConnections.lastError,
      lastErrorAt: calendarConnections.lastErrorAt,
      createdAt: calendarConnections.createdAt,
      updatedAt: calendarConnections.updatedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(calendarConnections)
    .leftJoin(users, eq(users.id, calendarConnections.userId))
    .where(
      managerial
        ? eq(calendarConnections.tenantId, tenant.id)
        : and(
            eq(calendarConnections.tenantId, tenant.id),
            eq(calendarConnections.userId, user.id),
          ),
    )
    .orderBy(desc(calendarConnections.updatedAt));

  const logRows = await db
    .select()
    .from(calendarSyncLogs)
    .where(
      managerial
        ? eq(calendarSyncLogs.tenantId, tenant.id)
        : and(
            eq(calendarSyncLogs.tenantId, tenant.id),
            eq(calendarSyncLogs.userId, user.id),
          ),
    )
    .orderBy(desc(calendarSyncLogs.createdAt))
    .limit(50);

  // KPI count queries — honest aggregates, never derived from the
  // truncated log list. Errors last 7d + sync events last 24h
  // come from dedicated COUNT queries so the dashboard reads true
  // infrastructure health, not just the slice we render.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60_000);
  const tenantScope = managerial
    ? [eq(calendarSyncLogs.tenantId, tenant.id)]
    : [eq(calendarSyncLogs.tenantId, tenant.id), eq(calendarSyncLogs.userId, user.id)];

  const [errors7d] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(calendarSyncLogs)
    .where(
      and(
        ...tenantScope,
        eq(calendarSyncLogs.status, "failed"),
        gte(calendarSyncLogs.createdAt, sevenDaysAgo),
      ),
    );
  const [syncs24h] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(calendarSyncLogs)
    .where(and(...tenantScope, gte(calendarSyncLogs.createdAt, oneDayAgo)));

  // Per-status connection breakdowns. We compute these in JS over
  // the already-fetched connection rows since the page renders the
  // full list anyway — extra COUNT queries would be redundant.
  const connectedUserIds = new Set(connectionRows.map((c) => c.userId));
  const connectedStaffCount = connectedUserIds.size;
  const healthyCount = connectionRows.filter((c) => c.status === "active" && !c.lastError).length;
  const reconnectRequiredCount = connectionRows.filter((c) => c.status === "needs_reconnect").length;
  const disconnectedCount = connectionRows.filter((c) => c.status === "disconnected").length;
  const withWarningCount = connectionRows.filter(
    (c) => c.status === "active" && c.lastError,
  ).length;

  // Provider distribution for the operator's mental model.
  const providerCounts: Record<string, number> = {};
  for (const c of connectionRows) {
    providerCounts[c.provider] = (providerCounts[c.provider] ?? 0) + 1;
  }
  const providerDistribution = Object.entries(providerCounts).map(([provider, count]) => ({
    provider,
    count,
  }));

  const kpis: CalendarKpis = {
    workforceCount: workforce.length,
    connectedStaffCount,
    healthyCount,
    reconnectRequiredCount,
    disconnectedCount,
    withWarningCount,
    errorsLast7d: Number(errors7d?.c ?? 0),
    syncEventsLast24h: Number(syncs24h?.c ?? 0),
    providerDistribution,
  };

  // ── Last successful sync per connection (Phase 17B) ───────────
  // Stricter signal than connection.lastSyncedAt: only counts
  // events the engine actually completed without error. Surfaces
  // as a separate column so operators can tell "we touched it
  // recently" apart from "we touched it recently AND it worked."
  const lastSuccessRows = connectionRows.length > 0
    ? await db
        .select({
          connectionId: calendarSyncLogs.connectionId,
          lastAt: sql<Date>`max(${calendarSyncLogs.createdAt})`,
        })
        .from(calendarSyncLogs)
        .where(
          and(
            eq(calendarSyncLogs.tenantId, tenant.id),
            eq(calendarSyncLogs.status, "ok"),
            inArray(
              calendarSyncLogs.connectionId,
              connectionRows.map((c) => c.id),
            ),
          ),
        )
        .groupBy(calendarSyncLogs.connectionId)
    : [];
  const lastSuccessByConnection = new Map<string, string>();
  for (const r of lastSuccessRows) {
    if (r.connectionId && r.lastAt) {
      lastSuccessByConnection.set(r.connectionId, new Date(r.lastAt).toISOString());
    }
  }

  // ── Booking impact intelligence (Phase 17B refinement #6) ─────
  // Honest aggregates only. Computed per-service:
  //   • For each service, how many assigned staff have a HEALTHY
  //     connection (status='active' AND no trailing lastError) or
  //     are inheriting in a way that doesn't require sync?
  //
  // Two derived counters:
  //   - servicesAtRiskCount       : any service where at least one
  //                                 assigned staff is uncovered
  //   - servicesUncoveredCount    : services where 100% of assigned
  //                                 staff are uncovered (booking-blocker)
  //
  // "Uncovered" = staff has no calendar connection OR a connection
  //               that isn't actively healthy. This is a conservative
  //               infrastructure signal — booking engine still works
  //               without calendar sync, but routing-quality drops
  //               (no busy-time skew, no auto-event-create).
  const healthyStaffIds = new Set(
    connectionRows
      .filter((c) => c.status === "active" && !c.lastError)
      .map((c) => c.userId),
  );
  const disconnectedStaffCount = managerial
    ? workforce.filter((w) => !healthyStaffIds.has(w.id)).length
    : healthyStaffIds.has(user.id) ? 0 : 1;

  let servicesAtRiskCount = 0;
  let servicesUncoveredCount = 0;
  // Only run service-impact query for admins — staff don't need
  // workspace-wide booking metrics on their personal view.
  if (managerial && workforce.length > 0) {
    const serviceStaffRows = await db
      .select({
        serviceId: serviceStaff.serviceId,
        userId: serviceStaff.userId,
        serviceName: services.name,
        isActive: services.isActive,
      })
      .from(serviceStaff)
      .innerJoin(services, eq(services.id, serviceStaff.serviceId))
      .where(eq(serviceStaff.tenantId, tenant.id));

    const perService = new Map<string, { total: number; healthy: number }>();
    for (const r of serviceStaffRows) {
      if (!r.isActive) continue;
      const m = perService.get(r.serviceId) ?? { total: 0, healthy: 0 };
      m.total += 1;
      if (healthyStaffIds.has(r.userId)) m.healthy += 1;
      perService.set(r.serviceId, m);
    }
    for (const m of perService.values()) {
      if (m.total === 0) continue;
      if (m.healthy < m.total) servicesAtRiskCount += 1;
      if (m.healthy === 0) servicesUncoveredCount += 1;
    }
  }

  const bookingImpact: BookingImpact = {
    disconnectedStaffCount,
    servicesAtRiskCount,
    servicesUncoveredCount,
    // No infrastructure routing-mode data exposed yet, so we
    // honestly leave that signal out for now.
  };

  const params = await props.searchParams;

  // Serialize connection rows for the client component (timestamps
  // become strings, ms-since-epoch math happens client-side).
  const connections: ConnectionRow[] = connectionRows.map((c) => ({
    id: c.id,
    userId: c.userId,
    provider: c.provider,
    status: c.status as "active" | "needs_reconnect" | "disconnected",
    accountEmail: c.accountEmail ?? null,
    calendarId: c.calendarId,
    lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: lastSuccessByConnection.get(c.id) ?? null,
    lastError: c.lastError ?? null,
    lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    userName: c.userName ?? null,
    userEmail: c.userEmail ?? null,
  }));

  const logs: SyncLogRow[] = logRows.map((l) => ({
    id: l.id,
    connectionId: l.connectionId ?? null,
    userId: l.userId ?? null,
    bookingId: l.bookingId ?? null,
    provider: l.provider,
    kind: l.kind,
    status: l.status,
    errorClass: l.errorClass ?? null,
    errorMessage: l.errorMessage ?? null,
    externalEventId: l.externalEventId ?? null,
    latencyMs: l.latencyMs ?? null,
    createdAt: l.createdAt.toISOString(),
  }));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Calendar infrastructure"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Calendar infrastructure" },
      ]}
    >
      <CalendarConnectionsClient
        viewerId={user.id}
        viewerRole={user.role as "admin" | "manager" | "staff"}
        workforce={workforce}
        connections={connections}
        logs={logs}
        kpis={kpis}
        bookingImpact={bookingImpact}
        flashConnected={params.connected ?? null}
        flashError={params.error ?? null}
      />
    </Shell>
  );
}
