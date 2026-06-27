// Pure decision + status logic for Business Line call forwarding (increment 4).
//
// This is where the "may generate live telecom behavior" logic lives, so it is
// deliberately PURE and fully unit-testable: it takes already-resolved state
// (flag, signature inputs, tenant/settings/usage) and returns a decision or an
// update plan. The webhook routes are thin glue that do the I/O (read body,
// verify, DB lookups, insert/update) and call into here. Nothing in this file
// performs a network call or touches the database.
//
// Forwarding only ever happens for the single "dial" decision, which requires
// flag ON + valid signature + tenant match + entitlement + enabled + a valid,
// non-loop forwarding number + under the monthly cap.

import {
  validateUSCanadaE164,
  isForwardingLoop,
  secondsToBillableMinutes,
  estimateForwardingCostCents,
  normalizeCallStatus,
  type CallStatus,
} from "./business-line";
import {
  verifyTelnyxSignature,
  extractTelnyxCallEvent,
  texmlDial,
  texmlReject,
  texmlNoForwarding,
  type BusinessLineConfig,
  type TelnyxCallEvent,
} from "./telnyx-business-line";

/** Hard per-call ceiling (seconds) presented as the Dial timeLimit — cost
 *  control + a backstop against stuck calls. 1 hour. */
export const MAX_CALL_SECONDS = 3600;

// ─── Inbound forwarding decision ────────────────────────────────────────────

export type ForwardingRejectReason =
  | "no_tenant"
  | "line_disabled"
  | "no_entitlement"
  | "no_forwarding_number"
  | "invalid_forwarding_number"
  | "forwarding_loop"
  | "over_cap";

export type ForwardingDecision =
  | { action: "dial"; forwardingNumber: string; callerId: string }
  | { action: "reject"; reason: ForwardingRejectReason };

export type ForwardingContext = {
  /** True when the called number matched an active tenant_phone_numbers row. */
  tenantMatched: boolean;
  /** The called business number (E.164) — the MVP caller-ID source. */
  businessNumber: string | null;
  /** All of the tenant's business numbers (loop guard). */
  ownedNumbers: string[];
  settingsEnabled: boolean;
  entitlementActive: boolean;
  forwardingNumber: string | null;
  minutesUsed: number;
  monthlyMinuteCap: number;
};

/**
 * Decide what to do with an inbound call. Fail-closed: any missing/invalid
 * precondition returns a typed reject; only a fully-valid context returns a
 * dial. Caller ID is ALWAYS the business number (never the caller's number).
 */
export function decideForwarding(ctx: ForwardingContext): ForwardingDecision {
  if (!ctx.tenantMatched || !ctx.businessNumber) return reject("no_tenant");
  if (!ctx.settingsEnabled) return reject("line_disabled");
  if (!ctx.entitlementActive) return reject("no_entitlement");
  if (!ctx.forwardingNumber || ctx.forwardingNumber.trim() === "") {
    return reject("no_forwarding_number");
  }
  const v = validateUSCanadaE164(ctx.forwardingNumber);
  if (!v.ok) return reject("invalid_forwarding_number");
  if (isForwardingLoop(v.e164, ctx.ownedNumbers)) return reject("forwarding_loop");
  if (ctx.monthlyMinuteCap > 0 && ctx.minutesUsed >= ctx.monthlyMinuteCap) {
    return reject("over_cap");
  }
  // callerId policy: present the ZentroMeet business number.
  return { action: "dial", forwardingNumber: v.e164, callerId: ctx.businessNumber };
}

function reject(reason: ForwardingRejectReason): ForwardingDecision {
  return { action: "reject", reason };
}

/** Initial call-log status for a decision. */
export function callLogStatusForDecision(d: ForwardingDecision): CallStatus {
  if (d.action === "dial") return "ringing";
  if (d.reason === "no_forwarding_number") return "no_forwarding";
  return "rejected";
}

/** TeXML response for a decision. Dial only for the valid case; otherwise a
 *  safe reject. Never includes any secret. */
export function texmlForDecision(
  decision: ForwardingDecision,
  opts: { statusCallbackUrl?: string | null; timeLimitSeconds?: number } = {},
): string {
  if (decision.action === "dial") {
    return texmlDial({
      forwardingNumber: decision.forwardingNumber,
      callerId: decision.callerId,
      statusCallbackUrl: opts.statusCallbackUrl ?? null,
      timeLimitSeconds: opts.timeLimitSeconds ?? MAX_CALL_SECONDS,
    });
  }
  if (decision.reason === "no_forwarding_number") return texmlNoForwarding();
  return texmlReject();
}

// ─── Inbound verify + parse (flag-gated, fail-closed) ───────────────────────

export type VerifyParseResult =
  | { ok: false; reason: "disabled" | "bad_signature" }
  | { ok: true; event: TelnyxCallEvent };

