/**
 * Pure, framework-free Business Phone helpers for the mobile app (P1.3) — the
 * gating, US/Canada dial validation, dial formatting, keypad rules, and
 * error/success copy used by the Phone tab. Mirrors the web's lib/business-line
 * + lib/business-phone-ui so client behavior matches; backend validation stays
 * the source of truth. NO React, NO network.
 */

// ── NANP (US/Canada) phone validation (mirrors web lib/business-line) ──

const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const EMERGENCY_NUMBERS = new Set<string>([
  "911", "112", "999", "000", "111", "933", // emergency (intl)
  "211", "311", "411", "511", "611", "711", "811", // N11 service codes
]);

export type PhoneValidationReason = "empty" | "emergency" | "not_us_canada" | "invalid";

export function normalizeE164Phone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

export function isEmergencyNumber(input: string | null | undefined): boolean {
  if (!input) return false;
  const digits = input.replace(/\D/g, "");
  if (!digits) return false;
  if (EMERGENCY_NUMBERS.has(digits)) return true;
  if (digits.startsWith("1") && EMERGENCY_NUMBERS.has(digits.slice(1))) return true;
  return false;
}

export type DialValidation =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneValidationReason; message: string };

/** Validate the New-Call input fail-closed (US/CA E.164, no emergency/N11). */
export function validateDialInput(input: string | null | undefined): DialValidation {
  if (!input || !input.trim()) return { ok: false, reason: "empty", message: dialErrorMessage("empty") };
  if (isEmergencyNumber(input)) return { ok: false, reason: "emergency", message: dialErrorMessage("emergency") };
  const e164 = normalizeE164Phone(input);
  if (!e164) return { ok: false, reason: "empty", message: dialErrorMessage("empty") };
  if (!NANP_E164.test(e164)) {
    const reason: PhoneValidationReason = e164.startsWith("+1") ? "invalid" : "not_us_canada";
    return { ok: false, reason, message: dialErrorMessage(reason) };
  }
  return { ok: true, e164 };
}

function dialErrorMessage(reason: PhoneValidationReason): string {
  switch (reason) {
    case "empty":
      return "Enter a phone number to call.";
    case "emergency":
      return "Emergency and service numbers can't be dialed.";
    case "not_us_canada":
      return "Only US and Canada numbers can be dialed.";
    case "invalid":
    default:
      return "Enter a valid US or Canada phone number.";
  }
}

// ── Display formatting (non-mutating preview) ──

export function formatNanpForDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Read-only "will dial" preview; null unless the input is already valid. */
export function dialPreview(raw: string | null | undefined): string | null {
  const v = validateDialInput(raw);
  return v.ok ? formatNanpForDisplay(v.e164) : null;
}

// ── Keypad (US/CA only → no ✱ / #) ──

export const KEYPAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;
const UNSUPPORTED_KEYPAD_KEYS = ["*", "#"];

export function isSupportedKeypadKey(key: string): boolean {
  return !UNSUPPORTED_KEYPAD_KEYS.includes(key);
}

// ── Visibility / gating ──

/** Show the Phone tab only when subscribed AND the user has phone access. */
export function shouldShowPhoneTab(bp: {
  entitled?: boolean;
  hasPhoneAccess?: boolean;
} | null | undefined): boolean {
  return bp?.entitled === true && bp?.hasPhoneAccess === true;
}

/** Whether to show a "Call via Business Phone" action on a customer. */
export function canShowCustomerCallButton(args: {
  entitled: boolean;
  canPlaceCalls: boolean;
  phone: string | null | undefined;
}): boolean {
  return (
    args.entitled === true &&
    args.canPlaceCalls === true &&
    typeof args.phone === "string" &&
    args.phone.trim() !== ""
  );
}

/**
 * Full gate for the customer-detail "Call via Business Phone" action (P1.3.1):
 * the tenant must be entitled, the user must have phone access AND be able to
 * place calls, and the customer must have a US/Canada-valid phone number. Hidden
 * (false) otherwise — no locked button, no upsell.
 */
export function canCallCustomerViaBusinessPhone(
  bp: { entitled?: boolean; hasPhoneAccess?: boolean; canPlaceCalls?: boolean } | null | undefined,
  phone: string | null | undefined,
): boolean {
  if (bp?.entitled !== true || bp?.hasPhoneAccess !== true || bp?.canPlaceCalls !== true) return false;
  if (!phone || phone.trim() === "") return false;
  return validateDialInput(phone).ok;
}

// ── Outbound call messaging ──

export const OUTBOUND_CALL_SUCCESS_MESSAGE =
  "We're calling your phone first. Answer to connect the business call.";

export function buildCallBackPayload(
  fromNumber: string | null | undefined,
): { toNumber: string; callPurpose: "callback_missed" } | null {
  if (!fromNumber || fromNumber.trim() === "") return null;
  return { toNumber: fromNumber.trim(), callPurpose: "callback_missed" };
}

/**
 * Map an API failure to clear copy (matches the web). Prefers the server's
 * tailored message; falls back per status — setup_required/over_cap (409),
 * no_entitlement (402), staff_disabled (403), concurrency (429),
 * service_unavailable (503), invalid/emergency (400).
 */
