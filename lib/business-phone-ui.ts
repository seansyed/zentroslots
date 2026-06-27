// Pure, framework-free helpers for the Business Phone web UI (P1.2). Kept out of
// the React components so the gating + validation + error-mapping logic is
// unit-testable (the repo has no React test runner). NO DB, NO Telnyx, NO React.

import { validateUSCanadaE164, type PhoneValidationReason } from "./business-line";

// ─── Visibility ─────────────────────────────────────────────────────────────

/**
 * Whether to show the "Phone" sidebar item / page. Server-truth `entitled`
 * (Pro+ plan AND active add-on) gates it; in P1.2 the module is shown to the
 * operator roles that can place calls + read logs (admin/manager). Fail-closed:
 * anything else → hidden.
 */
export function shouldShowPhoneNav(args: { entitled: boolean; role: string }): boolean {
  return args.entitled === true && (args.role === "admin" || args.role === "manager");
}

/** Whether to show the "Call via Business Phone" button on a customer. */
export function canShowCustomerCallButton(args: {
  entitled: boolean;
  phone: string | null | undefined;
}): boolean {
  return args.entitled === true && typeof args.phone === "string" && args.phone.trim() !== "";
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
      return msg ?? "Your account isn't allowed to place calls.";
    case 404:
      return msg ?? "We couldn't find that contact.";
    case 429:
      return msg ?? "Too many calls in progress. Try again in a moment.";
    case 503:
      return msg ?? "Business Phone calling isn't available right now.";
    case 400:
    case 409:
      return msg ?? "We couldn't place that call. Check the number and your settings.";
    default:
      return msg ?? "Couldn't place the call right now. Please try again.";
  }
}
