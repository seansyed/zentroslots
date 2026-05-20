import { redirect } from "next/navigation";
import { eq, inArray, and } from "drizzle-orm";

import { db } from "@/db/client";
import {
  availability,
  locations,
  staffLocationAssignments,
  tenants,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import WorkspaceHoursClient, {
  type WorkforceMember,
  type AssignmentRow,
} from "@/components/dashboard/WorkspaceHoursClient";
import { hasAnyDefault, readDefaultWorkspaceHours } from "@/lib/workspace-hours";
import { readDaysOfWeek } from "@/lib/workforce-location";

// Workforce Availability Intelligence Center (Phase 16C).
//
// The sidebar's "Working hours" entry points here. This page used
// to be a tiny per-user weekly editor (AvailabilityEditor); it now
// presents the full workforce stack:
//
//   1. Workspace hours       — tenant-level fallback (admin editor)
//   2. Staff overrides       — per-user availability rules
//   3. Location presence     — per-staff location pivot
//   4. Delivery mode         — per-staff virtual/in-person/hybrid
//
// Role gating:
//   • admin / manager → full workforce roster + workspace editor
//   • staff           → workspace hours visible (read-only), and
//                       ONLY their own row appears in the coverage
//                       table. Editing other staff is forbidden by
//                       the existing PUT endpoints anyway, but the
//                       UI shouldn't even surface them.
//
// Slot generation, availability resolver, routing engine, and the
// booking flow are UNCHANGED. No schema changes. No new APIs.

export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard/login");

  const initialHours = readDefaultWorkspaceHours(tenant.defaultWorkspaceHours);
  const isAdmin = user.role === "admin" || user.role === "manager";

  // Workforce roster — admin + manager + staff. Clients are NEVER
  // considered workforce for scheduling purposes.
  const workforceRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      timezone: users.timezone,
      avatarUrl: users.avatarUrl,
      deliveryMode: users.deliveryMode,
      publicTitle: users.publicTitle,
      publicDisplayName: users.publicDisplayName,
    })
    .from(users)
    .where(
      and(
        eq(users.tenantId, user.tenantId),
        inArray(users.role, ["admin", "manager", "staff"]),
      ),
    );
  const workforceIds = workforceRows.map((u) => u.id);

  // Distinct set of staff IDs that have at least one availability
  // row — those are on "custom", everyone else is inheriting.
  let staffWithRules = new Set<string>();
  if (workforceIds.length > 0) {
    const withRules = await db
      .selectDistinct({ userId: availability.userId })
      .from(availability)
      .where(
        and(
          eq(availability.tenantId, user.tenantId),
          inArray(availability.userId, workforceIds),
        ),
      );
    staffWithRules = new Set(withRules.map((r) => r.userId));
  }

  // Per-staff location assignment rows. We join location metadata
  // so the table can render swatches + day chips without a second
  // round-trip.
  let assignmentRowsRaw: Array<{
    staffId: string;
    locationId: string;
    locationName: string;
    locationType: string | null;
    daysOfWeek: unknown;
    isPrimary: boolean;
  }> = [];
  if (workforceIds.length > 0) {
    assignmentRowsRaw = await db
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
          inArray(staffLocationAssignments.staffId, workforceIds),
        ),
      );
  }

  const assignmentsByStaff = new Map<string, AssignmentRow[]>();
  for (const r of assignmentRowsRaw) {
    const list = assignmentsByStaff.get(r.staffId) ?? [];
    list.push({
      locationId: r.locationId,
      locationName: r.locationName,
      locationType: ((r.locationType ?? "physical") as "physical" | "virtual" | "hybrid"),
      daysOfWeek: readDaysOfWeek(r.daysOfWeek),
      isPrimary: r.isPrimary,
    });
    assignmentsByStaff.set(r.staffId, list);
  }

  // Compose the workforce member rows the client expects.
  // KPIs are computed over the FULL workforce (real-data aggregates,
  // never exposing individuals). The rendered table is filtered by
  // role: admins see everyone, staff see themselves only.
  const fullWorkforce: WorkforceMember[] = workforceRows.map((u) => {
    const assignments = assignmentsByStaff.get(u.id) ?? [];
    return {
      id: u.id,
      name: u.name,
      displayName: u.publicDisplayName ?? u.name,
      title: u.publicTitle ?? null,
      email: u.email,
      role: u.role as "admin" | "manager" | "staff",
      timezone: u.timezone ?? "UTC",
      avatarUrl: u.avatarUrl ?? null,
      deliveryMode: ((u.deliveryMode ?? "hybrid") as "in_person" | "virtual" | "hybrid"),
      hasCustomSchedule: staffWithRules.has(u.id),
      assignments,
    };
  });
  fullWorkforce.sort((a, b) => {
    const roleOrder = { admin: 0, manager: 1, staff: 2 } as const;
    if (roleOrder[a.role] !== roleOrder[b.role]) {
      return roleOrder[a.role] - roleOrder[b.role];
    }
    return a.displayName.localeCompare(b.displayName);
  });

  // Non-admin staff get a one-row view of their own schedule. They
  // can still edit themselves via the drawer (PUT /api/availability
  // already enforces the self-write rule).
  const workforce = isAdmin
    ? fullWorkforce
    : fullWorkforce.filter((m) => m.id === user.id);

  // Locations footprint — counted on the full set, used by the KPI
  // row. Quietly aggregated; no per-location data exposed.
  const allLocations = await db
    .select({
      id: locations.id,
      name: locations.name,
      locationType: locations.locationType,
      isActive: locations.isActive,
      isSystem: locations.isSystem,
    })
    .from(locations)
    .where(eq(locations.tenantId, user.tenantId));
  const activeLocations = allLocations.filter((l) => l.isActive);

  // KPI derivations — computed over the full workforce so the
  // tenant-wide signal is honest. Aggregates only; no individual
  // data is exposed to non-admin staff via these counters.
  const inheritingCount = fullWorkforce.filter((w) => !w.hasCustomSchedule).length;
  const customCount = fullWorkforce.length - inheritingCount;
  const virtualCapableCount = fullWorkforce.filter(
    (w) => w.deliveryMode === "virtual" || w.deliveryMode === "hybrid",
  ).length;
  const workspaceHasOpenDay = hasAnyDefault(initialHours);
  let bookable = customCount;
  if (workspaceHasOpenDay) bookable += inheritingCount;
  const coveragePct = fullWorkforce.length === 0 ? 0 : Math.round((bookable / fullWorkforce.length) * 100);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Working hours"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Working hours" },
      ]}
    >
      <WorkspaceHoursClient
        initial={initialHours}
        canEdit={isAdmin}
        kpis={{
          inheritingCount,
          customCount,
          workforceCount: fullWorkforce.length,
          virtualCapableCount,
          activeLocationsCount: activeLocations.length,
          coveragePct,
          workspaceHasOpenDay,
        }}
        workforce={workforce}
        tenantTimezone={user.timezone ?? "UTC"}
      />
    </Shell>
  );
}
