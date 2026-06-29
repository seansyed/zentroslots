// Pure shaping + entitlement + validation helpers for the Business Line
// settings surface (increment 3). NO database, NO Telnyx, NO React — just the
// logic the GET/PATCH route and the dashboard depend on, kept unit-testable.
//
// Entitlement is a SAFE PLACEHOLDER: default-LOCKED until a real Stripe-driven
// add-on lands in a later increment. It never blocks the page from rendering —
// the UI shows a locked/upgrade state.

import {
  validateUSCanadaE164,
  isForwardingLoop,
  secondsToBillableMinutes,
  BUSINESS_LINE_DEFAULT_PACKAGE,
  type PhoneValidationReason,
} from "./business-line";
import type { PlanId } from "./plans";

// ─── Entitlement (real add-on model; NO live Stripe) ────────────────────────
//
// Two gates, BOTH required to unlock:
//   1. PLAN gate   — the tenant's plan meets the Business Line capability tier
//                    (Pro+, via canUse(plan, "business_line")). Callers pass the
//                    result in as `planEligible`.
//   2. ADD-ON gate — the paid add-on is explicitly active for the tenant. Stored
//                    as `entitlementActive: true` in the settings-row metadata; a
//                    future Stripe add-on webhook flips it. No Stripe call here.
// Default LOCKED unless BOTH pass. The included minutes + $/mo come from the
// data-model package default (no metered overage in MVP — hard cap instead).

export type BusinessLineEntitlementReason = "active" | "addon_inactive" | "plan_not_eligible";

export type BusinessLineEntitlement = {
  active: boolean;
  locked: boolean;
  reason: BusinessLineEntitlementReason;
  requiredPlan: PlanId;
  includedMinutes: number;
  monthlyPriceCents: number;
  hardCapMinutes: number;
};

/** The add-on activation flag — what a future Stripe add-on webhook would set. */
export function readAddonActiveFlag(settingsMetadata: unknown): boolean {
  return isRecord(settingsMetadata) && settingsMetadata.entitlementActive === true;
}

export function resolveBusinessLineEntitlement(args: {
  /** canUse(plan, "business_line").allowed — the Pro+ plan gate. */
  planEligible: boolean;
  /** readAddonActiveFlag(settings.metadata) — the add-on activation gate. */
  addonActive: boolean;
  /** Display-only; defaults to the capability's required tier. */
  requiredPlan?: PlanId;
}): BusinessLineEntitlement {
  const base = {
    requiredPlan: args.requiredPlan ?? ("pro" as PlanId),
    includedMinutes: BUSINESS_LINE_DEFAULT_PACKAGE.includedMinutes,
    monthlyPriceCents: BUSINESS_LINE_DEFAULT_PACKAGE.monthlyPriceCents,
    hardCapMinutes: BUSINESS_LINE_DEFAULT_PACKAGE.hardCapMinutes,
  };
  if (!args.planEligible) return { active: false, locked: true, reason: "plan_not_eligible", ...base };
  if (!args.addonActive) return { active: false, locked: true, reason: "addon_inactive", ...base };
  return { active: true, locked: false, reason: "active", ...base };
}

/** Single source for the locked/upgrade UI copy ("$29/month · 1,000 minutes"). */
export function businessLineAddonCopy(e: BusinessLineEntitlement): {
  title: string;
  price: string;
  minutes: string;
  reasonText: string;
} {
  return {
    title: "Business Phone add-on",
    price: `$${Math.round(e.monthlyPriceCents / 100)}/month`,
    minutes: `${e.includedMinutes.toLocaleString("en-US")} US/Canada minutes`,
    reasonText:
      e.reason === "plan_not_eligible"
        ? `Available on ${capitalize(e.requiredPlan)} and above.`
        : e.reason === "addon_inactive"
          ? "Add this paid add-on to activate."
          : "Active.",
  };
}

/**
 * PATCH gate. When the entitlement is inactive (locked), only DISABLING
 * (enabled=false) or CLEARING the forwarding number is permitted — never
 * enabling forwarding or setting a forwarding number. Active → anything.
 */
export function evaluateBusinessLinePatchGate(args: {
  entitlementActive: boolean;
  setsEnabledTrue: boolean;
  setsNonEmptyForwarding: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
  if (args.entitlementActive) return { allowed: true };
  if (args.setsEnabledTrue || args.setsNonEmptyForwarding) {
    return { allowed: false, reason: "The Business Line add-on isn't active on your plan." };
  }
  return { allowed: true };
}

// ─── Forwarding-number update validation ────────────────────────────────────

export type ForwardingUpdateResult =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneValidationReason | "loop" };

/**
 * Validate a forwarding-number update: must be a valid US/Canada E.164 (not an
 * emergency/N11 code) AND must not equal any of the tenant's own business-line
 * numbers (forwarding loop). Composes the increment-1 pure helpers. Callers that
 * want to CLEAR the number should handle empty/null before calling this.
 */
export function validateForwardingUpdate(args: {
  forwardingNumber: string | null | undefined;
  ownedNumbers: Iterable<string | null | undefined>;
}): ForwardingUpdateResult {
  const v = validateUSCanadaE164(args.forwardingNumber);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (isForwardingLoop(v.e164, args.ownedNumbers)) return { ok: false, reason: "loop" };
  return { ok: true, e164: v.e164 };
}

