// Telnyx Business Line — config, Ed25519 webhook verification, TeXML builders,
// and a defensive event parser for the telephony MVP.
//
// PURE + Node-builtin-only: no database, no outbound Telnyx API calls, no
// React. The feature is OFF unless TELNYX_BUSINESS_LINE_ENABLED === "true", so
// importing this module can never place or forward a call.
//
// INCREMENT 2 (this file) is PLUMBING ONLY. The webhook routes return a safe
// TeXML <Reject> while the flag is off (the default). The `texmlDial` builder
// and `verifyTelnyxSignature` helper exist and are tested, ready for a later
// increment to wire real forwarding (verify → parse → tenant lookup → <Dial>)
// behind the same flag. Nothing here performs forwarding on its own.
//
// Signature verification uses Node's built-in `node:crypto` Ed25519 support —
// NO new dependency is added.

import { createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";

// ─── Config / feature flag ──────────────────────────────────────────────────

const DEFAULT_REPLAY_TOLERANCE_SECONDS = 300;

export type BusinessLineConfig = {
  /** Master switch. FALSE unless TELNYX_BUSINESS_LINE_ENABLED === "true". */
  enabled: boolean;
  /** Telnyx Ed25519 public key (base64). Required only when enabled. */
  publicKey: string | null;
  /** Telnyx API key (Bearer). Required to PLACE an outbound bridge leg (P1.0);
   *  still unused for inbound forwarding, which is purely TeXML-response driven. */
  apiKey: string | null;
  /** Telnyx TeXML Application id used to originate the outbound staff leg
   *  (POST /v2/texml/calls/{id}). Required to place a bridge call; optional on
   *  the type so inbound-only config fixtures need not set it. */
  texmlAppId?: string | null;
  /** Replay window for webhook timestamps, seconds. */
  replayToleranceSeconds: number;
};

export function readBusinessLineConfig(
  env: Record<string, string | undefined> = process.env,
): BusinessLineConfig {
  const enabled =
    String(env.TELNYX_BUSINESS_LINE_ENABLED ?? "").trim().toLowerCase() === "true";
  const tol = Number(env.TELNYX_WEBHOOK_TOLERANCE_SECONDS);
  return {
    enabled,
    publicKey: env.TELNYX_PUBLIC_KEY?.trim() || null,
    apiKey: env.TELNYX_API_KEY?.trim() || null,
    texmlAppId: env.TELNYX_TEXML_APP_ID?.trim() || null,
    replayToleranceSeconds:
      Number.isFinite(tol) && tol > 0 ? tol : DEFAULT_REPLAY_TOLERANCE_SECONDS,
  };
}

export type ConfigResolution =
  | { ok: true; config: BusinessLineConfig }
  | { ok: false; reason: "disabled" | "missing_public_key" };

/**
 * Resolve config for an enabled webhook path. When enabled, TELNYX_PUBLIC_KEY
 * is REQUIRED (we cannot verify webhooks without it). TELNYX_API_KEY is not
 * required in this increment. Returns a typed reason when not usable.
 */
export function resolveBusinessLineConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigResolution {
  const config = readBusinessLineConfig(env);
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (!config.publicKey) return { ok: false, reason: "missing_public_key" };
  return { ok: true, config };
}

// ─── Ed25519 webhook signature verification ─────────────────────────────────
//
// Telnyx signs each webhook with Ed25519. We verify the base64 signature
// (header `telnyx-signature-ed25519`) over the message `${timestamp}|${rawBody}`
// using the account's public key (header `telnyx-timestamp` supplies the
// timestamp; the public key comes from config). A timestamp outside the replay
// window is rejected before any crypto runs.

// DER SPKI prefix for an Ed25519 public key (12 bytes) + 32-byte raw key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519KeyFromBase64(publicKeyB64: string): KeyObject {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) {
    throw new Error(`Telnyx public key must be a 32-byte Ed25519 key; got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export type SignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_headers" | "bad_timestamp" | "stale" | "invalid_signature" | "config";
    };

export function verifyTelnyxSignature(args: {
  /** Raw request body (exact bytes as received). */
  payload: string;
  /** `telnyx-signature-ed25519` header (base64). */
  signatureB64: string | null | undefined;
  /** `telnyx-timestamp` header (unix seconds, as a string). */
  timestamp: string | null | undefined;
  /** Telnyx Ed25519 public key (base64). */
  publicKeyB64: string;
  /** Replay window in seconds (default 300). */
  toleranceSeconds?: number;
  /** Injectable clock (unix seconds) for deterministic tests. */
  nowSeconds?: number;
}): SignatureVerification {
  const { payload, signatureB64, timestamp, publicKeyB64 } = args;
  if (!signatureB64 || !timestamp) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "bad_timestamp" };

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? DEFAULT_REPLAY_TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: "stale" };

  const signed = Buffer.from(`${timestamp}|${payload}`, "utf8");
  try {
    const key = ed25519KeyFromBase64(publicKeyB64);
    const sig = Buffer.from(signatureB64, "base64");
    const ok = nodeVerify(null, signed, key, sig);
    return ok ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    // Malformed key / signature bytes — treat as a config error, never throw
    // into the webhook handler.
    return { ok: false, reason: "config" };
  }
}

// ─── TeXML builders (pure strings) ──────────────────────────────────────────

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escape a value for safe inclusion in XML text or an attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A bare <Reject> — the call is declined and NOTHING is forwarded. */
export function texmlReject(): string {
  return `${XML_DECL}<Response><Reject/></Response>`;
}

/** Feature OFF / misconfigured. Same safe shape as reject; named for clarity. */
export function texmlDisabled(): string {
  return texmlReject();
}

/** No (or invalid) forwarding number configured. Contains NO phone number. */
export function texmlNoForwarding(): string {
  return texmlReject();
}

export type DialResponseArgs = {
  /** E.164 target to ring (validated by the caller, e.g. validateUSCanadaE164). */
  forwardingNumber: string;
  /** E.164 caller ID to present (MVP: the tenant's business number). */
  callerId: string;
  /** Deprecated/unused: status is delivered via the TeXML app's "Call progress
   *  events URL" (app-level webhook), NOT via a <Dial action>. In TeXML the
   *  `action` attribute is the "what TeXML to run next" URL and expects a TeXML
   *  response — pointing it at our JSON status route made Telnyx play an error
   *  announcement after the dial. So we intentionally do NOT emit `action`. */
  statusCallbackUrl?: string | null;
  /** Optional hard per-call cap (seconds) for cost control. */
  timeLimitSeconds?: number;
  /** Optional ring timeout (seconds) — how long the forwarded leg rings before
   *  Telnyx reports no-answer. Maps to TeXML <Dial timeout>. */
  ringTimeoutSeconds?: number;
};

/**
 * Build a TeXML <Dial> that bridges the inbound caller to the forwarding number.
 * PURE string builder. All interpolated values are XML-escaped.
 *
 * No `action` attribute is emitted (see DialResponseArgs.statusCallbackUrl):
 * call status flows through the app-level Call-progress-events webhook, so after
 * the dial ends the parent call simply hangs up cleanly.
 */
export function texmlDial(args: DialResponseArgs): string {
  const attrs: string[] = [`callerId="${escapeXml(args.callerId)}"`];
  if (args.timeLimitSeconds && args.timeLimitSeconds > 0) {
    attrs.push(`timeLimit="${Math.floor(args.timeLimitSeconds)}"`);
  }
  if (args.ringTimeoutSeconds && args.ringTimeoutSeconds > 0) {
    attrs.push(`timeout="${Math.floor(args.ringTimeoutSeconds)}"`);
  }
  const number = escapeXml(args.forwardingNumber);
  return `${XML_DECL}<Response><Dial ${attrs.join(" ")}><Number>${number}</Number></Dial></Response>`;
}

/**
 * MVP caller-ID policy: ALWAYS present the tenant's ZentroMeet business number
 * as the caller ID on the forwarded leg (clean STIR/SHAKEN attestation; the
 * owner recognizes their business line). The real caller is recorded in the
 * call log separately — never used as the outbound caller ID in MVP.
 */
export function selectCallerId(args: {
  businessNumber: string;
  callerNumber?: string | null;
}): string {
  return args.businessNumber;
}

/** Build the status-callback URL Telnyx should post call events to. */
export function buildStatusCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/webhooks/telnyx/voice/status`;
}

/** Build the outbound-bridge TeXML URL Telnyx fetches when the staff leg
 *  answers. It returns the customer-leg <Dial> (see the bridge webhook route).
 *  The routing target (customer + business caller ID) is carried as query
 *  params + an HMAC, NOT in the signed body. */
export function buildBridgeCallbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/webhooks/telnyx/voice/bridge`;
}

// ─── Dark webhook diagnostic (P1.x) ─────────────────────────────────────────
//
// Safe, SECRETS-FREE summary of a webhook request for debugging signature
// failures. Returns ONLY: route name, whether the signature/timestamp headers
// were present (booleans, never the values), the raw body length (a number, not
// the body), and the verification result string. NEVER includes the raw
// signature, the public key, the API key, phone numbers, or any body content.
// Gated by the caller behind TELNYX_WEBHOOK_DIAG so it's off by default.

export type WebhookDiag = {
  route: string;
  hasSignature: boolean;
  hasTimestamp: boolean;
  bodyLength: number;
  result: string;
};

export function summarizeWebhookRequest(args: {
  route: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  bodyLength: number;
  result: string;
}): WebhookDiag {
  return {
    route: args.route,
    hasSignature: Boolean(args.signature),
    hasTimestamp: Boolean(args.timestamp),
    bodyLength: typeof args.bodyLength === "number" && args.bodyLength >= 0 ? args.bodyLength : 0,
    result: args.result,
  };
}

// ─── Defensive event parser ─────────────────────────────────────────────────

export type TelnyxCallEvent = {
  eventId: string | null;
  eventType: string | null;
  callSessionId: string | null;
  callControlId: string | null;
  callLegId: string | null;
  from: string | null;
  to: string | null;
  hangupCause: string | null;
  durationSeconds: number | null;
};

/**
 * Extract the fields a later increment needs from a parsed Telnyx webhook body.
 * Telnyx nests details under data.payload with data.event_type + data.id.
 * NEVER throws; missing/garbage fields become null. NO DB, NO side effects.
 */
export function parseTelnyxCallEvent(body: unknown): TelnyxCallEvent {
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const payload = isRecord(data.payload) ? data.payload : {};
  return {
    eventId: str(data.id),
    eventType: str(data.event_type),
    callSessionId: str(payload.call_session_id),
    callControlId: str(payload.call_control_id),
    callLegId: str(payload.call_leg_id),
    from: str(isRecord(payload.from) ? payload.from.phone_number : payload.from),
    to: str(isRecord(payload.to) ? payload.to.phone_number : payload.to),
    hangupCause: str(payload.hangup_cause),
    durationSeconds: num(
      payload.call_duration_secs ?? payload.duration_secs ?? payload.duration_seconds,
    ),
  };
}

/**
 * Format-agnostic extractor from a RAW webhook body. A Telnyx **TeXML**
 * application delivers webhooks as TwiML-compatible **form-encoded** params
 * (`From`/`To`/`CallSid`/`CallStatus`/`CallDuration`, and `DialCallStatus`/
 * `DialCallDuration` on the <Dial> action callback). This handles that form
 * format AND falls back to the Call-Control JSON shape (kept for back-compat /
 * tests). NEVER throws. Signature verification is done separately on the raw
 * body (same Ed25519 scheme for both formats), so this only normalizes fields.
 */
export function extractTelnyxCallEvent(rawBody: string): TelnyxCallEvent {
  const trimmed = (rawBody ?? "").trim();
  // Call-Control JSON shape (back-compat): { data: { event_type, payload } }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseTelnyxCallEvent(JSON.parse(trimmed));
    } catch {
      /* fall through to form parsing */
    }
  }
  return parseTexmlForm(trimmed);
}

/** Parse a form-encoded TeXML (TwiML-compatible) request body. Looks up params
 *  case-insensitively across known aliases so minor naming differences don't
 *  break extraction. */
function parseTexmlForm(rawBody: string): TelnyxCallEvent {
  const map = new Map<string, string>();
  try {
    for (const [k, v] of new URLSearchParams(rawBody).entries()) {
      if (v !== "") map.set(k.toLowerCase(), v);
    }
  } catch {
    /* malformed → empty map → all-null event */
  }
  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = map.get(k.toLowerCase());
      if (v != null && v !== "") return v;
    }
    return null;
  };
  // On the <Dial> action callback the FORWARDED leg's outcome is in
  // DialCallStatus/DialCallDuration; prefer those, else the parent call's.
  const callSid = get("CallSid", "CallSidLegId", "call_sid");
  const status = get("DialCallStatus", "CallStatus", "call_status");
  const duration = get("DialCallDuration", "CallDuration", "RecordingDuration");
  return {
    // TeXML has no native event id; synthesize a stable per-(call,status) key so
    // retries of the same status dedupe while distinct statuses are recorded.
    eventId: callSid && status ? `${callSid}:${status}` : callSid,
    eventType: status,
    callSessionId: callSid,
    callControlId: get("CallControlId", "CallSidLegId"),
    callLegId: get("CallSidLegId"),
    from: get("From", "from", "Caller"),
    to: get("To", "to", "Called"),
    hangupCause: get("HangupCause", "SipResponseCode"),
    durationSeconds: num(duration),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
