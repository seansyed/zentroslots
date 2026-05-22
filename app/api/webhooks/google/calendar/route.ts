import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { webhookChannels } from "@/db/schema";
import { invalidateConnection } from "@/lib/calendar/freebusyCache";

/**
 * POST /api/webhooks/google/calendar — Wave E
 *
 * Receiver for Google Calendar push notifications. Google posts here
 * when the watched calendar fires an event change (and once at
 * subscribe time with X-Goog-Resource-State: "sync" for handshake).
 *
 * Verification:
 *   • X-Goog-Channel-ID         must match a webhook_channels row
 *   • X-Goog-Channel-Token      must match the stored client_state
 *   • X-Goog-Resource-ID        must match the stored external_resource_id
 * If any mismatch → 200 OK silently (Google retries on non-2xx and
 * we don't want to leak verification timing to a probing attacker).
 *
 * On any verified notification:
 *   • Wave E action = INVALIDATE FREEBUSY CACHE for this connection.
 *     No auto-reconciliation, no booking mutation — the next slot
 *     computation will repopulate with fresh data.
 *   • Sync state header "sync" is the initial handshake — no
 *     invalidation needed (cache is empty for a brand-new channel
 *     anyway).
 *
 * Always returns 200 quickly. Google retries on any non-2xx for ~12h
 * with exponential backoff. We can't afford to make Google retry on a
 * processing hiccup — invalidation is best-effort and idempotent.
 *
 * No body is needed; Google's webhook is header-only.
 */
export async function POST(req: NextRequest) {
  const channelId = req.headers.get("x-goog-channel-id");
  const channelToken = req.headers.get("x-goog-channel-token");
  const resourceId = req.headers.get("x-goog-resource-id");
  const resourceState = req.headers.get("x-goog-resource-state");

  // Missing required headers — probably not from Google.
  if (!channelId || !resourceId) {
    return NextResponse.json({ ok: true });
  }

  // Initial handshake notification carries resource_state="sync".
  // No cached data to invalidate, no action to take, just ack.
  if (resourceState === "sync") {
    return NextResponse.json({ ok: true });
  }

  try {
    const channel = await db.query.webhookChannels.findFirst({
      where: eq(webhookChannels.externalChannelId, channelId),
      columns: {
        connectionId: true,
        externalResourceId: true,
        clientState: true,
      },
    });

    // Verification: channel known, token matches, resource id matches.
    // Failing any of these is silently swallowed — don't reveal which
    // condition tripped.
    if (
      !channel ||
      channel.externalResourceId !== resourceId ||
      (channelToken && channel.clientState !== channelToken)
    ) {
      return NextResponse.json({ ok: true });
    }

    // Wave E action: invalidate freebusy cache for this connection.
    // The next freebusy read repopulates with fresh provider data.
    await invalidateConnection(channel.connectionId);
  } catch (err) {
    // Best-effort path. Logging only — don't fail Google's webhook.
    console.error("[webhooks/google/calendar] processing failed:", err);
  }

  return NextResponse.json({ ok: true });
}

// Google initial probes can come as GET (rare). Accept it gracefully.
export async function GET() {
  return NextResponse.json({ ok: true });
}
