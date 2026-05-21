import { redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { calendarConnections, departments, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import ServicesClient from "@/components/dashboard/ServicesClient";
import { canCreateService, getPlan } from "@/lib/plans";

export default async function ServicesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // Workforce catalog (for the assignment editor inside the service
  // drawer AND the dedicated Assign Staff panel). Enriched with
  // department info so the panel can offer department-aware
  // filtering. Workforce = admin + manager + staff — every
  // operational human in this tenant. This matches the rest of the
  // workforce surfaces (Staff page, seat licensing). Only "client"
  // rows are excluded.
  const staffRows = await db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      departmentId: users.departmentId,
      departmentName: departments.name,
    })
    .from(users)
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(and(eq(users.tenantId, user.tenantId), inArray(users.role, ["admin", "manager", "staff"])))
    .orderBy(asc(users.name));

  // Department catalog (for in-drawer scaffolding + the empty-state
  // activation checklist that links to /dashboard/departments).
  const departmentRows = await db
    .select({ id: departments.id, name: departments.name, color: departments.color })
    .from(departments)
    .where(eq(departments.tenantId, user.tenantId))
    .orderBy(asc(departments.name));

  // ── Phase 18: plan cap snapshot ──────────────────────────────
  // Active services count is computed server-side so the page hero
  // already knows whether to show the lockout state on first paint
  // (no flash of "Add service" before client decides). The client
  // recomputes after creates/deletes — this is the seed value.
  const [activeCountRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(services)
    .where(and(eq(services.tenantId, user.tenantId), eq(services.isActive, 1)));
  const initialActiveCount = Number(activeCountRow?.c ?? 0);
  const plan = getPlan(tenant?.currentPlan ?? null);
  const initialCapability = canCreateService(plan, initialActiveCount);

  // ── Phase 18B: healthy-staff set for service health score ────
  // A staff member counts as "calendar-healthy" when they have an
  // active calendar connection with no trailing error. Same honest
  // signal the Calendar Infrastructure page uses. The client uses
  // this to derive per-service calendar coverage in deriveServiceHealth.
  const healthyConnRows = await db
    .selectDistinct({ userId: calendarConnections.userId })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.tenantId, user.tenantId),
        eq(calendarConnections.status, "active"),
        isNull(calendarConnections.lastError),
      ),
    );
  // ne() needed to keep TS happy if drizzle ever changes signatures.
  void ne;
  const healthyStaffIds = healthyConnRows.map((r) => r.userId);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Services"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Services" }]}
    >
      <ServicesClient
        isAdmin={user.role === "admin" || user.role === "manager"}
        allStaff={staffRows.map((s) => ({
          id: s.id,
          name: s.name,
          avatarUrl: s.avatarUrl ?? null,
          departmentId: s.departmentId ?? null,
          departmentName: s.departmentName ?? null,
        }))}
        allDepartments={departmentRows.map((d) => ({ id: d.id, name: d.name, color: d.color ?? null }))}
        tenantSlug={tenant?.slug ?? null}
        tenantName={tenant?.name ?? null}
        planInfo={{
          id: plan.id,
          name: plan.name,
          maxActiveServices: plan.limits.maxActiveServices,
          initialActiveCount,
          initialAtCap: initialCapability.cap.atCap,
        }}
        healthyStaffIds={healthyStaffIds}
      />
    </Shell>
  );
}
