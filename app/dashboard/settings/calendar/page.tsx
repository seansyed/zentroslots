import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarConnections,
  calendarSyncLogs,
  tenants,
  users,
} from "@/db/schema";
import { getSession, isManagerial } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import CalendarConnectionsClient from "@/components/dashboard/CalendarConnectionsClient";

export const metadata = { title: "Calendar connections" };
export const dynamic = "force-dynamic";

// Settings → Calendar connections.
//
// Admin + manager: see every staff member's connection in the tenant.
// Staff: see only their own.
// Initial connection list + recent log entries are server-rendered so
// the page is meaningful on first paint; the client component
// refetches on user actions.
export default async function CalendarConnectionsPage(props: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const managerial = isManagerial(user.role);

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
            eq(calendarConnections.userId, user.id)
          )
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
            eq(calendarSyncLogs.userId, user.id)
          )
    )
    .orderBy(desc(calendarSyncLogs.createdAt))
    .limit(50);

  const params = await props.searchParams;

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Calendar connections"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Calendar connections" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Calendar connections</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Connect each staff member&apos;s working calendar so bookings stay
        in sync, double-bookings are blocked at booking time, and every
        confirmed appointment lands on their calendar.
      </p>

      <CalendarConnectionsClient
        viewerId={user.id}
        viewerRole={user.role}
        connections={connectionRows.map((c) => ({
          ...c,
          lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
          lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        }))}
        logs={logRows.map((l) => ({
          ...l,
          createdAt: l.createdAt.toISOString(),
        }))}
        flashConnected={params.connected ?? null}
        flashError={params.error ?? null}
      />
    </Shell>
  );
}