/**
 * Gate + authenticate + parse an inbound webhook. Returns `disabled` when the
 * feature flag is OFF (the default), `bad_signature` when the flag is on but the
 * Ed25519 signature/timestamp fails or the body isn't JSON, otherwise the parsed
 * event. Fail-closed throughout — never returns ok on a bad signature.
 */
export function verifyAndParseInbound(args: {
  config: BusinessLineConfig;
  rawBody: string;
  signatureB64: string | null;
  timestamp: string | null;
  nowSeconds?: number;
}): VerifyParseResult {
  if (!args.config.enabled) return { ok: false, reason: "disabled" };
  if (!args.config.publicKey) return { ok: false, reason: "bad_signature" }; // misconfigured → fail closed
  const sig = verifyTelnyxSignature({
    payload: args.rawBody,
    signatureB64: args.signatureB64,
    timestamp: args.timestamp,
    publicKeyB64: args.config.publicKey,
    toleranceSeconds: args.config.replayToleranceSeconds,
    nowSeconds: args.nowSeconds,
  });
  if (!sig.ok) return { ok: false, reason: "bad_signature" };
  // Telnyx TeXML delivers form-encoded TwiML params; extractTelnyxCallEvent
  // handles that (and the legacy JSON shape) without throwing.
  return { ok: true, event: extractTelnyxCallEvent(args.rawBody) };
}

// ─── Monotonic call-status transitions ──────────────────────────────────────

// Progress ranking. Terminal states share the top tier so a later event can
// never regress a finished call. `answered` sits between `ringing` and terminal.
const STATUS_RANK: Record<CallStatus, number> = {
  ringing: 0,
  answered: 1,
  completed: 3,
  missed: 3,
  failed: 3,
  rejected: 3,
  no_forwarding: 3,
};

export function isTerminalCallStatus(s: CallStatus): boolean {
  return STATUS_RANK[s] >= 3;
}

/**
 * Next status given the current one — never regresses. A terminal status is
 * sticky (idempotent for retries/late events); a lower-ranked incoming status
 * (e.g. ringing after answered) is ignored.
 */
export function nextCallStatus(current: CallStatus | null, incoming: CallStatus): CallStatus {
  if (!current) return incoming;
  if (isTerminalCallStatus(current)) return current;
  return STATUS_RANK[incoming] >= STATUS_RANK[current] ? incoming : current;
}

// ─── Status-event update plan + usage delta ─────────────────────────────────

export type UsageDelta = {
  answeredCalls: number;
  missedCalls: number;
  billableSeconds: number;
  estimatedCostCents: number;
};

export type StatusUpdatePlan = {
  nextStatus: CallStatus;
  /** True only on the FIRST transition into a terminal state (drives counters
   *  so retries never double-count). */
  becameTerminal: boolean;
  durationSeconds: number | null;
  billableSeconds: number;
  usageDelta: UsageDelta;
};

/**
 * Compute the call-log update + monthly-usage delta for an incoming status
 * event. Returns null for an unrecognized status (no-op). Counters only accrue
 * on the first terminal transition — `completed` ⇒ answered + billable minutes,
 * `missed`/`no_forwarding` ⇒ missed, `failed`/`rejected` ⇒ terminal but no
 * counter.
 */
export function planStatusUpdate(args: {
  currentStatus: CallStatus | null;
  incomingStatusRaw: string | null;
  durationSeconds?: number | null;
}): StatusUpdatePlan | null {
  const incoming = normalizeCallStatus(args.incomingStatusRaw);
  if (!incoming) return null;

  const current = args.currentStatus ?? null;
  const next = nextCallStatus(current, incoming);
  const wasTerminal = current ? isTerminalCallStatus(current) : false;
  const becameTerminal = !wasTerminal && isTerminalCallStatus(next);
  const duration =
    typeof args.durationSeconds === "number" && args.durationSeconds > 0
      ? Math.floor(args.durationSeconds)
      : 0;

  const delta: UsageDelta = {
    answeredCalls: 0,
    missedCalls: 0,
    billableSeconds: 0,
    estimatedCostCents: 0,
  };
  let billableSeconds = 0;

  if (becameTerminal) {
    if (next === "completed") {
      delta.answeredCalls = 1;
      billableSeconds = secondsToBillableMinutes(duration) * 60;
      delta.billableSeconds = billableSeconds;
      delta.estimatedCostCents = estimateForwardingCostCents(duration);
    } else if (next === "missed" || next === "no_forwarding") {
      delta.missedCalls = 1;
    }
    // failed / rejected → terminal but no counters.
  }

  return {
    nextStatus: next,
    becameTerminal,
    durationSeconds: duration > 0 ? duration : null,
    billableSeconds,
    usageDelta: delta,
  };
}
