/**
 * Centralized plan-capability layer.
 *
 * Single source of truth for "which plan unlocks which feature?". Every
 * paid-feature write endpoint MUST call the matching assert helper
 * before mutating state. The helpers throw HttpError(402, ...) when
 * the current plan doesn't meet the required tier.
 *
 * Design contract:
 *   - Pure functions over `Plan` / `PlanId`. No DB calls, no I/O.
 *   - Closed `Capability` union — adding a new capability requires
 *     declaring it here AND wiring an assert at every write site.
 *   - `assertCanX(plan)` always throws on failure; never returns.
 *   - Reads use the boolean `canX(plan)` variant when the caller
 *     needs to branch UI without throwing.
 *
 * IMPORTANT — grandfather semantics:
 *   These helpers gate WRITES (POST/PUT/PATCH/DELETE). They do NOT
 *   delete existing rows on downgrade. A Free tenant who saved a
 *   recurring series on a Pro trial keeps that series in the DB; the
 *   cron continues to materialize it. The block fires only when they
 *   try to CREATE or EDIT after downgrade. This matches the user's
 *   stated tradeoff: hard-enforce on writes, grandfather existing
 *   working data.
 *
 * To enforce cron-time gating too (so existing rows stop firing on
 * downgrade), a separate "cron-skip" layer ships in a follow-up.
 */
import { HttpError } from "@/lib/auth";
import { type Plan, type PlanId, meetsPlan } from "@/lib/plans";

// ─── Closed taxonomy ─────────────────────────────────────────────────
//
// Each capability declares the minimum plan tier that unlocks WRITE
// access. UI may use a richer matrix for visibility; this module is
// the runtime enforcement boundary.

export type Capability =
  | "recurring_series"     // POST /api/tenant/booking-series
  | "automation_rules"     // POST /api/tenant/automations
  | "routing_rules"        // PUT  /api/tenant/routing-rules
  | "booking_rules"        // PUT  /api/tenant/booking-rules
  | "scheduled_reports"    // POST /api/tenant/scheduled-reports
  | "custom_domains"       // POST /api/tenant/domains          (already gated via plan.limits.maxCustomDomains)
  | "hide_powered_by"      // PATCH /api/tenant/integrations   (already gated via plan.limits.customBranding)
  | "analytics_export"     // POST /api/tenant/analytics/export
  | "business_line";       // Business Line add-on (plan gate; add-on activation is a separate flag)

/**
 * Minimum plan tier per capability. Single source of truth — the UI
 * locks shipped in Phase 16K reference the same table.
 *
 * Honest note on existing tenants: these tiers represent the policy
 * going forward. Tenants with rows that pre-date enforcement keep
 * those rows; new writes by Free-plan tenants are blocked.
 */
const REQUIRED_PLAN: Record<Capability, PlanId> = {
  recurring_series: "pro",
  automation_rules: "pro",
  routing_rules: "pro",
  booking_rules: "pro",
  scheduled_reports: "pro",
  custom_domains: "pro",
  hide_powered_by: "pro",
  analytics_export: "pro",
  // Business Line add-on requires a Pro+ plan AND an active add-on flag (the
  // add-on activation is gated separately in lib/business-line-view.ts).
  business_line: "pro",
};

/**
 * Human-readable label per capability — used in 402 messages so the
 * client renders an honest upgrade prompt without exposing internal
 * code names.
 */
const LABEL: Record<Capability, string> = {
  recurring_series: "Recurring scheduling",
  automation_rules: "Workflow automations",
  routing_rules: "Staff routing rules",
  booking_rules: "Booking rules",
  scheduled_reports: "Scheduled reports",
  custom_domains: "Custom domains",
  hide_powered_by: "Branding removal",
  analytics_export: "Analytics export",
  business_line: "Business phone line",
};

// ─── Public API ──────────────────────────────────────────────────────

