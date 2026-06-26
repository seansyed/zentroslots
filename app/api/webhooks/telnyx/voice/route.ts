import { NextRequest, NextResponse } from "next/server";

import { resolveBusinessLineConfig, texmlDisabled } from "@/lib/telnyx-business-line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/telnyx/voice — Business Line inbound voice webhook.
 *
 * ── INCREMENT 2: SKELETON, FEATURE-FLAGGED OFF ──
 * While TELNYX_BUSINESS_LINE_ENABLED !== "true" (the default), this endpoint is
 * reachable but INERT: it reads NOTHING from the database, forwards NO call, and
 * returns a safe TeXML <Reject>. No secrets are logged. There is no real Telnyx
 * call path in this increment.
 *
 * ── Where the next increment plugs in (behind the same flag, when enabled) ──
 *   1. read the raw body (`await req.text()`)
 *   2. verifyTelnyxSignature(...) using `telnyx-signature-ed25519` +
 *      `telnyx-timestamp` headers and the configured public key
 *   3. parseTelnyxCallEvent(JSON.parse(raw))
 *   4. identify the tenant by the called number (payload `to`)
 *   5. insert phone_call_events (idempotent on telnyx_event_id) +
 *      insert/update phone_call_logs
 *   6. return texmlDial({ forwardingNumber, callerId, statusCallbackUrl, ... })
 *      when enabled + forwarding configured, else texmlNoForwarding()/reject
 * None of steps 1–6 run today.
 */
function texml(xml: string, status = 200) {
  return new NextResponse(xml, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

export async function POST(_req: NextRequest) {
  const cfg = resolveBusinessLineConfig();

  if (!cfg.ok) {
    // OFF or not yet configured → decline safely. No DB, no forwarding.
    console.log(`[telnyx/voice] inbound webhook while ${cfg.reason} — returning reject`);
    return texml(texmlDisabled());
  }

  // Enabled, but real forwarding is intentionally NOT implemented in this
  // increment. Fail safe by declining rather than guessing. The next increment
  // replaces this block with verify → parse → tenant lookup → <Dial>.
  console.log("[telnyx/voice] inbound webhook (enabled) — forwarding not yet implemented; reject");
  return texml(texmlDisabled());
}
