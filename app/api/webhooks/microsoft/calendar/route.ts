import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { webhookChannels } from "@/db/schema";
import { invalidateConnection } from "@/lib/calendar/freebusyCache";

/**
 * POST /api/webhooks/microsoft/calendar — Wave E
 *
 * Two distinct request shapes hit this endpoint:
 *
 * 1) Subscription validation (one-time, on create).
 *    Microsoft sends `?validationToken=...` as a QUERY PARAM and
 *    expects the raw token returned as `text/plain` within 10s. If we
 *    don't reply correctly, the subscription is rejected.
 *
 * 2) Change notifications.
 *    POST body: { value: [{ subscriptionId, clientState, resource,
 *                            changeType, resourceData }] }
 *    For each item we verify `clientState` matches the stored row's
 *    `client_state`, then invalidate freebusy cache for that connection.
 *
 * Always returns 202 / 200 quickly. Microsoft retries on non-2xx
 * for ~4h, then drops the notification — we don't want that.
 *
 * Wave E action = invalidation only. No booking mutation.
 */
export async function POST(req: NextRequest) {
  // ── Validation handshake ───────────────────────────────────────
  // Graph sends validationToken as a query param on the FIRST POST
  // to the URL when the subscription is created. The body might be
  // empty or present; we ignore it. Reply with the token verbatim.
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // ── Change notifications ───────────────────────────────────────
  try {
    const payload = (await req.json()) as {
      value?: Array<{
        subscriptionId?: string;
        clientState?: string;
        resource?: string;
        changeType?: string;
      }>;
    };
    const notifications = Array.isArray(payload?.value) ? payload.value : [];

    // Collect unique subscription ids so we don't re-look-up the same
    // channel multiple times if Graph batches several notifications.
    const subscriptionIds = new Set<string>();
    const stateById = new Map<string, string>();
    for (const n of notifications) {
      if (n.subscriptionId) {
        subscriptionIds.add(n.subscriptionId);
        if (n.clientState) stateById.set(n.subscriptionId, n.clientState);
      }
    }

    for (const subId of subscriptionIds) {
      const channel = await db.query.webhookChannels.findFirst({
        where: eq(webhookChannels.externalChannelId, subId),
        columns: { connectionId: true, clientState: true },
      });
      if (!channel) continue;
      // Verify clientState. If absent on the notification OR mismatch,
      // skip silently — don't leak.
      const incoming = stateById.get(subId);
      if (incoming && channel.clientState !== incoming) continue;

      await invalidateConnection(channel.connectionId);
    }
  } catch (err) {
    console.error("[webhooks/microsoft/calendar] processing failed:", err);
  }

  // 202 Accepted is the documented success code for Graph webhooks.
  return new NextResponse(null, { status: 202 });
}

// Graph occasionally probes with GET; accept gracefully.
export async function GET(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return NextResponse.json({ ok: true });
}
