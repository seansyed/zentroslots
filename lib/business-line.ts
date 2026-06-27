// Pure, dependency-free helpers for the ZentroMeet Business Line (telephony
// MVP) — phone-number validation, forwarding-loop detection, and usage/cost
// math. NO Telnyx calls, NO database, NO React here on purpose: these are the
// rules the data foundation depends on, kept unit-testable in isolation.
// (DB-touching paths are verified later via production smoke, per repo
// convention.)
//
// MVP forwarding is restricted to the North American Numbering Plan (US +
// Canada, country code +1). International targets and emergency/special-service
// numbers are rejected. None of this implements billing — the cost helpers use
// clearly-labelled PLACEHOLDER rates wired to real Telnyx pricing later.

// ─── Recommended add-on package (data-model assumption ONLY; no billing) ────
export const BUSINESS_LINE_DEFAULT_PACKAGE = {
  /** $19/mo — pricing assumption for the data model; Stripe is wired later. */
  monthlyPriceCents: 1900,
  /** 150–200 US/Canada minutes; 200 is the recommended package figure. */
  includedMinutes: 200,
  /** Hard cap → graceful disable BEFORE any overage billing. */
  hardCapMinutes: 200,
} as const;

// ─── Phone-number normalization + validation ────────────────────────────────

// NANP E.164: +1, then an area code and exchange code that each begin 2–9,
// then 4 subscriber digits → +1 [2-9]XX [2-9]XX XXXX.
const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// Emergency + N11 special-service codes that must never be a forwarding target.
// Includes common international emergency numbers so a copy-pasted foreign code
// is still caught.
const EMERGENCY_NUMBERS = new Set<string>([
  "911", "112", "999", "000", "111", "933", // emergency (intl)
  "211", "311", "411", "511", "611", "711", "811", // N11 service codes
]);

/**
 * Best-effort normalization to an E.164-ish string: keep digits and a single
 * leading "+". Applies NANP conveniences (bare 10-digit → +1…, 11-digit
 * starting with 1 → +1…). Returns null when there is no dialable digit. This is
 * deliberately lenient; strict policy lives in validateUSCanadaE164.
 */
export function normalizeE164Phone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) return "+" + digits;
  if (digits.length === 10) return "+1" + digits; // NANP without country code
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits; // assume already international, just missing the "+"
}

/**
 * True if the input is an emergency / special-service code (e.g. 911, 112, N11),
 * optionally with a leading "1" country code. A normal subscriber number that
 * merely contains "911" (e.g. +1 415-555-9110) is NOT flagged.
 */
export function isEmergencyNumber(input: string | null | undefined): boolean {
  if (!input) return false;
  const digits = input.replace(/\D/g, "");
  if (!digits) return false;
  if (EMERGENCY_NUMBERS.has(digits)) return true;
  if (digits.startsWith("1") && EMERGENCY_NUMBERS.has(digits.slice(1))) return true;
  return false;
}

export type PhoneValidationReason = "empty" | "emergency" | "not_us_canada" | "invalid";
export type PhoneValidation =
  | { ok: true; e164: string }
  | { ok: false; reason: PhoneValidationReason };

/**
 * Strict MVP forwarding-number policy: must be a valid US/Canada (NANP) E.164
 * number and must not be an emergency/special-service code. Returns the
 * canonical E.164 on success, or a typed reason on failure.
 */
export function validateUSCanadaE164(input: string | null | undefined): PhoneValidation {
  if (!input || !input.trim()) return { ok: false, reason: "empty" };
  // Check emergency on the RAW input first — short codes don't survive
  // normalization (e.g. "911" would become "+911").
  if (isEmergencyNumber(input)) return { ok: false, reason: "emergency" };
  const e164 = normalizeE164Phone(input);
  if (!e164) return { ok: false, reason: "empty" };
  if (!NANP_E164.test(e164)) {
    // A "+1…" that fails the NANP shape is malformed; anything else is non-US/CA.
    return { ok: false, reason: e164.startsWith("+1") ? "invalid" : "not_us_canada" };
  }
  return { ok: true, e164 };
}

/**
 * Forwarding-loop guard: true if `forwarding` resolves to ANY of the tenant's
 * own business-line numbers (a tenant must not forward its line back to itself).
 * Comparison is normalization-insensitive.
 */
export function isForwardingLoop(
  forwarding: string | null | undefined,
  ownedNumbers: Iterable<string | null | undefined>,
): boolean {
  const f = normalizeE164Phone(forwarding);
  if (!f) return false;
  for (const owned of ownedNumbers) {
    const o = normalizeE164Phone(owned);
    if (o && o === f) return true;
  }
  return false;
}

// ─── Usage + cost math ──────────────────────────────────────────────────────

/**
 * Round a call's wall-clock seconds up to whole billable minutes (standard
 * telephony per-minute billing). 0 / null / negative → 0.
 */
export function secondsToBillableMinutes(seconds: number | null | undefined): number {
  if (!seconds || seconds <= 0) return 0;
  return Math.ceil(seconds / 60);
}

// PLACEHOLDER per-minute rates in cents (NOT real Telnyx pricing — replaced
// with live rates in a later increment). A forwarded inbound call has two
// metered legs: the inbound DID leg + the outbound leg to the forwarding number.
export const PLACEHOLDER_INBOUND_RATE_CENTS_PER_MIN = 0.7; // ~$0.007/min
export const PLACEHOLDER_FORWARD_RATE_CENTS_PER_MIN = 1.0; // ~$0.010/min

/**
 * Estimate the cost (in whole cents, rounded up) of a forwarded call of the
 * given duration. Uses placeholder rates unless overridden. This is an estimate
 * for cost-control display only — not an invoice.
 */
export function estimateForwardingCostCents(
  seconds: number | null | undefined,
  opts?: { inboundRateCentsPerMin?: number; forwardRateCentsPerMin?: number },
): number {
  const minutes = secondsToBillableMinutes(seconds);
  if (minutes === 0) return 0;
  const inbound = opts?.inboundRateCentsPerMin ?? PLACEHOLDER_INBOUND_RATE_CENTS_PER_MIN;
  const forward = opts?.forwardRateCentsPerMin ?? PLACEHOLDER_FORWARD_RATE_CENTS_PER_MIN;
  return Math.ceil(minutes * (inbound + forward));
}

// ─── Call status normalization ──────────────────────────────────────────────

export const CALL_STATUSES = [
  "ringing",
  "answered",
  "completed",
  "missed",
  "failed",
  "rejected",
  "no_forwarding",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * Map a raw/provider status string onto our closed CallStatus union. Accepts
 * our own canonical values plus common Telnyx/SIP synonyms. Unknown → null
 * (caller decides how to handle), so we never invent a fake status.
 */
export function normalizeCallStatus(raw: string | null | undefined): CallStatus | null {
  if (!raw) return null;
  const s = raw.toLowerCase().trim().replace(/^call\./, "");
  switch (s) {
    case "ringing":
    case "initiated":
    case "queued": // TwiML/TeXML
      return "ringing";
    case "answered":
    case "bridged":
    case "in-progress": // TwiML/TeXML
      return "answered";
    case "completed":
    case "hangup":
      return "completed";
    case "missed":
    case "no-answer": // TwiML/TeXML
    case "noanswer":
    case "timeout":
    case "canceled": // TwiML/TeXML (caller abandoned before answer)
    case "cancelled":
      return "missed";
    case "failed":
    case "error":
      return "failed";
    case "rejected":
    case "busy":
    case "declined":
      return "rejected";
    case "no_forwarding":
    case "no-forwarding":
      return "no_forwarding";
    default:
      return null;
  }
}
