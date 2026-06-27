// Pure, framework-free helpers for the Business Phone web UI (P1.2). Kept out of
// the React components so the gating + validation + error-mapping logic is
// unit-testable (the repo has no React test runner). NO DB, NO Telnyx, NO React.

import { validateUSCanadaE164, type PhoneValidationReason } from "./business-line";

// ─── Visibility ─────────────────────────────────────────────────────────────

/**
 * Whether to show the "Phone" sidebar item / page (P1.2.1). Requires tenant
 * `entitled` (Pro+ plan AND active add-on). Operators (admin/manager) always
 * qualify; staff qualify only when they have Business Phone access
 * (`hasPhoneAccess` — an enabled, can-place staff identity granted by an admin).
 * Fail-closed: anything else, or a missing flag, → hidden.
 */
export function shouldShowPhoneNav(args: {
  entitled: boolean;
  role: string;
  hasPhoneAccess?: boolean;
}): boolean {
  if (args.entitled !== true) return false;
  if (args.role === "admin" || args.role === "manager") return true;
  if (args.role === "staff") return args.hasPhoneAccess === true;
  return false;
}

/**
 * Whether to show the "Call via Business Phone" button on a customer. Requires
 * the tenant entitled, the current user able to place calls right now
 * (`canPlaceCalls`), and the customer to have a phone number.
 */
/**
 * Whether the user may view + manage the Staff Phone Access admin section
 * (P1.2.2). Operators only (admin/manager); staff/client never. The page itself
 * is already entitlement-gated, so this is the role axis only.
 */
export function canManageStaffAccess(role: string): boolean {
  return role === "admin" || role === "manager";
}

/** Admin copy for the Staff Phone Access section — privacy + caller-ID promise. */
export const STAFF_PHONE_PRIVACY_NOTE =
  "Staff phone numbers are used only to connect staff to outbound Business Phone calls. Customers see your ZentroMeet business number.";

// ─── Business Phone page tabs (P1.2.A relabel) ──────────────────────────────
//
// The deployed Phase 1 feature is inbound forwarding + a bridge "click-to-call"
// — it is NOT a softphone (you can't talk in the browser yet). These tabs keep
// the labels honest: the real in-browser softphone is Phase 2 (not available).

export const BUSINESS_PHONE_TABS = ["forwarding", "click_to_call", "softphone"] as const;
export type BusinessPhoneTab = (typeof BUSINESS_PHONE_TABS)[number];

export function businessPhoneTabLabel(tab: BusinessPhoneTab): string {
  switch (tab) {
    case "forwarding":
      return "Forwarding";
    case "click_to_call":
      return "Click-to-Call";
    case "softphone":
      return "Softphone";
  }
}

/** Honest one-liner for the click-to-call flow — makes clear it is NOT a softphone. */
export const CLICK_TO_CALL_EXPLAINER =
  "ZentroMeet calls your phone first, then connects the customer — you talk on your phone, not in the browser.";

/** Placeholder copy for the not-yet-built browser softphone (Phase 2). */
export const SOFTPHONE_COMING_COPY =
  "Talk to customers directly in your browser — no second phone needed. Coming in Phase 2; not available yet.";

/**
 * Billing-page card copy for the Business Phone add-on (Phase 2 prep — defined
 * here, pure, so the Phase 4 UI just renders it). Honest: the softphone is
 * "coming soon", NOT available; emergency + international calling are excluded.
 */
export const BUSINESS_PHONE_ADDON_CARD = {
  title: "Business Phone",
  price: "$19/month",
  features: [
    "200 US & Canada minutes included",
    "Inbound call forwarding to your phone",
    "Click-to-call from ZentroMeet (rings your phone first)",
    "Call logs and monthly usage",
    "Softphone — coming soon",
  ],
  limitations: ["No emergency (911) calling", "No international calls"],
} as const;

/**
 * Display label for a staff member's bridge number in the admin table. NEVER
 * returns a full number — only the masked form or "Not set" — so a personal
 * number can't leak into the UI.
 */
export function staffPhoneNumberLabel(args: { configured: boolean; masked: string | null }): string {
  return args.configured && args.masked ? args.masked : "Not set";
}

/** Status label for a staff member's access state. */
export function staffAccessStatusLabel(args: { enabled: boolean; canPlaceCalls: boolean }): string {
  if (!args.enabled) return "Disabled";
  if (!args.canPlaceCalls) return "Cannot place calls";
  return "Active";
}

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

// ─── Dial input validation ──────────────────────────────────────────────────

export type DialValidation =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneValidationReason; message: string };

/** Validate the New-Call input fail-closed (US/CA E.164, no emergency/N11). */
export function validateDialInput(raw: string | null | undefined): DialValidation {
  const v = validateUSCanadaE164(raw);
  if (v.ok) return { ok: true, e164: v.e164 };
  return { ok: false, reason: v.reason, message: dialErrorMessage(v.reason) };
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

// ─── Display formatting (safe, non-mutating) ────────────────────────────────

/** Pretty-print a NANP E.164 (+1XXXXXXXXXX) as "+1 (XXX) XXX-XXXX". */
export function formatNanpForDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * A read-only "will dial" preview for whatever the user has typed. Returns null
 * unless the raw input already normalizes to a valid US/CA number — so this
 * never mutates the field or fights the cursor, it just shows the resolved
 * number. Backend validation remains the source of truth.
 */
export function dialPreview(raw: string | null | undefined): string | null {
  const v = validateDialInput(raw);
  return v.ok ? formatNanpForDisplay(v.e164) : null;
}

/** Characters the MVP keypad must NOT insert (US/CA dialing only). */
export const UNSUPPORTED_KEYPAD_KEYS = ["*", "#"] as const;

/** Whether a keypad key may be appended to the dial field in the MVP. */
export function isSupportedKeypadKey(key: string): boolean {
  return !(UNSUPPORTED_KEYPAD_KEYS as readonly string[]).includes(key);
}

// ─── Outbound call messaging ────────────────────────────────────────────────

/** Shown on a successful bridge initiation — sets the staff's expectation. */
export const OUTBOUND_CALL_SUCCESS_MESSAGE =
  "We're calling your phone first. Answer to connect the business call.";

/** Build the Call-Back payload for a missed inbound caller. */
export function buildCallBackPayload(
  fromNumber: string | null | undefined,
): { toNumber: string; callPurpose: "callback_missed" } | null {
  if (!fromNumber || fromNumber.trim() === "") return null;
  return { toNumber: fromNumber.trim(), callPurpose: "callback_missed" };
}

/**
 * Map an API failure to a clear, customer-facing message. The server already
 * returns tailored copy (bridgeRejectToHttp), so we PREFER it and only fall back
 * per status — covering setup_required/over_cap (409), no_entitlement (402),
 * staff_disabled (403), concurrency (429), service unavailable (503), and
 * invalid/emergency (400).
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
