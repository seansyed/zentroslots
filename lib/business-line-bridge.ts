// Pure decision + TeXML logic for the ZentroMeet Business Phone OUTBOUND BRIDGE
// (Phase 1 / increment P1.0). Mirrors lib/business-line-forwarding.ts: this file
// is deliberately PURE and fully unit-testable — it takes already-resolved state
// (entitlement, settings, the owner's numbers, usage, concurrency) and returns a
// fail-closed decision or a TeXML string. It performs NO network call and
// touches NO database. The only side-effecting piece (placing the staff leg via
// Telnyx) lives in lib/telnyx-api.ts and is invoked by the route ONLY after this
// returns a "bridge" decision AND the feature flag is on.
//
// The bridge model: ZentroMeet rings the STAFF phone first (leg 1 = the tenant's
// forwarding number in MVP); when it answers, Telnyx fetches the bridge webhook
// which returns a <Dial> to the CUSTOMER presenting the tenant's BUSINESS number
// as caller ID (leg 2). The customer therefore sees the business number, never
// the staff's personal phone. Caller ID is ALWAYS a tenant-owned number — never
// arbitrary, never the customer's own number.

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  validateUSCanadaE164,
  isEmergencyNumber,
  isForwardingLoop,
  normalizeE164Phone,
} from "./business-line";
import { texmlDial } from "./telnyx-business-line";

// ─── Constants (cost-control + UX timing) ───────────────────────────────────

/** How long the STAFF phone rings before Telnyx gives up originating leg 1. */
export const STAFF_RING_TIMEOUT_SECONDS = 30;
/** How long the CUSTOMER leg rings (TeXML <Dial timeout>) before no-answer. */
export const CUSTOMER_RING_TIMEOUT_SECONDS = 30;
/** Hard per-call ceiling (seconds) → TeXML <Dial timeLimit>. 1 hour. */
export const BRIDGE_MAX_CALL_SECONDS = 3600;
/** Default cap on simultaneous in-flight outbound calls per tenant. */
export const DEFAULT_MAX_CONCURRENT_OUTBOUND = 3;

// ─── Call purpose (matches the API contract) ────────────────────────────────

export const CALL_PURPOSES = ["new_call", "callback_missed", "customer_call"] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

export function normalizeCallPurpose(raw: string | null | undefined): CallPurpose | null {
  if (!raw) return null;
  return (CALL_PURPOSES as readonly string[]).includes(raw) ? (raw as CallPurpose) : null;
}

// ─── Outbound bridge decision ───────────────────────────────────────────────

export type OutboundBridgeRejectReason =
  | "no_business_number"
  | "line_disabled"
  | "no_entitlement"
  | "setup_required"
  | "staff_disabled"
  | "invalid_staff_number"
  | "no_destination"
  | "invalid_destination"
  | "international"
  | "emergency"
  | "self_call"
  | "staff_loop"
  | "over_cap"
  | "concurrency_limit";

/** Where the leg-1 (staff) number came from — for logging/observability only. */
export type StaffBridgeSource = "staff" | "tenant";

export type OutboundBridgeDecision =
  | { action: "bridge"; customerNumber: string; staffNumber: string; staffSource: StaffBridgeSource; callerId: string }
  | { action: "reject"; reason: OutboundBridgeRejectReason };

export type OutboundBridgeContext = {
  /** The tenant's active business number — the caller ID shown to the customer. */
  businessNumber: string | null;
  /** All of the tenant's business numbers (self-call / loop guard). */
  ownedNumbers: string[];
  /** The Business Phone line must be enabled. */
  settingsEnabled: boolean;
  /** Pro+ plan AND active add-on (the caller folds both gates into this bool). */
  entitlementActive: boolean;
  // ── Staff identity (P1.1). The leg-1 number is resolved staff → tenant
  //    fallback → setup_required (see resolveStaffBridge). ──
  /** Whether a tenant_phone_users row exists for the calling staff member. */
  staffRowExists: boolean;
  /** The staff row's master switch (only meaningful when staffRowExists). */
  staffEnabled: boolean;
  /** The staff row's outbound permission (only meaningful when staffRowExists). */
  staffCanPlaceCalls: boolean;
  /** The staff member's own bridge phone (leg-1), if set. */
  staffBridgeNumber: string | null;
  /** Tenant forwarding number — leg-1 fallback for pilot compatibility. */
  tenantFallbackNumber: string | null;
  /** Raw customer destination (from `toNumber` or a resolved customer phone). */
  destinationRaw: string | null;
  /** Billable minutes already used this period (for the hard cap). */
  minutesUsed: number;
  /** Monthly minute cap (0 = no cap). */
  monthlyMinuteCap: number;
  /** Tenant's currently in-flight outbound calls (ringing/answered). */
  activeOutboundCalls: number;
  /** Concurrency ceiling (0 = unlimited). */
  maxConcurrentCalls: number;
};

// ─── Staff bridge-number resolution (pure) ──────────────────────────────────

