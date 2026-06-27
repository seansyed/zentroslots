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
  /** Call-progress events callback (status/usage). */
  statusCallbackUrl?: string | null;
  /** Staff-leg ring timeout (seconds). */
  ringTimeoutSeconds?: number;
}): Promise<OriginateResult> {
  const { config } = args;
  if (!config.enabled) return { ok: false, reason: "disabled" };
  if (!config.apiKey || !config.texmlAppId) return { ok: false, reason: "unconfigured" };

  const payload: Record<string, string | number> = {
    To: args.to,
    From: args.from,
    Url: args.bridgeUrl,
    UrlMethod: "POST",
  };
  if (args.statusCallbackUrl) {
    payload.StatusCallback = args.statusCallbackUrl;
    payload.StatusCallbackMethod = "POST";
  }
  if (args.ringTimeoutSeconds && args.ringTimeoutSeconds > 0) {
    payload.Timeout = Math.floor(args.ringTimeoutSeconds);
  }

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

  // TeXML create-call responses are Twilio-compatible; correlation ids live under
  // a few possible keys depending on the API surface. Parse defensively.
  let callSid: string | null = null;
  let callSessionId: string | null = null;
  try {
    const data = (JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {};
    callSid = pickStr(data, "call_sid", "sid", "call_control_id", "call_leg_id");
    callSessionId = pickStr(data, "call_session_id", "session_id");
  } catch {
    /* ids stay null — the status webhook can still correlate by what we stored */
  }
  return { ok: true, callSid, callSessionId };
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
