import { NextRequest, NextResponse } from "next/server";

import { readBusinessLineConfig } from "@/lib/telnyx-business-line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/telnyx/voice/status — Business Line call status callbacks.
 *
 * ── INCREMENT 2: SKELETON, FEATURE-FLAGGED OFF ──
 * Status callbacks only need a 2xx ack — there is no TeXML response here. While
 * TELNYX_BUSINESS_LINE_ENABLED !== "true" (the default), this endpoint reads
 * NOTHING from the database and updates NO call logs. No secrets are logged.
 *
 * ── Where the next increment plugs in (behind the same flag, when enabled) ──
 *   1. read the raw body + verifyTelnyxSignature(...)
 *   2. parseTelnyxCallEvent(JSON.parse(raw))
 *   3. insert phone_call_events (idempotent on telnyx_event_id)
 *   4. update phone_call_logs (status/answered_at/ended_at/duration) and roll
 *      the duration into phone_usage_monthly
 * None of steps 1–4 run today.
 */
export async function POST(_req: NextRequest) {
  const cfg = readBusinessLineConfig();

  if (!cfg.enabled) {
    // OFF → ack only. No DB, no log mutation.
    return NextResponse.json({ ok: true, disabled: true });
  }

  // Enabled, but persistence is intentionally NOT implemented in this
  // increment. Ack so Telnyx does not retry; do nothing else.
  console.log("[telnyx/voice/status] event received (enabled) — persistence not yet implemented");
  return NextResponse.json({ ok: true });
}