export type StaffBridgeResolution =
  | { kind: "ok"; number: string; source: StaffBridgeSource }
  | { kind: "disabled" } // an explicit staff row that isn't allowed to place calls
  | { kind: "setup_required" }; // neither a staff number nor a tenant fallback

/**
 * Resolve the leg-1 (staff) number, fail-closed:
 *   1. an ENABLED staff row whose can_place_calls is true → use its bridge phone
 *      (or, if it has none set, fall through to the tenant fallback);
 *   2. otherwise the tenant forwarding number (P1.0 / pilot compatibility);
 *   3. otherwise setup_required.
 * An explicit staff row that is disabled OR not allowed to place calls is a hard
 * "disabled" — it never silently falls back (so revoking a staff member actually
 * stops them placing calls).
 */
export function resolveStaffBridge(args: {
  staffRowExists: boolean;
  staffEnabled: boolean;
  staffCanPlaceCalls: boolean;
  staffBridgeNumber: string | null;
  tenantFallbackNumber: string | null;
}): StaffBridgeResolution {
  if (args.staffRowExists && (!args.staffEnabled || !args.staffCanPlaceCalls)) {
    return { kind: "disabled" };
  }
  if (args.staffRowExists && args.staffBridgeNumber && args.staffBridgeNumber.trim() !== "") {
    return { kind: "ok", number: args.staffBridgeNumber, source: "staff" };
  }
  if (args.tenantFallbackNumber && args.tenantFallbackNumber.trim() !== "") {
    return { kind: "ok", number: args.tenantFallbackNumber, source: "tenant" };
  }
  return { kind: "setup_required" };
}

/**
 * Decide whether to place an outbound bridge call. Fail-closed: any missing or
 * invalid precondition returns a typed reject; only a fully-valid context yields
 * a "bridge". Caller ID is ALWAYS the tenant's business number.
 */
export function decideOutboundBridge(ctx: OutboundBridgeContext): OutboundBridgeDecision {
  if (!ctx.businessNumber) return reject("no_business_number");
  if (!ctx.settingsEnabled) return reject("line_disabled");
  if (!ctx.entitlementActive) return reject("no_entitlement");

  // Leg 1: resolve the staff phone we ring first (staff → tenant fallback).
  const resolved = resolveStaffBridge({
    staffRowExists: ctx.staffRowExists,
    staffEnabled: ctx.staffEnabled,
    staffCanPlaceCalls: ctx.staffCanPlaceCalls,
    staffBridgeNumber: ctx.staffBridgeNumber,
    tenantFallbackNumber: ctx.tenantFallbackNumber,
  });
  if (resolved.kind === "disabled") return reject("staff_disabled");
  if (resolved.kind === "setup_required") return reject("setup_required");
  const staff = validateUSCanadaE164(resolved.number);
  if (!staff.ok) return reject("invalid_staff_number");
  const staffSource = resolved.source;

  // Leg 2: the customer destination. Check emergency/N11 on the RAW input first
  // (short codes don't survive normalization), then enforce US/CA E.164.
  if (!ctx.destinationRaw || ctx.destinationRaw.trim() === "") return reject("no_destination");
  if (isEmergencyNumber(ctx.destinationRaw)) return reject("emergency");
  const dest = validateUSCanadaE164(ctx.destinationRaw);
  if (!dest.ok) {
    return reject(dest.reason === "not_us_canada" ? "international" : "invalid_destination");
  }

  // Never dial our own business number(s) — self-call.
  if (isForwardingLoop(dest.e164, [ctx.businessNumber, ...ctx.ownedNumbers])) {
    return reject("self_call");
  }
  // Never bridge the staff to themselves (destination == the staff/forwarding leg).
  if (normalizeE164Phone(dest.e164) === normalizeE164Phone(staff.e164)) {
    return reject("staff_loop");
  }

  // Cost controls: hard monthly cap, then concurrency.
  if (ctx.monthlyMinuteCap > 0 && ctx.minutesUsed >= ctx.monthlyMinuteCap) {
    return reject("over_cap");
  }
  if (ctx.maxConcurrentCalls > 0 && ctx.activeOutboundCalls >= ctx.maxConcurrentCalls) {
    return reject("concurrency_limit");
  }

  return {
    action: "bridge",
    customerNumber: dest.e164,
    staffNumber: staff.e164,
    staffSource,
    callerId: ctx.businessNumber,
  };
}

function reject(reason: OutboundBridgeRejectReason): OutboundBridgeDecision {
  return { action: "reject", reason };
}

/** Initial call-log status for an outbound bridge decision. */
export function callLogStatusForBridge(d: OutboundBridgeDecision): "ringing" | "rejected" {
  return d.action === "bridge" ? "ringing" : "rejected";
}

