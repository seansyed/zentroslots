import { and, count, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, locations, tenants, users } from "@/db/schema";
import { getPlan, isUnlimited, type PlanId } from "@/lib/plans";
import { HttpError } from "@/lib/auth";

export type UsageSnapshot = {
  plan: PlanId;
  staff: { used: number; limit: number };
  managers: { used: number; limit: number };
  bookingsThisMonth: { used: number; limit: number };
  trialEnd: Date | null;
};

function startOfMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getTenantUsage(tenantId: string): Promise<UsageSnapshot> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw new HttpError(404, "Tenant not found");

  const plan = getPlan(tenant.currentPlan);
  const monthStart = startOfMonthUtc();

  // Staff count is every operational human who delivers services or
  // holds workforce capacity. Admins, managers, and staff all count
  // as one seat each — admins are first-class workforce members who
  // can be assigned to services, hold availability, and appear in
  // the Staff workspace. Manager count is just managers, used to
  // enforce the separate manager-seat quota.
  //
  // Effect on Free plan (limit=1): a newly-signed-up admin shows as
  // 1/1 seats used, matching the operational reality that the owner
  // IS the workforce on day one. Adding a second teammate requires
  // upgrading.
  const [[staffRow], [managerRow], [bookingRow]] = await Promise.all([
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.role, ["admin", "manager", "staff"]))),
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.role, "manager"))),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenantId), gte(bookings.createdAt, monthStart))),
  ]);

  return {
    plan: plan.id,
    staff: { used: Number(staffRow?.n ?? 0), limit: plan.limits.maxStaff },
    managers: { used: Number(managerRow?.n ?? 0), limit: plan.limits.maxManagers },
    bookingsThisMonth: { used: Number(bookingRow?.n ?? 0), limit: plan.limits.maxBookingsPerMonth },
    trialEnd: tenant.trialEnd,
  };
}

export async function assertCanAddStaff(tenantId: string): Promise<void> {
  const u = await getTenantUsage(tenantId);
  if (isUnlimited(u.staff.limit)) return;
  if (u.staff.used >= u.staff.limit) {
    throw new HttpError(402, `Staff limit reached on ${u.plan} plan (${u.staff.limit}). Upgrade to add more.`);
  }
}

/**
 * Refuses 402 ("Payment Required" — used as the universal paywall code
 * across the app) when promoting another staff member to manager would
 * exceed the plan's manager-seat allowance. Caller passes the count of
 * managers AFTER the proposed change so this helper stays decoupled
 * from the live DB count at the moment of mutation.
 */
export async function assertCanAddManager(tenantId: string): Promise<void> {
  const u = await getTenantUsage(tenantId);
  // 0 = manager role not available on this plan at all.
  if (u.managers.limit === 0) {
    throw new HttpError(
      402,
      `Manager role isn't included on the ${u.plan} plan. Upgrade to enable manager seats.`
    );
  }
  if (isUnlimited(u.managers.limit)) return;
  if (u.managers.used >= u.managers.limit) {
    throw new HttpError(
      402,
      `Manager seats full (${u.managers.used} of ${u.managers.limit} used on ${u.plan} plan). Demote an existing manager or upgrade to add more seats.`
    );
  }
}

export async function assertCanCreateBooking(tenantId: string): Promise<void> {
  const u = await getTenantUsage(tenantId);
  if (isUnlimited(u.bookingsThisMonth.limit)) return;
  if (u.bookingsThisMonth.used >= u.bookingsThisMonth.limit) {
    throw new HttpError(402, `Monthly booking limit reached on ${u.plan} plan. Workspace must upgrade.`);
  }
}

/**
 * Refuses 402 when creating a new location would exceed the plan's
 * maxLocations cap. Phase 15A.
 *
 * Important: counts the ACTIVE rows only (isActive=true). Free-plan
 * tenants who had unlimited locations before the cap was introduced
 * are grandfathered — their over-cap rows continue to render in the
 * UI, but creating a NEW one is gated 402. Soft-deleting an existing
 * row reclaims a slot.
 */
export async function assertCanAddLocation(tenantId: string): Promise<void> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw new HttpError(404, "Tenant not found");
  const plan = getPlan(tenant.currentPlan);
  const limit = plan.limits.maxLocations;

  if (isUnlimited(limit)) return;

  // 0 = feature unavailable on this plan. We give a more
  // operationally clear message than the generic "limit reached".
  if (limit === 0) {
    throw new HttpError(
      402,
      `Locations are available on paid plans. Upgrade from ${plan.name} to manage multiple operational delivery hubs.`,
    );
  }

  const [row] = await db
    .select({ n: count() })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), eq(locations.isActive, true)));
  const used = Number(row?.n ?? 0);
  if (used >= limit) {
    throw new HttpError(
      402,
      `Location limit reached on ${plan.name} plan (${used} of ${limit}). Upgrade to add more locations.`,
    );
  }
}

export function planFeature(planId: string | undefined, feature: "customBranding" | "analytics" | "publicProfile"): boolean {
  return getPlan(planId).limits[feature];
}
