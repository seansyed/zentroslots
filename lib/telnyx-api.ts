// Telnyx outbound-call client for the Business Phone bridge (P1.0).
//
// This is the ONLY Business Phone module that performs a live network call. It
// is invoked exclusively by POST /api/tenant/phone/calls, and ONLY after the
// pure decideOutboundBridge() returns a "bridge" decision. It is guarded twice:
// `canOriginate()` returns false (and originateBridgeCall short-circuits WITHOUT
// any fetch) unless the feature flag is on AND both the API key and TeXML
// application id are configured. With the flag OFF — the default everywhere
// except the single pilot tenant's env — no HTTP request is ever made.
//
// Uses native fetch (no SDK), mirroring lib/sms.ts.

import type { BusinessLineConfig } from "./telnyx-business-line";

const TELNYX_TEXML_CALLS_ENDPOINT = "https://api.telnyx.com/v2/texml/calls";

/** True only when an outbound leg can actually be placed. Fail-closed. */
export function canOriginate(config: BusinessLineConfig): boolean {
  return Boolean(config.enabled && config.apiKey && config.texmlAppId);
}

/**
 * Build the TeXML originate (create-call) payload for the staff leg. PURE +
 * testable.
 *
 * P1.x — IMPORTANT: we deliberately do NOT set a per-call `StatusCallback`.
 * Call status for BOTH inbound and outbound flows through the TeXML
 * Application's configured `status_callback` (→ /api/webhooks/telnyx/voice/status,
 * Ed25519-signed, which our verifier handles). A per-call `StatusCallback` set
 * here was delivered with a signature our Ed25519 verifier rejected
 * (invalid_signature), so outbound calls never advanced past `ringing`. Relying
 * on the app-level status_callback uses the one known-verified path.
 */
export function buildOriginatePayload(args: {
  to: string;
  from: string;
  bridgeUrl: string;
  ringTimeoutSeconds?: number;
}): Record<string, string | number> {
  const payload: Record<string, string | number> = {
    To: args.to,
    From: args.from,
    Url: args.bridgeUrl,
    UrlMethod: "POST",
  };
  if (args.ringTimeoutSeconds && args.ringTimeoutSeconds > 0) {
    payload.Timeout = Math.floor(args.ringTimeoutSeconds);
  }
  return payload;
}

export type OriginateResult =
  | { ok: true; callSid: string | null; callSessionId: string | null }
  | { ok: false; reason: "disabled" | "unconfigured" | "telnyx_error" | "network_error"; detail?: string };

/**
 * Originate the STAFF leg of a bridge call. Telnyx rings `to` (the staff phone)
 * from `from` (the business number); when it answers, Telnyx fetches `bridgeUrl`,
 * which returns the customer-leg <Dial> (see the bridge webhook route).
 *
 * Returns a typed result — never throws into the route. Makes NO network request
 * unless canOriginate(config) is true.
 */
export async function originateBridgeCall(args: {
  config: BusinessLineConfig;
  /** Staff phone (leg 1 target), E.164. */
  to: string;
  /** Business number (caller ID on the staff leg), E.164. */
  from: string;
  /** TeXML URL fetched when the staff leg answers (carries customer + cid + token). */
  bridgeUrl: string;
  /** Staff-leg ring timeout (seconds). */
  ringTimeoutSeconds?: number;
}): Promise<OriginateResult> {
  const { config } = args;
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (!config.apiKey || !config.texmlAppId) return { ok: false, reason: "unconfigured" };

  // No per-call StatusCallback — outbound status flows through the TeXML app's
  // configured status_callback (Ed25519-signed). See buildOriginatePayload.
  const payload = buildOriginatePayload({
    to: args.to,
    from: args.from,
    bridgeUrl: args.bridgeUrl,
    ringTimeoutSeconds: args.ringTimeoutSeconds,
  });

  let res: Response;
  try {
    res = await fetch(`${TELNYX_TEXML_CALLS_ENDPOINT}/${encodeURIComponent(config.texmlAppId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ detail?: string; title?: string }> };
      detail = parsed.errors?.[0]?.detail ?? parsed.errors?.[0]?.title ?? text;
    } catch {
      /* leave raw */
    }
    return { ok: false, reason: "telnyx_error", detail: `Telnyx ${res.status}: ${detail}`.slice(0, 500) };
  }

  // Resolve the call id used to correlate later status callbacks. The TeXML
  // create-call response is Twilio-compatible (top-level `sid`/`CallSid`).
  const { callSid, callSessionId } = parseOriginateResponse(text);
  if (!callSid && !callSessionId) {
    // Safe diagnostic only (no body / secrets). The leg was placed, but status
    // callbacks won't have a stored id to correlate against.
    console.warn("[phone/calls] originate ok but no call id found in response");
  }
  return { ok: true, callSid, callSessionId };
}

/**
 * Parse the TeXML create-call (originate) response for the call id. PURE +
 * testable. Telnyx's TeXML endpoint is Twilio-compatible, so the call id is the
 * TOP-LEVEL `sid` / `CallSid`; we prefer that and fall back to the Call-Control
 * `data.*` shape for back-compat. Never throws.
 */
export function parseOriginateResponse(text: string): { callSid: string | null; callSessionId: string | null } {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { callSid: null, callSessionId: null };
  }
  const root = isRecord(obj) ? obj : {};
  const data = isRecord(root.data) ? root.data : {};
  const callSid =
    pickStr(root, "sid", "CallSid", "call_sid", "call_control_id", "call_leg_id") ??
    pickStr(data, "call_sid", "sid", "call_control_id", "call_leg_id");
  const callSessionId =
    pickStr(root, "call_session_id", "session_id") ?? pickStr(data, "call_session_id", "session_id");
  return { callSid, callSessionId };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