/** Map a reject reason to a safe HTTP status + customer-facing message. */
export function bridgeRejectToHttp(reason: OutboundBridgeRejectReason): {
  status: number;
  message: string;
} {
  switch (reason) {
    case "no_entitlement":
      return { status: 402, message: "The Business Phone add-on isn't active on your plan." };
    case "line_disabled":
      return { status: 409, message: "Your Business Phone line is turned off." };
    case "over_cap":
      return { status: 409, message: "You've reached this month's calling limit." };
    case "concurrency_limit":
      return { status: 429, message: "Too many calls in progress. Try again in a moment." };
    case "emergency":
      return { status: 400, message: "Emergency and service numbers can't be dialed." };
    case "international":
      return { status: 400, message: "Only US and Canada numbers can be dialed." };
    case "self_call":
      return { status: 400, message: "You can't call your own business number." };
    case "staff_loop":
      return { status: 400, message: "That number is your own forwarding line." };
    case "staff_disabled":
      return { status: 403, message: "You do not have permission to place Business Phone calls." };
    case "setup_required":
      return {
        status: 409,
        message:
          "Set your calling phone number first. ZentroMeet will call you there, then connect the customer.",
      };
    case "invalid_staff_number":
      return { status: 409, message: "Your calling number isn't a valid US or Canada number." };
    case "no_business_number":
      return { status: 409, message: "No business number is provisioned for your workspace." };
    case "no_destination":
    case "invalid_destination":
    default:
      return { status: 400, message: "Enter a valid US or Canada phone number." };
  }
}

// ─── Customer-leg TeXML (the bridge response) ───────────────────────────────

/**
 * Build the TeXML the bridge webhook returns when the staff leg answers: a
 * <Dial> to the customer presenting the tenant's business number as caller ID.
 * Delegates to the shared, escaped texmlDial builder. No status callback / no
 * action attribute (status flows via the app-level call-progress webhook).
 */
export function texmlBridgeDial(args: {
  customerNumber: string;
  callerId: string;
  timeLimitSeconds?: number;
  ringTimeoutSeconds?: number;
}): string {
  return texmlDial({
    forwardingNumber: args.customerNumber,
    callerId: args.callerId,
    statusCallbackUrl: null,
    timeLimitSeconds: args.timeLimitSeconds ?? BRIDGE_MAX_CALL_SECONDS,
    ringTimeoutSeconds: args.ringTimeoutSeconds ?? CUSTOMER_RING_TIMEOUT_SECONDS,
  });
}

// ─── Bridge-target resolution (defense-in-depth, used by the webhook) ────────

export type BridgeTargetResult =
  | { ok: true; customerNumber: string; callerId: string }
  | { ok: false; reason: "missing" | "invalid_destination" | "international" | "emergency" | "invalid_caller_id" };

/**
 * Re-validate the routing target carried in the bridge webhook URL. The customer
 * number + caller ID travel as query params (not in the Ed25519-signed body), so
 * the webhook MUST re-check them fail-closed before dialing — never trust the URL
 * blindly. Both must be valid US/CA E.164; the destination must not be an
 * emergency/N11 code.
 */
export function resolveBridgeTarget(args: { to: string | null; cid: string | null }): BridgeTargetResult {
  if (!args.to || !args.cid) return { ok: false, reason: "missing" };
  if (isEmergencyNumber(args.to)) return { ok: false, reason: "emergency" };
  const dest = validateUSCanadaE164(args.to);
  if (!dest.ok) {
    return { ok: false, reason: dest.reason === "not_us_canada" ? "international" : "invalid_destination" };
  }
  const cid = validateUSCanadaE164(args.cid);
  if (!cid.ok) return { ok: false, reason: "invalid_caller_id" };
  return { ok: true, customerNumber: dest.e164, callerId: cid.e164 };
}

// ─── HMAC bridge token (URL-param integrity) ────────────────────────────────
//
// The Ed25519 signature only authenticates the webhook BODY (proving Telnyx
// sent it). The routing target lives in the URL query, so we additionally bind
// `to`+`cid` with an HMAC keyed on a server secret (the Telnyx API key). Even if
// a bridge URL leaked, an attacker can't repoint the customer leg without the
// secret — and still couldn't forge the Ed25519 body. Belt-and-suspenders.

/** Compute the integrity token for a bridge URL's routing params. */
export function signBridgeToken(secret: string, to: string, cid: string): string {
  return createHmac("sha256", secret).update(`${to}|${cid}`).digest("base64url");
}

/** Constant-time verify of a bridge URL's integrity token. */
export function verifyBridgeToken(
  secret: string,
  to: string,
  cid: string,
  token: string | null | undefined,
): boolean {
  if (!token) return false;
  const expected = Buffer.from(signBridgeToken(secret, to, cid));
  const got = Buffer.from(token);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

// ─── Display helpers ────────────────────────────────────────────────────────

/**
 * Mask a phone number for display, revealing only the last 4 digits — used so a
 * staff member's personal bridge number is never returned in full to the client.
 * Returns null when there's nothing to mask.
 */
export function maskPhoneNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const e164 = normalizeE164Phone(input);
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  return `••• ••• ${digits.slice(-4)}`;
}
