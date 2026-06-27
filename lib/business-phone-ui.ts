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