/** A human-readable message for a forwarding validation failure. */
export function forwardingErrorMessage(reason: PhoneValidationReason | "loop"): string {
  switch (reason) {
    case "empty":
      return "Enter a forwarding number.";
    case "emergency":
      return "Emergency or service numbers (e.g. 911) can't be used.";
    case "not_us_canada":
      return "Only US and Canada numbers are supported.";
    case "loop":
      return "The forwarding number can't be your own business line.";
    case "invalid":
    default:
      return "Enter a valid US or Canada phone number.";
  }
}

// ─── Monthly usage summary ──────────────────────────────────────────────────

/** Current billing period ('YYYY-MM') for a given date, in UTC. */
export function periodForDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export type UsageSummary = {
  period: string;
  minutesUsed: number;
  includedMinutes: number;
  cap: number;
  inboundCalls: number;
  answeredCalls: number;
  missedCalls: number;
  percentUsed: number; // 0..100, clamped
  overCap: boolean;
  estimatedCostCents: number;
};

export function summarizeMonthlyUsage(args: {
  period: string;
  usage?: {
    billableSeconds?: number | null;
    inboundCalls?: number | null;
    answeredCalls?: number | null;
    missedCalls?: number | null;
    estimatedCostCents?: number | null;
  } | null;
  includedMinutes: number;
  cap: number;
}): UsageSummary {
  const u = args.usage ?? {};
  const minutesUsed = secondsToBillableMinutes(u.billableSeconds ?? 0);
  const cap = args.cap > 0 ? args.cap : args.includedMinutes;
  const percentUsed = cap > 0 ? Math.min(100, Math.round((minutesUsed / cap) * 100)) : 0;
  return {
    period: args.period,
    minutesUsed,
    includedMinutes: args.includedMinutes,
    cap,
    inboundCalls: u.inboundCalls ?? 0,
    answeredCalls: u.answeredCalls ?? 0,
    missedCalls: u.missedCalls ?? 0,
    percentUsed,
    overCap: cap > 0 && minutesUsed >= cap,
    estimatedCostCents: u.estimatedCostCents ?? 0,
  };
}

// ─── Call-log shaping ───────────────────────────────────────────────────────

export type CallLogView = {
  id: string;
  direction: string;
  fromNumber: string | null;
  status: string;
  startedAt: string | null; // ISO
  durationSeconds: number | null;
  missed: boolean;
};

export function shapeCallLog(row: {
  id: string;
  direction: string;
  fromNumber: string | null;
  status: string;
  startedAt: Date | string | null;
  durationSeconds: number | null;
}): CallLogView {
  return {
    id: row.id,
    direction: row.direction,
    fromNumber: row.fromNumber,
    status: row.status,
    startedAt: toIso(row.startedAt),
    durationSeconds: row.durationSeconds ?? null,
    missed: row.status === "missed" || row.status === "no_forwarding",
  };
}

// ─── Full GET response shape ────────────────────────────────────────────────

export type BusinessLineView = {
  entitlement: BusinessLineEntitlement;
  number: { phoneNumber: string; status: string; provisionedAt: string | null } | null;
  settings: {
    enabled: boolean;
    forwardingNumber: string | null;
    includedMinutes: number;
    monthlyMinuteCap: number;
  };
  usage: UsageSummary;
  recentCalls: CallLogView[];
};

export function shapeBusinessLineView(input: {
  /** canUse(plan, "business_line").allowed — resolved by the route from the
   *  tenant's plan. The add-on activation gate is read from settings.metadata. */
  planEligible: boolean;
  number?: { phoneNumber: string; status: string; provisionedAt: Date | string | null } | null;
  settings?: {
    enabled: boolean;
    forwardingNumber: string | null;
    includedMinutes: number;
    monthlyMinuteCap: number;
    metadata?: unknown;
  } | null;
  usage?: {
    billableSeconds?: number | null;
    inboundCalls?: number | null;
    answeredCalls?: number | null;
    missedCalls?: number | null;
    estimatedCostCents?: number | null;
  } | null;
  recentCalls?: Array<{
    id: string;
    direction: string;
    fromNumber: string | null;
    status: string;
    startedAt: Date | string | null;
    durationSeconds: number | null;
  }>;
  period: string;
}): BusinessLineView {
  const settings = input.settings ?? null;
  const includedMinutes = settings?.includedMinutes ?? BUSINESS_LINE_DEFAULT_PACKAGE.includedMinutes;
  const cap = settings?.monthlyMinuteCap ?? BUSINESS_LINE_DEFAULT_PACKAGE.hardCapMinutes;
  return {
    entitlement: resolveBusinessLineEntitlement({
      planEligible: input.planEligible,
      addonActive: readAddonActiveFlag(settings?.metadata),
    }),
    number: input.number
      ? {
          phoneNumber: input.number.phoneNumber,
          status: input.number.status,
          provisionedAt: toIso(input.number.provisionedAt),
        }
      : null,
    settings: {
      enabled: settings?.enabled ?? false,
      forwardingNumber: settings?.forwardingNumber ?? null,
      includedMinutes,
      monthlyMinuteCap: cap,
    },
    usage: summarizeMonthlyUsage({ period: input.period, usage: input.usage, includedMinutes, cap }),
    recentCalls: (input.recentCalls ?? []).map(shapeCallLog),
  };
}

// ─── internals ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : null;
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
