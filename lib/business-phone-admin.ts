// Super-admin Business Phone provisioning — PURE decision logic (Phase 3).
//
// NO database, NO Telnyx, NO Stripe, NO React. Just the validation + state
// machine the super-admin provisioning routes depend on, kept unit-testable.
// The routes are thin I/O shells: they load tenant/phone rows, call these pure
// helpers to decide, then perform the DB writes.
//
// IMPORTANT product policy encoded here: we NEVER buy or call Telnyx. An
// operator provisions/owns the number in Telnyx out-of-band; these helpers only
// validate + record an ALREADY-provisioned number. US/Canada only; emergency/
// N11/international are rejected (reusing the same validator the bridge uses).

import { validateUSCanadaE164 } from "./business-line";
import { maskPhoneNumber } from "./business-line-bridge";
import { ADDON_SUSPENDED_STATUSES } from "./business-phone-addon";

// ── assign input validation ─────────────────────────────────────────────────

export type AssignValidation =
  | { ok: true; businessE164: string; forwardingE164: string; includedMinutes: number }
  | { ok: false; field: "businessPhoneNumber" | "forwardingNumber" | "includedMinutes"; reason: string };

function reasonMessage(reason: string): string {
  switch (reason) {
    case "empty":
      return "This number is required.";
    case "emergency":
      return "Emergency / N11 short codes can't be assigned.";
    case "not_us_canada":
      return "Only US & Canada numbers are supported.";
    case "invalid":
    default:
      return "That doesn't look like a valid US/Canada phone number.";
  }
}

/**
 * Validate the assign payload: both numbers must be US/CA E.164 (no emergency/
 * N11/international), forwarding must differ from the business number, and the
 * optional included-minutes override must be a sane non-negative integer
 * (default 200). Returns normalized E.164 values on success.
 */
export function validateAssignInput(input: {
  businessPhoneNumber: string | null | undefined;
  forwardingNumber: string | null | undefined;
  includedMinutes?: number | null;
}): AssignValidation {
  const biz = validateUSCanadaE164(input.businessPhoneNumber);
  if (!biz.ok) return { ok: false, field: "businessPhoneNumber", reason: reasonMessage(biz.reason) };

  const fwd = validateUSCanadaE164(input.forwardingNumber);
  if (!fwd.ok) return { ok: false, field: "forwardingNumber", reason: reasonMessage(fwd.reason) };

  if (fwd.e164 === biz.e164) {
    return { ok: false, field: "forwardingNumber", reason: "Forwarding number can't be the business number." };
  }

  let includedMinutes = 1000; // single launch plan default (was 200)
  if (input.includedMinutes != null) {
    if (!Number.isInteger(input.includedMinutes) || input.includedMinutes < 0 || input.includedMinutes > 100_000) {
      return { ok: false, field: "includedMinutes", reason: "Included minutes must be a whole number between 0 and 100000." };
    }
    includedMinutes = input.includedMinutes;
  }

  return { ok: true, businessE164: biz.e164, forwardingE164: fwd.e164, includedMinutes };
}

// ── duplicate-number classification ─────────────────────────────────────────

export type NumberAssignmentClass = "insert" | "reactivate" | "conflict_active" | "conflict_other";

/**
 * Decide what to do with an existing tenant_phone_numbers row (looked up by the
 * normalized E.164) when assigning to `tenantId`:
 *   - none                       → insert a new active row
 *   - same tenant                → reactivate/update that row
 *   - other tenant, active       → conflict (already in use)
 *   - other tenant, non-active   → conflict (release it there first; we never
 *                                  silently move a number between tenants)
 */
export function classifyNumberAssignment(
  existing: { tenantId: string; status: string } | null | undefined,
  tenantId: string,
): NumberAssignmentClass {
  if (!existing) return "insert";
  if (existing.tenantId === tenantId) return "reactivate";
  return existing.status === "active" ? "conflict_active" : "conflict_other";
}

// ── setup state machine ─────────────────────────────────────────────────────

export type BusinessPhoneAdminSetupState =
  | "no_addon"
  | "setup_pending"
  | "active"
  | "disabled"
  | "suspended"
  | "cap_reached";

/**
 * Resolve the operator-facing setup state. Precedence: a billing suspension
 * trumps everything (a previously-subscribed tenant whose status went
 * unpaid/canceled); then no add-on; then operator-disabled; then awaiting a
 * number; then cap reached; otherwise active.
 */
