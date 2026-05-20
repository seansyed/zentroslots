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
// This page used to be a plain "default workspace hours" editor.
// As of Phase 16C it presents the workspace + staff + location +
// delivery hierarchy in one operational surface:
//
//   1. Workspace hours       — tenant-level fallback (this page edits)
//   2. Staff overrides       — per-user availability rules
//   3. Location presence     — per-staff location pivot
//   4. Delivery mode         — per-staff virtual/in-person/hybrid
//
// Slot generation + the availability resolver are UNCHANGED. The
// page is a richer presentation + a slim editor surface on top of
// the existing PUT endpoints. No new APIs, no schema changes.

export const dynamic = "force-dynamic";

export default async function WorkspaceHoursPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard/login");

  const initialHours = readDefaultWorkspaceHours(tenant.defaultWorkspaceHours);

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
  // round-trip. Cap by tenant — staff_location_assignments already
  // enforces tenant scope, but we filter explicitly for defense.
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
  const workforce: WorkforceMember[] = workforceRows.map((u) => {
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
  // Sort: admins first, then managers, then staff — alphabetical within.
  workforce.sort((a, b) => {
    const roleOrder = { admin: 0, manager: 1, staff: 2 } as const;
    if (roleOrder[a.role] !== roleOrder[b.role]) {
      return roleOrder[a.role] - roleOrder[b.role];
    }
    return a.displayName.localeCompare(b.displayName);
  });

  // Locations footprint — used by the KPI row + the "Active
  // locations" tile. Counted server-side so we don't ship the
  // whole list when only the count is needed for the dashboard.
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

  // ─── KPI derivations ───────────────────────────────────────────
  // These are *real* metrics computed from the same data the
  // resolver consumes. No fabrication.
  const inheritingCount = workforce.filter((w) => !w.hasCustomSchedule).length;
  const customCount = workforce.length - inheritingCount;
  const virtualCapableCount = workforce.filter(
    (w) => w.deliveryMode === "virtual" || w.deliveryMode === "hybrid",
  ).length;

  // Coverage % — honest definition: a workforce member is
  // "bookable this week" when they either have custom rules, OR
  // they're inheriting and the workspace has at least one open day.
  // Edge case: zero workforce → coverage = 0.
  const workspaceHasOpenDay = hasAnyDefault(initialHours);
  let bookable = customCount;
  if (workspaceHasOpenDay) bookable += inheritingCount;
  const coveragePct = workforce.length === 0 ? 0 : Math.round((bookable / workforce.length) * 100);

  const isAdmin = user.role === "admin" || user.role === "manager";

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Workforce availability"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Workforce availability" },
      ]}
    >
      <WorkspaceHoursClient
        initial={initialHours}
        canEdit={isAdmin}
        kpis={{
          inheritingCount,
          customCount,
          workforceCount: workforce.length,
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