export type CapabilityCheck = {
  allowed: boolean;
  capability: Capability;
  /** Plan that the tenant currently has. */
  currentPlan: PlanId;
  /** Plan required to unlock this capability. */
  requiredPlan: PlanId;
  /** Customer-facing reason string, safe to surface in UI. */
  reason: string;
};

/**
 * Read-only check — does this plan unlock the given capability?
 *
 * Use this in code paths that need to branch UI or behavior without
 * raising an error. Routes that MUST reject should call the matching
 * `assertCanX()` helper instead.
 */
export function canUse(plan: Plan, capability: Capability): CapabilityCheck {
  const required = REQUIRED_PLAN[capability];
  const allowed = meetsPlan(plan.id, required);
  const label = LABEL[capability];
  return {
    allowed,
    capability,
    currentPlan: plan.id,
    requiredPlan: required,
    reason: allowed
      ? `${label} is included in the ${plan.name} plan.`
      : `${label} is available on ${capitalizePlan(required)} and above. Your workspace is currently on the ${plan.name} plan.`,
  };
}

/**
 * Throws HttpError(402) when the plan doesn't unlock the capability.
 * Use this at the top of every paid-feature write handler.
 *
 *   const tenant = await db.query.tenants.findFirst({ ... });
 *   const plan = getPlan(tenant?.currentPlan);
 *   assertCanUse(plan, "recurring_series");
 *   // ... mutate ...
 */
export function assertCanUse(plan: Plan, capability: Capability): void {
  const check = canUse(plan, capability);
  if (!check.allowed) {
    throw new HttpError(402, check.reason);
  }
}

// ─── Per-capability convenience wrappers ─────────────────────────────
//
// Identical behavior to assertCanUse(plan, "x") — the named wrappers
// exist so grep "assertCanCreateRecurringSeries" finds every enforcement
// site immediately, which the broad helper would not.

export const canCreateRecurringSeries = (plan: Plan) => canUse(plan, "recurring_series");
export const assertCanCreateRecurringSeries = (plan: Plan) => assertCanUse(plan, "recurring_series");

export const canCreateAutomationRule = (plan: Plan) => canUse(plan, "automation_rules");
export const assertCanCreateAutomationRule = (plan: Plan) => assertCanUse(plan, "automation_rules");

export const canWriteRoutingRule = (plan: Plan) => canUse(plan, "routing_rules");
export const assertCanWriteRoutingRule = (plan: Plan) => assertCanUse(plan, "routing_rules");

export const canWriteBookingRule = (plan: Plan) => canUse(plan, "booking_rules");
export const assertCanWriteBookingRule = (plan: Plan) => assertCanUse(plan, "booking_rules");

export const canCreateScheduledReport = (plan: Plan) => canUse(plan, "scheduled_reports");
export const assertCanCreateScheduledReport = (plan: Plan) => assertCanUse(plan, "scheduled_reports");

export const canExportAnalytics = (plan: Plan) => canUse(plan, "analytics_export");
export const assertCanExportAnalytics = (plan: Plan) => assertCanUse(plan, "analytics_export");

// Business Line add-on — PLAN gate only. The add-on activation flag is a
// separate gate (resolveBusinessLineEntitlement); both must pass to unlock.
export const canUseBusinessLine = (plan: Plan) => canUse(plan, "business_line");
export const assertCanUseBusinessLine = (plan: Plan) => assertCanUse(plan, "business_line");

// ─── Snapshot for API responses ──────────────────────────────────────

/**
 * Returns the full capability map for the given plan. Useful for GET
 * endpoints that want to surface plan-locked actions to the client
 * without each route having to compute its own snapshot.
 */
export function capabilitySnapshot(plan: Plan): Record<Capability, CapabilityCheck> {
  const out = {} as Record<Capability, CapabilityCheck>;
  (Object.keys(REQUIRED_PLAN) as Capability[]).forEach((cap) => {
    out[cap] = canUse(plan, cap);
  });
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function capitalizePlan(id: PlanId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
