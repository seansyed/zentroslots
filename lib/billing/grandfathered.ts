/**
 * Grandfathered-row inventory (Phase 2 of plan enforcement).
 *
 * READ-ONLY helper that answers: "If this tenant downgrades from Pro to
 * Free today, what premium artifacts are they currently grandfathered
 * on?" Intended consumers:
 *   - Stripe webhook (subscription downgrade) — log the exposure
 *   - Admin tools — "show me tenants over their plan limits"
 *   - Future downgrade flow — preview before any soft-pause action
 *
 * This file does NOT mutate. It does NOT pause series. It does NOT
 * disable rules. Those actions are deliberately deferred — when the
 * operator chooses an enforcement policy ("hard pause on downgrade"
 * vs "soft warn + grandfather indefinitely"), the action lives in a
 * separate `downgradeEnforcement.ts` that imports this inventory.
 *
 * Why split read from write: the user's stated tradeoff is hard-enforce
 * on writes + grandfather existing rows. The cron guards already honor
 * that. Adding a write-side downgrade pruner is a SEPARATE policy
 * decision; structuring this as a pure read keeps the door open
 * without forcing the choice today.
 */
import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import {
  automationRules,
  bookingRules,
  bookingSeries,
  scheduledReports,
  staffAssignmentRules,
  tenantDomains,
  tenants,
} from "@/db/schema";
import { canUse, type Capability } from "@/lib/billing/capabilities";
import { getPlan } from "@/lib/plans";

export type GrandfatherInventoryRow = {
  capability: Capability;
  /** Active rows on premium features that the current plan does NOT
   *  unlock. These are the rows that WOULD pause if the operator
   *  later flips on hard-cron-skip for downgraded plans. */
  count: number;
};

export type GrandfatherInventory = {
  tenantId: string;
  currentPlan: string;
  /** True when the current plan unlocks every capability the tenant
   *  has rows for — i.e. nothing is grandfathered, downgrade-clean. */
  clean: boolean;
  rows: GrandfatherInventoryRow[];
};

/**
 * For each capability whose tier exceeds the tenant's current plan,
 * count the still-active rows in that feature's table. Returns zero
 * rows when the tenant is at the right tier (nothing grandfathered).
 *
 * Tenant isolation: every count is filtered by `tenantId`. Caller is
 * responsible for authorizing access to this tenantId (route-level
 * `requireUser()`/`requireRole(["admin"])`).
 *
 * Defensive: if a feature's table doesn't exist or the count fails,
 * we record `count: 0` for that capability rather than throwing. This
 * helper exists to inform decisions, never to block them.
 */
export async function listGrandfatheredRowCounts(args: {
  tenantId: string;
  db?: typeof defaultDb;
}): Promise<GrandfatherInventory> {
  const db = args.db ?? defaultDb;
  const tenantRow = await db.query.tenants.findFirst({
    where: eq(tenants.id, args.tenantId),
    columns: { currentPlan: true },
  });
  const plan = getPlan(tenantRow?.currentPlan);

  const rows: GrandfatherInventoryRow[] = [];

  // recurring_series
  if (!canUse(plan, "recurring_series").allowed) {
    const c = await safeCount(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(bookingSeries)
        .where(
          and(
            eq(bookingSeries.tenantId, args.tenantId),
            eq(bookingSeries.status, "active"),
          ),
        ),
    );
    rows.push({ capability: "recurring_series", count: c });
  }

  // automation_rules
  if (!canUse(plan, "automation_rules").allowed) {
    const c = await safeCount(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(automationRules)
        .where(
          and(
            eq(automationRules.tenantId, args.tenantId),
            eq(automationRules.enabled, true),
          ),
        ),
    );
    rows.push({ capability: "automation_rules", count: c });
  }

  // routing_rules (table is named `staff_assignment_rules`)
  if (!canUse(plan, "routing_rules").allowed) {
    const c = await safeCount(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(staffAssignmentRules)
        .where(
          and(
            eq(staffAssignmentRules.tenantId, args.tenantId),
            eq(staffAssignmentRules.enabled, true),
          ),
        ),
    );
    rows.push({ capability: "routing_rules", count: c });
  }

  // booking_rules — only count ENABLED rules. Disabled rules don't
  // affect the system; surfacing them as grandfathered would inflate
  // the exposure number without operational meaning.
  if (!canUse(plan, "booking_rules").allowed) {
    const c = await safeCount(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(bookingRules)
        .where(
          and(
            eq(bookingRules.tenantId, args.tenantId),
            eq(bookingRules.enabled, true),
          ),
        ),
    );
    rows.push({ capability: "booking_rules", count: c });
  }

  // scheduled_reports
  if (!canUse(plan, "scheduled_reports").allowed) {
    const c = await safeCount(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(scheduledReports)
        .where(eq(scheduledReports.tenantId, args.tenantId)),
    );
    rows.push({ capability: "scheduled_reports", count: c });
  }

  // custom_domains — the count of attached domains beyond what the
  // plan allows is a grandfather marker for downgrade purposes.
  if (!canUse(plan, "custom_domains").allowed) {
    const c = await safeCount(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(tenantDomains)
        .where(eq(tenantDomains.tenantId, args.tenantId)),
    );
    rows.push({ capability: "custom_domains", count: c });
  }

  // hide_powered_by and analytics_export are read-only / one-shot
  // actions, not row-collections. They surface in the capabilities
  // endpoint already; nothing to count here.

  const total = rows.reduce((s, r) => s + r.count, 0);
  return {
    tenantId: args.tenantId,
    currentPlan: plan.id,
    clean: total === 0,
    rows,
  };
}

async function safeCount(
  fn: () => Promise<Array<{ n: number }>>,
): Promise<number> {
  try {
    const r = await fn();
    return Number(r[0]?.n ?? 0);
  } catch (e) {
    console.warn("[grandfathered] count failed (returning 0):", e);
    return 0;
  }
}
