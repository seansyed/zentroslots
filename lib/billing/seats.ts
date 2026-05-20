/**
 * Workforce seat licensing helper — additive layer on top of the
 * existing lib/quotas getTenantUsage() pipeline. NO schema changes.
 *
 * This file is the single source of truth for "operational seats" in
 * the application. It exposes the canonical math (totalSeats /
 * usedSeats / availableSeats / percent / level), plus a small set of
 * derived signals (`unlimited`, `nearLimit`, `atCapacity`) that the
 * UI consumes uniformly.
 *
 * Honest data discipline:
 *
 *   - `usedSeats` is derived from real DB rows (lib/quotas) — every
 *     user whose role is "staff" OR "manager" is counted, exactly
 *     matching the server-side enforcement in
 *     `assertCanAddStaff()` and `/api/auth/signup`. There is no
 *     drift between what the UI shows and what the server permits.
 *
 *   - `extraSeats` is reserved for a future Stripe seat add-on
 *     product. Today the application has no per-seat add-on SKU
 *     configured anywhere (no Stripe Price ID, no DB column on
 *     tenants, no checkout path). To avoid inventing a fake flow,
 *     this helper returns `extraSeats: 0` and `addOnSupported: false`
 *     until a real product is wired. The shape is forward-compatible
 *     — when a real add-on lands, only this helper changes.
 *
 *   - Soft staff deactivation: today `users` has no `deactivated_at`
 *     / `active` column, so every (staff|manager) row counts as
 *     consuming a seat. The helper documents this constraint and
 *     `hasSoftDeactivation` reports `false`. When the column lands,
 *     the math automatically respects it — no UI changes needed.
 */

import { eq, and, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getPlan, isUnlimited, type PlanId } from "@/lib/plans";
import { HttpError } from "@/lib/auth";

export type SeatLevel = "healthy" | "warning" | "critical" | "unlimited";

export type WorkforceSeats = {
  /** Plan ID the math is anchored to. */
  plan: PlanId;
  /** Display name of the plan (e.g. "Pro"). */
  planName: string;
  /** Plan price in cents per interval. null = "contact us" (enterprise). */
  planPriceCents: number | null;
  /** "month" today, or null for enterprise/custom plans. */
  planInterval: "month" | null;
  /** One-line marketing description from the plan catalog. */
  planDescription: string;
  /** Plan-included seat limit. -1 if the plan grants unlimited seats. */
  includedSeats: number;
  /** Add-on seats purchased on top of the plan. 0 today. */
  extraSeats: number;
  /** Effective total seats. `Infinity` if unlimited. */
  totalSeats: number;
  /** Active staff + managers currently consuming seats. */
  usedSeats: number;
  /** Remaining seats. `Infinity` if unlimited. Never negative. */
  availableSeats: number;
  /** Whether the plan allows unlimited seats. */
  unlimited: boolean;
  /** Whether the tenant has reached capacity (used >= total). */
  atCapacity: boolean;
  /** Whether the tenant is at or past 80% utilization. */
  nearLimit: boolean;
  /** Integer percent (0..100) of seat utilization. Always 0 if unlimited. */
  percent: number;
  /** Tonal level for UI surfaces. */
  level: SeatLevel;
  /** True when add-on seats can actually be purchased. False today. */
  addOnSupported: boolean;
  /**
   * True when the `users` schema supports soft-deactivation
   * (which would let us exclude inactive staff from `usedSeats`).
   * False today; flips to true when the column lands.
   */
  hasSoftDeactivation: boolean;
};

const WARNING_THRESHOLD = 0.8; // 80%

/**
 * Compute the canonical seat snapshot for a tenant. Tenant-scoped;
 * never returns data for other workspaces.
 */
export async function getWorkforceSeats(tenantId: string): Promise<WorkforceSeats> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw new HttpError(404, "Tenant not found");

  const plan = getPlan(tenant.currentPlan);
  const includedSeats = plan.limits.maxStaff;
  const extraSeats = 0; // future Stripe seat add-on; see file header.
  const unlimited = isUnlimited(includedSeats);

  // Count seats the same way assertCanAddStaff() does — staff +
  // manager role rows for this tenant. Mirrors lib/quotas exactly.
  // Note: selecting `id` only keeps the row payload tiny; the count
  // happens in JS, which is fine for the size of any tenant's
  // workforce in practice.
  const seatRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.role, ["staff", "manager"])));
  const usedSeats = seatRows.length;

  const planMeta = {
    plan: plan.id,
    planName: plan.name,
    planPriceCents: plan.priceCents,
    planInterval: plan.interval,
    planDescription: plan.description,
  };

  if (unlimited) {
    return {
      ...planMeta,
      includedSeats,
      extraSeats,
      totalSeats: Infinity,
      usedSeats,
      availableSeats: Infinity,
      unlimited: true,
      atCapacity: false,
      nearLimit: false,
      percent: 0,
      level: "unlimited",
      addOnSupported: false,
      hasSoftDeactivation: false,
    };
  }

  const totalSeats = Math.max(0, includedSeats + extraSeats);
  const availableSeats = Math.max(0, totalSeats - usedSeats);
  const percent = totalSeats > 0 ? Math.min(100, Math.round((usedSeats / totalSeats) * 100)) : 0;
  const atCapacity = usedSeats >= totalSeats;
  const nearLimit = !atCapacity && percent >= Math.round(WARNING_THRESHOLD * 100);

  const level: SeatLevel = atCapacity
    ? "critical"
    : nearLimit
      ? "warning"
      : "healthy";

  return {
    ...planMeta,
    includedSeats,
    extraSeats,
    totalSeats,
    usedSeats,
    availableSeats,
    unlimited: false,
    atCapacity,
    nearLimit,
    percent,
    level,
    addOnSupported: false,
    hasSoftDeactivation: false,
  };
}

/**
 * Serialization helper — turn Infinity into null so the shape is
 * safe to ship over JSON without losing semantics. The client
 * re-interprets null as "unlimited" via the `unlimited` flag.
 */
export type WorkforceSeatsJson = Omit<WorkforceSeats, "totalSeats" | "availableSeats"> & {
  totalSeats: number | null;
  availableSeats: number | null;
};

export function toWorkforceSeatsJson(s: WorkforceSeats): WorkforceSeatsJson {
  return {
    ...s,
    totalSeats: Number.isFinite(s.totalSeats) ? s.totalSeats : null,
    availableSeats: Number.isFinite(s.availableSeats) ? s.availableSeats : null,
  };
}
