import { redirect } from "next/navigation";
import { and, asc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, departments, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import DepartmentsClient from "@/components/dashboard/DepartmentsClient";

/**
 * Departments — operational architecture center.
 *
 * Renders the same per-department counts as /api/departments GET
 * so the page hydrates with real data on first paint. The client
 * re-fetches on mutate to keep the architecture view fresh.
 *
 * All queries tenant-scoped via the session's user record.
 */
export default async function DepartmentsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const rows = await db
    .select()
    .from(departments)
    .where(eq(departments.tenantId, user.tenantId))
    .orderBy(asc(departments.name));

  // Per-department counts (same shape as /api/departments). After
  // migration 0032, serviceCount is derived from the direct
  // `services.departmentId` column — the transitive (via staff)
  // relationship is no longer used as the primary ownership signal.
  const now = new Date();
  const last30dStart = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  const [staffCounts, ownedServices, bookingCounts] = await Promise.all([
    db
      .select({ departmentId: users.departmentId, c: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.tenantId, user.tenantId))
      .groupBy(users.departmentId),
    db
      .select({ departmentId: services.departmentId, name: services.name })
      .from(services)
      .where(eq(services.tenantId, user.tenantId)),
    db
      .select({ departmentId: bookings.departmentId, c: sql<number>`count(*)::int` })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, user.tenantId),
          gte(bookings.createdAt, last30dStart),
        ),
      )
      .groupBy(bookings.departmentId),
  ]);

  const staffMap = new Map(staffCounts.map((r) => [r.departmentId, Number(r.c)]));
  const bookingMap = new Map(bookingCounts.map((r) => [r.departmentId, Number(r.c)]));

  // Roll up directly-owned services per department, plus first 3
  // service names (alphabetical) for the assigned-services preview
  // chips on each department card.
  const serviceCountMap = new Map<string, number>();
  const serviceNameMap = new Map<string, string[]>();
  for (const s of ownedServices) {
    if (!s.departmentId) continue;
    serviceCountMap.set(s.departmentId, (serviceCountMap.get(s.departmentId) ?? 0) + 1);
    const list = serviceNameMap.get(s.departmentId) ?? [];
    list.push(s.name);
    serviceNameMap.set(s.departmentId, list);
  }
  for (const [, list] of serviceNameMap) {
    list.sort((a, b) => a.localeCompare(b));
  }

  const initial = rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color ?? null,
    description: r.description ?? null,
    staffCount: Number(staffMap.get(r.id) ?? 0),
    serviceCount: Number(serviceCountMap.get(r.id) ?? 0),
    assignedServiceNames: (serviceNameMap.get(r.id) ?? []).slice(0, 3),
    bookingsLast30d: Number(bookingMap.get(r.id) ?? 0),
  }));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Departments"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Departments" }]}
    >
      <DepartmentsClient
        isAdmin={user.role === "admin" || user.role === "manager"}
        initial={initial}
      />
    </Shell>
  );
}
