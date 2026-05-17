import { and, count, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, tenants, users } from "@/db/schema";
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

  // Staff count is people who *deliver services* — includes both raw
  // staff and managers (a manager is a senior staff seat). Manager count
  // is just the managers, used to enforce the manager-seat quota.
  const [[staffRow], [managerRow], [bookingRow]] = await Promise.all([
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.role, ["staff", "manager"]))),
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

export function planFeature(planId: string | undefined, feature: "customBranding" | "analytics" | "publicProfile"): boolean {
  return getPlan(planId).limits[feature];
}
