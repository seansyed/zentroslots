import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantPhoneNumbers, tenantPhoneSettings, phoneUsageMonthly, phoneCallLogs, phoneCallEvents } from "@/db/schema";
import { secondsToBillableMinutes } from "@/lib/business-line";
import { readBusinessLineConfig, buildStatusCallbackUrl } from "@/lib/telnyx-business-line";
import { resolveBusinessLineEntitlement, periodForDate } from "@/lib/business-line-view";
import {
  verifyAndParseInbound,
  decideForwarding,
  callLogStatusForDecision,
  texmlForDecision,
  MAX_CALL_SECONDS,
  type ForwardingContext,
} from "@/lib/business-line-forwarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/telnyx/voice — Business Line inbound voice webhook.
 *
 * Flag-gated (TELNYX_BUSINESS_LINE_ENABLED, default OFF). While OFF this returns
 * a safe TeXML <Reject> and touches nothing. While ON it verifies the Telnyx
 * Ed25519 signature, identifies the tenant strictly by the CALLED number,
 * decides whether to forward (entitlement + enabled + valid, non-loop forwarding
 * number + under the monthly cap), logs the call, and returns a TeXML <Dial>
 * ONLY for the fully-valid case — otherwise a safe reject. Caller ID on the
 * forwarded leg is always the business number.
 */
function texml(xml: string, status = 200) {
  return new NextResponse(xml, {
    status,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

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
    // OFF, misconfigured, or bad signature → decline safely. No DB, no forward.
    console.log(`[telnyx/voice] inbound declined (${vp.reason})`);
    return texml(texmlForDecision({ action: "reject", reason: "no_tenant" }));
  }

  const event = vp.event;
  const called = event.to;
  const caller = event.from;

  try {
    // Identify the tenant STRICTLY by the called business number (active row).
    const numberRow = called
      ? await db.query.tenantPhoneNumbers.findFirst({
          where: and(eq(tenantPhoneNumbers.phoneNumber, called), eq(tenantPhoneNumbers.status, "active")),
        })
      : null;

    let ctx: ForwardingContext = {
      tenantMatched: false,
      businessNumber: null,
      ownedNumbers: [],
      settingsEnabled: false,
      entitlementActive: false,
      forwardingNumber: null,
      minutesUsed: 0,
      monthlyMinuteCap: 0,
    };

    if (numberRow) {
      const tenantId = numberRow.tenantId;
      const period = periodForDate(new Date());
      const [settings, owned, usage] = await Promise.all([
        db.query.tenantPhoneSettings.findFirst({ where: eq(tenantPhoneSettings.tenantId, tenantId) }),
        db.query.tenantPhoneNumbers.findMany({
          where: eq(tenantPhoneNumbers.tenantId, tenantId),
          columns: { phoneNumber: true },
        }),
        db.query.phoneUsageMonthly.findFirst({
          where: and(eq(phoneUsageMonthly.tenantId, tenantId), eq(phoneUsageMonthly.period, period)),
        }),
      ]);
      ctx = {
        tenantMatched: true,
        businessNumber: numberRow.phoneNumber,
        ownedNumbers: owned.map((o) => o.phoneNumber),
        settingsEnabled: settings?.enabled ?? false,
        entitlementActive: resolveBusinessLineEntitlement(settings?.metadata).active,
        forwardingNumber: settings?.forwardingNumber ?? null,
        minutesUsed: secondsToBillableMinutes(usage?.billableSeconds ?? 0),
        monthlyMinuteCap: settings?.monthlyMinuteCap ?? 0,
      };
    }

    const decision = decideForwarding(ctx);

    // Persist the call (best-effort) + the raw event (idempotent). A logging
    // failure must NOT change the decision we already made.
    if (numberRow) {
      await persistInboundCall({
        tenantId: numberRow.tenantId,
        phoneNumberId: numberRow.id,
        sessionId: event.callSessionId,
        controlId: event.callControlId,
        legId: event.callLegId,
        eventId: event.eventId,
        from: caller,
        to: called,
        forwardedTo: decision.action === "dial" ? decision.forwardingNumber : null,
        status: callLogStatusForDecision(decision),
        includedMinutes: ctx.monthlyMinuteCap,
      }).catch((e) => console.error("[telnyx/voice] persist failed (non-fatal):", e instanceof Error ? e.message : e));
    }

    const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
    const statusCallbackUrl = appBaseUrl ? buildStatusCallbackUrl(appBaseUrl) : null;
    return texml(texmlForDecision(decision, { statusCallbackUrl, timeLimitSeconds: MAX_CALL_SECONDS }));
  } catch (err) {
    // Fail safe: never forward on an unexpected error.
    console.error("[telnyx/voice] handler error — declining:", err instanceof Error ? err.message : err);
    return texml(texmlForDecision({ action: "reject", reason: "no_tenant" }));
  }
}

/** Insert the inbound call log (idempotent on session id) + bump the monthly
 *  inbound counter once. Pure I/O — all decisions are made by the caller. */
async function persistInboundCall(args: {
  tenantId: string;
  phoneNumberId: string;
  sessionId: string | null;
  controlId: string | null;
  legId: string | null;
  eventId: string | null;
  from: string | null;
  to: string | null;
  forwardedTo: string | null;
  status: string;
  includedMinutes: number;
}) {
  // Skip if we've already logged this session (Telnyx retried the control req).
  if (args.sessionId) {
    const existing = await db.query.phoneCallLogs.findFirst({
      where: eq(phoneCallLogs.telnyxCallSessionId, args.sessionId),
    });
    if (existing) return;
  }

  await db.insert(phoneCallLogs).values({
    tenantId: args.tenantId,
    phoneNumberId: args.phoneNumberId,
    direction: "inbound",
    fromNumber: args.from,
    toNumber: args.to,
    forwardedToNumber: args.forwardedTo,
    status: args.status,
    startedAt: new Date(),
    telnyxCallSessionId: args.sessionId,
    telnyxCallControlId: args.controlId,
    telnyxCallLegId: args.legId,
  } as typeof phoneCallLogs.$inferInsert);

  // Count the inbound call once for the month.
  const period = periodForDate(new Date());
  await db
    .insert(phoneUsageMonthly)
    .values({
      tenantId: args.tenantId,
      period,
      inboundCalls: 1,
      includedMinutes: args.includedMinutes || null,
    } as typeof phoneUsageMonthly.$inferInsert)
    .onConflictDoUpdate({
      target: [phoneUsageMonthly.tenantId, phoneUsageMonthly.period],
      set: {
        inboundCalls: sql`${phoneUsageMonthly.inboundCalls} + 1`,
        updatedAt: new Date(),
      },
    });

  // Record the raw inbound event (idempotent) for forensics.
  if (args.eventId) {
    await db
      .insert(phoneCallEvents)
      .values({
        tenantId: args.tenantId,
        telnyxEventId: args.eventId,
        eventType: "call.initiated",
        signatureVerified: true,
      } as typeof phoneCallEvents.$inferInsert)
      .onConflictDoNothing({ target: phoneCallEvents.telnyxEventId });
  }
}