export function resolveBusinessPhoneSetupState(args: {
  /** plan AND add-on active (or manual pilot). */
  entitled: boolean;
  numberAssigned: boolean;
  settingsEnabled: boolean;
  /** previously-subscribed but billing now suspended. */
  suspended?: boolean;
  capReached?: boolean;
}): BusinessPhoneAdminSetupState {
  if (args.suspended) return "suspended";
  if (!args.entitled) return "no_addon";
  if (!args.settingsEnabled) return "disabled";
  if (!args.numberAssigned) return "setup_pending";
  if (args.capReached) return "cap_reached";
  return "active";
}

/** Is this subscription status a billing suspension (mirrors the add-on policy)? */
export function isSuspendedSubscriptionStatus(status: string | null | undefined): boolean {
  return ADDON_SUSPENDED_STATUSES.has(String(status ?? "").toLowerCase().trim());
}

// ── enable rules ────────────────────────────────────────────────────────────

/** On assign, the line is enabled only when entitled (or manual pilot) AND both
 *  numbers are present. */
export function assignEnabledState(args: {
  entitledOrManual: boolean;
  hasBusinessNumber: boolean;
  hasForwarding: boolean;
}): boolean {
  return args.entitledOrManual && args.hasBusinessNumber && args.hasForwarding;
}

/** A manual enable (toggle on) requires an active add-on (or manual pilot) AND a
 *  number already assigned. Disabling never needs entitlement. */
export function canManuallyEnable(args: { entitledOrManual: boolean; numberAssigned: boolean }): boolean {
  return args.entitledOrManual && args.numberAssigned;
}

// ── client-facing safe status (Phase 4) ─────────────────────────────────────

/** The safe Business Phone status surfaced to the tenant billing card + Phone
 *  page. Contains NO Stripe IDs, NO Telnyx keys, NO secrets — only booleans,
 *  the masked business number, and minute counters. */
export type BusinessPhoneClientStatus = {
  /** Add-on price configured server-side. When false the whole feature is dark. */
  addonConfigured: boolean;
  /** Plan + add-on active (or manual pilot). */
  entitled: boolean;
  /** Add-on line item present on the subscription (billing). */
  addonSubscribed: boolean;
  subscriptionStatus: string | null;
  /** Tenant has a base subscription we can attach the add-on item to. */
  baseSubscriptionActive: boolean;
  /** Internal/super-admin tenant (subscription_status='internal', no Stripe).
   *  Business Phone is enabled MANUALLY by a super admin — never via Stripe — so
   *  the billing card must not show "Subscribe to a base plan first" or a Stripe
   *  Add button. A normal tenant can never reach this (Stripe never sets the
   *  status to 'internal'). */
  internalAccount: boolean;
  numberAssigned: boolean;
  /** Masked (••• ••• 1234) — never the full number to the client billing card. */
  businessNumberMasked: string | null;
  includedMinutes: number;
  minutesUsed: number;
  capReached: boolean;
  suspended: boolean;
  setupState: BusinessPhoneAdminSetupState;
};

/**
 * Shape the tenant-facing Business Phone status from raw entitlement + usage
 * inputs. PURE + testable. Emits ONLY safe fields (the business number is
 * masked); never a Stripe/Telnyx id or secret.
 */
export function shapeBusinessPhoneStatus(input: {
  planEligible: boolean;
  addonActive: boolean;
  manualSource: boolean;
  addonSubscribed: boolean;
  businessNumber: string | null;
  settingsEnabled: boolean;
  monthlyMinuteCap: number;
  minutesUsed: number;
  subscriptionStatus: string | null | undefined;
  baseSubscriptionActive: boolean;
  addonConfigured: boolean;
}): BusinessPhoneClientStatus {
  const entitled = (input.planEligible && input.addonActive) || input.manualSource;
  const numberAssigned = Boolean(input.businessNumber);
  const capReached = input.monthlyMinuteCap > 0 && input.minutesUsed >= input.monthlyMinuteCap;
  // Internal/super-admin tenant marker. Stripe never sets the status to
  // 'internal' (its values are active/trialing/past_due/canceled/unpaid/
  // incomplete[_expired]/paused), so this can only be a manual grant.
  const internalAccount = String(input.subscriptionStatus ?? "").toLowerCase().trim() === "internal";
  const suspended =
    !entitled && input.addonSubscribed && isSuspendedSubscriptionStatus(input.subscriptionStatus);
  const setupState = resolveBusinessPhoneSetupState({
    entitled,
    numberAssigned,
    settingsEnabled: input.settingsEnabled,
    suspended,
    capReached,
  });
  return {
    addonConfigured: input.addonConfigured,
    entitled,
    addonSubscribed: input.addonSubscribed,
    subscriptionStatus: input.subscriptionStatus ?? null,
    baseSubscriptionActive: input.baseSubscriptionActive,
    internalAccount,
    numberAssigned,
    businessNumberMasked: maskPhoneNumber(input.businessNumber),
    includedMinutes: input.monthlyMinuteCap,
    minutesUsed: input.minutesUsed,
    capReached,
    suspended,
    setupState,
  };
}

