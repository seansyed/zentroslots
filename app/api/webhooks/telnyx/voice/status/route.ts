import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { phoneCallLogs, phoneCallEvents, phoneUsageMonthly } from "@/db/schema";
import { type CallStatus } from "@/lib/business-line";
import { readBusinessLineConfig } from "@/lib/telnyx-business-line";
import { periodForDate } from "@/lib/business-line-view";
import { verifyAndParseInbound, planStatusUpdate } from "@/lib/business-line-forwarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/telnyx/voice/status — Business Line call status callbacks.
 *
 * Flag-gated. While OFF this just acks (200). While ON it verifies the Telnyx
 * signature, dedupes by telnyx_event_id (idempotent), advances the call log's
 * status monotonically (never regressing a completed call), computes duration +
 * billable seconds, and rolls the usage counters for the month. Status callbacks
 * never return TeXML — only a 2xx ack.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const config = readBusinessLineConfig();

  const vp = verifyAndParseInbound({
    config,
    rawBody: raw,
    signatureB64: req.headers.get("telnyx-signature-ed25519"),
    timestamp: req.headers.get("telnyx-timestamp"),
  });
  if (!vp.ok) {
    if (vp.reason === "disabled") return NextResponse.json({ ok: true, disabled: true });
    // Bad signature → do not process. Ack so Telnyx doesn't retry-storm.
    console.log("[telnyx/voice/status] rejected (invalid_signature)");
    return NextResponse.json({ ok: false, reason: "invalid_signature" }, { status: 200 });
  }

  const event = vp.event;

  try {
    // Idempotency: first insert of this event id wins; a retry returns [].
    if (event.eventId) {
      const inserted = await db
        .insert(phoneCallEvents)
        .values({
          telnyxEventId: event.eventId,
          eventType: event.eventType ?? "unknown",
          signatureVerified: true,
        } as typeof phoneCallEvents.$inferInsert)
        .onConflictDoNothing({ target: phoneCallEvents.telnyxEventId })
        .returning({ id: phoneCallEvents.id });
      if (inserted.length === 0) {
        return NextResponse.json({ ok: true, duplicate: true });
      }
    }

    // Correlate to the call log by the stable session id.
    const log = event.callSessionId
      ? await db.query.phoneCallLogs.findFirst({
          where: eq(phoneCallLogs.telnyxCallSessionId, event.callSessionId),
        })
      : null;
    if (!log) {
      // Nothing to update (event arrived before the inbound log, or no session).
      return NextResponse.json({ ok: true, uncorrelated: true });
    }

    const incomingRaw = deriveIncomingStatus(event.eventType, log.status as CallStatus);
    const plan = planStatusUpdate({
      currentStatus: log.status as CallStatus,
      incomingStatusRaw: incomingRaw,
      durationSeconds: event.durationSeconds,
    });
    if (!plan) {
      return NextResponse.json({ ok: true, noop: true });
    }

    // Update the call log (monotonic — planStatusUpdate already guarded it).
    await db
      .update(phoneCallLogs)
      .set({
        status: plan.nextStatus,
        answeredAt: plan.nextStatus === "answered" && !log.answeredAt ? new Date() : log.answeredAt,
        endedAt: plan.becameTerminal ? new Date() : log.endedAt,
        durationSeconds: plan.durationSeconds ?? log.durationSeconds,
        billableSeconds: plan.becameTerminal ? plan.billableSeconds : log.billableSeconds,
        costEstimateCents: plan.becameTerminal ? plan.usageDelta.estimatedCostCents : log.costEstimateCents,
        updatedAt: new Date(),
      })
      .where(eq(phoneCallLogs.id, log.id));

    // Link the event row to the call + tenant for forensics.
    if (event.eventId) {
      await db
        .update(phoneCallEvents)
        .set({ tenantId: log.tenantId, callLogId: log.id })
        .where(eq(phoneCallEvents.telnyxEventId, event.eventId));
    }

    // Roll monthly usage ONCE, on the first terminal transition.
    if (plan.becameTerminal) {
      const d = plan.usageDelta;
      const period = periodForDate(new Date());
      await db
        .insert(phoneUsageMonthly)
        .values({
          tenantId: log.tenantId,
          period,
          answeredCalls: d.answeredCalls,
          missedCalls: d.missedCalls,
          billableSeconds: d.billableSeconds,
          estimatedCostCents: d.estimatedCostCents,
        } as typeof phoneUsageMonthly.$inferInsert)
        .onConflictDoUpdate({
          target: [phoneUsageMonthly.tenantId, phoneUsageMonthly.period],
          set: {
            answeredCalls: sql`${phoneUsageMonthly.answeredCalls} + ${d.answeredCalls}`,
            missedCalls: sql`${phoneUsageMonthly.missedCalls} + ${d.missedCalls}`,
            billableSeconds: sql`${phoneUsageMonthly.billableSeconds} + ${d.billableSeconds}`,
            estimatedCostCents: sql`${phoneUsageMonthly.estimatedCostCents} + ${d.estimatedCostCents}`,
            updatedAt: new Date(),
          },
        });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Ack to avoid retry storms; the event is already deduped if it inserted.
    console.error("[telnyx/voice/status] handler error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: true });
  }
}

/**
 * Map a Telnyx event type to an incoming call status, using the current status
 * to disambiguate a hangup (answered → completed; never-answered → missed).
 */
function deriveIncomingStatus(eventType: string | null, currentStatus: CallStatus): string | null {
  const t = (eventType ?? "").toLowerCase();
  if (t === "call.answered" || t === "call.bridged") return "answered";
  if (t === "call.hangup") return currentStatus === "answered" ? "completed" : "missed";
  if (t === "call.initiated") return "ringing";
  return eventType; // let normalizeCallStatus handle/ignore anything else
}
