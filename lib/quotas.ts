import { and, count, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, tenants, users } from "@/db/schema";
import { getPlan, isUnlimited, type PlanId } from "@/lib/plans";
import { HttpError } from "@/lib/auth";

export type UsageSnapshot = {
  plan: PlanId;
  staff: { used: number; limit: number };
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

  const [[staffRow], [bookingRow]] = await Promise.all([
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.role, "staff"))),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenantId), gte(bookings.createdAt, monthStart))),
  ]);

  return {
    plan: plan.id,
    staff: { used: Number(staffRow?.n ?? 0), limit: plan.limits.maxStaff },
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