// ── Mobile-ready phone status DTO (M1) ──────────────────────────────────────
// Safe payload for GET /api/tenant/phone/status, consumed by the Expo app.
// PURE shaper (the route gathers the inputs). Contains ONLY display-safe fields:
// NO Stripe ids, NO Telnyx ids/keys, NO webhook secrets, NO internal metadata.
// The forwarding number is masked; the business number (the public caller ID) is
// returned in full only to users with phone access, else null.

export type MobilePhoneStatus = {
  /** Plan tier slug (free/solo/pro/team/enterprise). */
  basePlan: string;
  /** Tenant is on a usable PAID base plan (Stripe-active or internal). */
  basePaid: boolean;
  /** Internal/super-admin tenant — managed manually, NO Stripe purchase path. */
  internalAccount: boolean;
  businessPhoneAddonSubscribed: boolean;
  /** Line is provisioned + enabled (active or cap_reached). */
  businessPhoneActive: boolean;
  setupState: BusinessPhoneAdminSetupState;
  /** Public caller-ID number (full) — only when the user has phone access. */
  businessNumber: string | null;
  /** Forwarding/staff number — MASKED — only when the user has phone access. */
  forwardingNumber: string | null;
  includedMinutes: number;
  minutesUsed: number;
  minutesRemaining: number;
  capReached: boolean;
  /** This user may place a click-to-call right now (active, under cap, permitted). */
  canClickToCall: boolean;
  hasPhoneAccess: boolean;
  canPlaceCalls: boolean;
  /** Softphone (Phase 2) — flag-driven, default false until built. */
  softphoneAvailable: boolean;
  /** Where the mobile "Set up / Add on web" CTA should open. */
  webBillingUrl: string;
};

export function shapeMobilePhoneStatus(input: {
  basePlan: string | null;
  /** plan !== free */
  paidPlan: boolean;
  status: BusinessPhoneClientStatus;
  /** Full numbers from getTenantBusinessPhone; gated/masked here. */
  businessNumber: string | null;
  forwardingNumber: string | null;
  hasPhoneAccess: boolean;
  canPlaceCalls: boolean;
  softphoneAvailable: boolean;
  webBillingUrl: string;
}): MobilePhoneStatus {
  const s = input.status;
  const basePaid = input.paidPlan && (s.baseSubscriptionActive || s.internalAccount);
  const businessPhoneActive = s.setupState === "active" || s.setupState === "cap_reached";
  const canClickToCall = s.setupState === "active" && input.canPlaceCalls && !s.capReached;
  const minutesRemaining = Math.max(0, s.includedMinutes - s.minutesUsed);
  return {
    basePlan: input.basePlan ?? "free",
    basePaid,
    internalAccount: s.internalAccount,
    businessPhoneAddonSubscribed: s.addonSubscribed,
    businessPhoneActive,
    setupState: s.setupState,
    businessNumber: input.hasPhoneAccess ? input.businessNumber : null,
    forwardingNumber: input.hasPhoneAccess ? maskPhoneNumber(input.forwardingNumber) : null,
    includedMinutes: s.includedMinutes,
    minutesUsed: s.minutesUsed,
    minutesRemaining,
    capReached: s.capReached,
    canClickToCall,
    hasPhoneAccess: input.hasPhoneAccess,
    canPlaceCalls: input.canPlaceCalls,
    softphoneAvailable: input.softphoneAvailable,
    webBillingUrl: input.webBillingUrl,
  };
}
