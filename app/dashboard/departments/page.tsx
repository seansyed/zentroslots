import { redirect } from "next/navigation";
import { and, asc, countDistinct, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, departments, serviceStaff, tenants, users } from "@/db/schema";
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

  // Per-department counts (same shape as /api/departments). Honest
  // signals only — services↔departments is transitive via staff.
  const now = new Date();
  const last30dStart = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  const [staffCounts, serviceCounts, bookingCounts] = await Promise.all([
    db
      .select({ departmentId: users.departmentId, c: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.tenantId, user.tenantId))
      .groupBy(users.departmentId),
    db
      .select({ departmentId: users.departmentId, c: countDistinct(serviceStaff.serviceId) })
      .from(serviceStaff)
      .innerJoin(users, eq(users.id, serviceStaff.userId))
      .where(eq(serviceStaff.tenantId, user.tenantId))
      .groupBy(users.departmentId),
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
  const serviceMap = new Map(serviceCounts.map((r) => [r.departmentId, Number(r.c)]));
  const bookingMap = new Map(bookingCounts.map((r) => [r.departmentId, Number(r.c)]));

  const initial = rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color ?? null,
    description: r.description ?? null,
    staffCount: Number(staffMap.get(r.id) ?? 0),
    serviceCount: Number(serviceMap.get(r.id) ?? 0),
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
