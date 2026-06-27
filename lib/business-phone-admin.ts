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

  let includedMinutes = 200;
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