export function phoneCallErrorMessage(status: number, serverMessage?: string | null): string {
  const msg = serverMessage && serverMessage.trim() !== "" ? serverMessage.trim() : null;
  switch (status) {
    case 402:
      return msg ?? "The Business Phone add-on isn't active on your plan.";
    case 403:
      return msg ?? "You do not have permission to place Business Phone calls.";
    case 404:
      return msg ?? "We couldn't find that contact.";
    case 429:
      return msg ?? "Too many calls in progress. Try again in a moment.";
    case 503:
      return msg ?? "Business Phone calling is temporarily unavailable.";
    case 400:
    case 409:
      return msg ?? "We couldn't place that call. Check the number and your settings.";
    default:
      return msg ?? "Couldn't place the call right now. Please try again.";
  }
}

// ── Mobile Business Phone status + screen-state machine (M2) ─────────────────
// PURE — no React, no API client, no secrets. Mirrors the safe DTO returned by
// GET /api/tenant/phone/status. Mobile NEVER sells/activates the add-on; the
// only purchase path is opening the web billing page.

export type BusinessPhoneSetupState =
  | "no_addon"
  | "setup_pending"
  | "active"
  | "disabled"
  | "suspended"
  | "cap_reached";

export type MobilePhoneStatus = {
  basePlan: string;
  basePaid: boolean;
  businessPhoneAddonSubscribed: boolean;
  businessPhoneActive: boolean;
  setupState: BusinessPhoneSetupState;
  businessNumber: string | null;
  forwardingNumber: string | null;
  includedMinutes: number;
  minutesUsed: number;
  minutesRemaining: number;
  capReached: boolean;
  canClickToCall: boolean;
  hasPhoneAccess: boolean;
  canPlaceCalls: boolean;
  softphoneAvailable: boolean;
  webBillingUrl: string;
};

/** Which Phone screen the mobile app should render for a given status. */
export type PhoneScreenState =
  /** Not subscribed → info/marketing only; the CTA opens web billing. */
  | { kind: "marketing"; cta: "setup_web" | "add_web"; webBillingUrl: string }
  /** Add-on active but no number yet → "setup pending", no controls. */
  | { kind: "setup_pending" }
  /** Live → show number/forwarding/usage/logs; dialer enabled iff canClickToCall. */
  | { kind: "active"; canClickToCall: boolean }
  /** Provisioned but this month's minutes are used up → block outbound. */
  | { kind: "cap_reached" }
  /** Operator-disabled or billing-suspended → locked, no controls. */
  | { kind: "locked"; reason: "disabled" | "suspended" };

/**
 * Map the safe status DTO to a mobile screen state. PURE + exhaustive.
 *   - no_addon + not paid base  → marketing, "Set up on web"
 *   - no_addon + paid base      → marketing, "Add Business Phone on web"
 *   - setup_pending             → setup pending (no controls)
 *   - active                    → active (dialer gated by canClickToCall)
 *   - cap_reached               → cap reached (outbound blocked)
 *   - disabled / suspended      → locked
 */
export function resolvePhoneScreenState(s: MobilePhoneStatus): PhoneScreenState {
  switch (s.setupState) {
    case "active":
      return { kind: "active", canClickToCall: s.canClickToCall };
    case "cap_reached":
      return { kind: "cap_reached" };
    case "setup_pending":
      return { kind: "setup_pending" };
    case "disabled":
      return { kind: "locked", reason: "disabled" };
    case "suspended":
      return { kind: "locked", reason: "suspended" };
    case "no_addon":
    default:
      return { kind: "marketing", cta: s.basePaid ? "add_web" : "setup_web", webBillingUrl: s.webBillingUrl };
  }
}

/** Softphone tab/menu may appear ONLY when the line is active AND the backend
 *  flag says the softphone is available. Default (flag off) → never. */
export function shouldShowSoftphone(s: MobilePhoneStatus): boolean {
  return s.businessPhoneActive && s.softphoneAvailable;
}

/** The Business Phone entry is shown to ALL signed-in users (marketing for the
 *  non-entitled; functional screen for the entitled). */
export function shouldShowPhoneEntry(): boolean {
  return true;
}

/** Label for the web CTA button on the marketing screen. */
export function webCtaLabel(cta: "setup_web" | "add_web"): string {
  return cta === "add_web" ? "Add Business Phone on web" : "Set up on web";
}

/** Marketing copy for the non-subscribed info screen (honest — softphone is
 *  "coming soon", emergency + international excluded).
 *
 *  Single launch plan: $29/month, 1,000 US & Canada minutes. This matches the
 *  new provisioning default (lib/business-line.ts BUSINESS_LINE_DEFAULT_PACKAGE
 *  + lib/business-phone-admin.ts + db/schema.ts default = 1000) and the web card
 *  (lib/business-phone-ui.ts BUSINESS_PHONE_ADDON_CARD). NOTE: pre-existing
 *  pilots provisioned before this change (e.g. docs-demo at 200) keep their cap;
 *  the active/setup screens show the REAL per-tenant cap via status.includedMinutes. */
export const BUSINESS_PHONE_MARKETING = {
  title: "Business Phone",
  headline: "Give your business a dedicated line for client calls.",
  price: "$29/month",
  minutes: "1,000 US & Canada minutes included",
  features: [
    "Dedicated business number",
    "Forward calls to your phone",
    "Click-to-call from ZentroMeet",
    "Track call logs and usage",
    "Keep personal numbers private",
    "Softphone — coming soon",
  ],
  limitations: [
    "No emergency (911) calling",
    "No international calls",
    "No surprise overage billing — usage is capped",
  ],
  note: "Business Phone is set up on the ZentroMeet web app — you can't purchase it in the mobile app.",
} as const;

/** Honest one-liner for the active screen (NOT a softphone). */
export const CLICK_TO_CALL_NOTE =
  "Calls ring your phone first, then connect the customer. There's no in-app audio.";
