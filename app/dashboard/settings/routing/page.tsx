import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  calendarConnections,
  services,
  staffAssignmentRules,
  tenants,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getPlan, meetsPlan, type PlanId } from "@/lib/plans";
import { loadCapabilitiesForTenant } from "@/lib/billing/loadCapabilities";
import Shell from "@/components/dashboard/Shell";
import RoutingClient, {
  type RoutingPageBootstrap,
} from "@/components/dashboard/RoutingClient";
import { CapabilityProvider } from "@/components/billing/CapabilityProvider";

export const metadata = { title: "Routing Intelligence Center" };
export const dynamic = "force-dynamic";

export default async function StaffRoutingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // ── Hero metrics from real backend state ──────────────────────────────
  // Capabilities loaded in parallel (Phase 3 hydration). The routing
  // page keeps its existing bootstrap-prop architecture; the provider
  // is mounted alongside so future surface refactors can switch to
  // the hook without touching the server fetch.
  const [staffRows, calRows, activeServices, ruleRows, capabilities] = await Promise.all([
    db
      .select({ id: users.id, role: users.role, name: users.name })
      .from(users)
      .where(eq(users.tenantId, tenant.id)),
    db
      .select({
        id: calendarConnections.id,
        userId: calendarConnections.userId,
        status: calendarConnections.status,
      })
      .from(calendarConnections)
      .where(eq(calendarConnections.tenantId, tenant.id)),
    db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(and(eq(services.tenantId, tenant.id), eq(services.isActive, 1))),
    db
      .select({
        id: staffAssignmentRules.id,
        serviceId: staffAssignmentRules.serviceId,
        mode: staffAssignmentRules.mode,
        enabled: staffAssignmentRules.enabled,
      })
      .from(staffAssignmentRules)
      .where(eq(staffAssignmentRules.tenantId, tenant.id)),
    loadCapabilitiesForTenant(tenant.id),
  ]);

  const staff = staffRows.filter((s) => s.role !== "client");
  const activeCalendars = calRows.filter((c) => c.status === "active");
  const calendarConnectedStaff = new Set(activeCalendars.map((c) => c.userId)).size;

  // Active routing mode = tenant default if present + enabled + not manual; else "manual".
  const tenantDefaultRule = ruleRows.find((r) => r.serviceId === null);
  const activeMode: string =
    tenantDefaultRule && tenantDefaultRule.enabled && tenantDefaultRule.mode !== "manual"
      ? tenantDefaultRule.mode
      : "manual";
  const serviceOverrideCount = ruleRows.filter((r) => r.serviceId !== null && r.enabled).length;

  // ── Plan info (visibility-only badges per the brief) ─────────────────
  const plan = getPlan(tenant.currentPlan);
  const currentPlanId = plan.id as PlanId;

  const planByMode: Record<string, PlanId> = {
    manual: "free",
    least_busy: "pro",
    round_robin: "team",
    weighted: "team",
    priority: "enterprise",
  };

  const bootstrap: RoutingPageBootstrap = {
    tenantId: tenant.id,
    plan: {
      id: plan.id,
      name: plan.name,
    },
    hero: {
      activeMode,
      eligibleStaffCount: staff.length,
      calendarConnectedStaff,
      activeCalendars: activeCalendars.length,
      activeServiceCount: activeServices.length,
      serviceOverrideCount,
      tenantHasDefaultRule:
        Boolean(tenantDefaultRule) &&
        tenantDefaultRule!.enabled &&
        tenantDefaultRule!.mode !== "manual",
    },
    planByMode,
    planRank: {
      free: 0,
      solo: 1,
      pro: 2,
      team: 3,
      enterprise: 4,
    },
    canUseMode: {
      manual: meetsPlan(currentPlanId, "free"),
      least_busy: meetsPlan(currentPlanId, "pro"),
      round_robin: meetsPlan(currentPlanId, "team"),
      weighted: meetsPlan(currentPlanId, "team"),
      priority: meetsPlan(currentPlanId, "enterprise"),
    },
  };

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Routing Intelligence Center"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Staff routing" },
      ]}
    >
      <CapabilityProvider initial={capabilities}>
        <RoutingClient bootstrap={bootstrap} />
      </CapabilityProvider>
    </Shell>
  );
}

