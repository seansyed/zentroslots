/**
 * Tenant-owned SMS sender.
 *
 * Per spec: each tenant brings their OWN Twilio / Telnyx credentials —
 * the platform never holds global SMS keys. Provider config lives in
 * `tenant_sms_providers` (auth token encrypted via lib/crypto).
 *
 * Mirrors lib/email.ts contract:
 *   - never throws upward (booking flows must not fail on SMS errors)
 *   - audit-logs every attempt (`sms.sent` / `sms.failed`)
 *   - increments per-tenant counters for usage tracking
 *
 * Implementation uses native fetch — no Twilio/Telnyx SDK dependency.
 * Both providers expose simple REST APIs over HTTPS.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantSmsProviders } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { audit } from "@/lib/audit";

export type SmsProviderKind = "twilio" | "telnyx";

export type SendSmsArgs = {
  tenantId: string;
  to: string;        // E.164 preferred ("+15551234567")
  body: string;
  audit?: {
    kind: string;    // e.g. 'reminder.24h' | 'reminder.1h' | 'confirmation' | 'test'
    bookingId?: string;
  };
};

export type SendSmsResult =
  | { ok: true; provider: SmsProviderKind; providerMessageId: string | null }
  | { ok: false; reason: "no_provider" | "send_failed" | "decrypt_failed"; error?: string };

/**
 * Sends an SMS using the tenant's own provider. Returns a result object;
 * never throws. Callers should treat all outcomes as best-effort.
 */
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const provider = await db.query.tenantSmsProviders.findFirst({
    where: and(eq(tenantSmsProviders.tenantId, args.tenantId), eq(tenantSmsProviders.active, true)),
  });

  if (!provider) {
    return { ok: false, reason: "no_provider" };
  }

  let authToken: string | null;
  try {
    authToken = decryptSecret(provider.authTokenEncrypted);
  } catch (e) {
    console.error("[sms] failed to decrypt token", e);
    await markFailure(args.tenantId, "Failed to decrypt provider credentials.", args.audit);
    return { ok: false, reason: "decrypt_failed", error: "Credential envelope unreadable. Reconnect the provider." };
  }
  if (!authToken) {
    await markFailure(args.tenantId, "Provider credentials are empty.", args.audit);
    return { ok: false, reason: "decrypt_failed", error: "Empty credentials." };
  }

  try {
    let result: { providerMessageId: string | null };
    if (provider.provider === "twilio") {
      result = await sendViaTwilio({
        accountSid: provider.accountId ?? "",
        authToken,
        from: provider.senderId,
        to: args.to,
        body: args.body,
      });
    } else if (provider.provider === "telnyx") {
      result = await sendViaTelnyx({
        apiKey: authToken,
        // Telnyx supports either a single from number or a messaging
        // profile id. accountId holds the optional messaging profile.
        messagingProfileId: provider.accountId || null,
        from: provider.senderId,
        to: args.to,
        body: args.body,
      });
    } else {
      throw new Error(`Unknown provider: ${provider.provider}`);
    }

    await markSuccess(args.tenantId);
    audit({
      tenantId: args.tenantId,
      action: "sms.sent",
      entityType: "sms",
      entityId: result.providerMessageId ?? undefined,
      metadata: {
        provider: provider.provider,
        to: redactPhone(args.to),
        kind: args.audit?.kind ?? "manual",
        bookingId: args.audit?.bookingId,
        messageId: result.providerMessageId,
      },
    });
    return { ok: true, provider: provider.provider as SmsProviderKind, providerMessageId: result.providerMessageId };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[sms] send failed", errMsg);
    await markFailure(args.tenantId, errMsg, args.audit);
    audit({
      tenantId: args.tenantId,
      action: "sms.failed",
      entityType: "sms",
      metadata: {
        provider: provider.provider,
        to: redactPhone(args.to),
        kind: args.audit?.kind ?? "manual",
        bookingId: args.audit?.bookingId,
        error: errMsg.slice(0, 500),
      },
    });
    return { ok: false, reason: "send_failed", error: errMsg };
  }
}

// ─── Twilio ─────────────────────────────────────────────────────────────
// https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource

async function sendViaTwilio(args: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
}): Promise<{ providerMessageId: string | null }> {
  if (!args.accountSid) {
    throw new Error("Twilio Account SID is missing.");
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(args.accountSid)}/Messages.json`;
  const form = new URLSearchParams({ To: args.to, From: args.from, Body: args.body });
  const auth = Buffer.from(`${args.accountSid}:${args.authToken}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Twilio responds with a JSON error body — surface the message field.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: number };
      detail = parsed.message ?? text;
    } catch { /* leave as-is */ }
    throw new Error(`Twilio ${res.status}: ${detail}`);
  }
  let providerMessageId: string | null = null;
  try {
    providerMessageId = (JSON.parse(text) as { sid?: string }).sid ?? null;
  } catch { /* ignore */ }
  return { providerMessageId };
}

// ─── Telnyx ─────────────────────────────────────────────────────────────
// https://developers.telnyx.com/api/messaging/send-message

async function sendViaTelnyx(args: {
  apiKey: string;
  messagingProfileId: string | null;
  from: string;
  to: string;
  body: string;
}): Promise<{ providerMessageId: string | null }> {
  const payload: Record<string, string> = { from: args.from, to: args.to, text: args.body };
  if (args.messagingProfileId) payload.messaging_profile_id = args.messagingProfileId;

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ detail?: string; title?: string }> };
      detail = parsed.errors?.[0]?.detail ?? parsed.errors?.[0]?.title ?? text;
    } catch { /* leave as-is */ }
    throw new Error(`Telnyx ${res.status}: ${detail}`);
  }
  let providerMessageId: string | null = null;
  try {
    providerMessageId = (JSON.parse(text) as { data?: { id?: string } }).data?.id ?? null;
  } catch { /* ignore */ }
  return { providerMessageId };
}

// ─── Per-tenant counters ────────────────────────────────────────────────

async function markSuccess(tenantId: string) {
  await db
    .update(tenantSmsProviders)
    .set({
      totalSent: sql`${tenantSmsProviders.totalSent} + 1`,
      lastSendAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tenantSmsProviders.tenantId, tenantId));
}

async function markFailure(
  tenantId: string,
  message: string,
  _ctx?: SendSmsArgs["audit"]
) {
  await db
    .update(tenantSmsProviders)
    .set({
      totalFailed: sql`${tenantSmsProviders.totalFailed} + 1`,
      lastError: message.slice(0, 1000),
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tenantSmsProviders.tenantId, tenantId));
}

/**
 * Mask a phone number for audit logs — keeps only the country prefix and
 * last 2 digits. Real numbers shouldn't end up in long-term log storage.
 */
function redactPhone(p: string): string {
  if (p.length <= 4) return "•".repeat(p.length);
  const visible = 2;
  const head = p.startsWith("+") ? p.slice(0, 2) : "";
  const tail = p.slice(-visible);
  return `${head}${"•".repeat(Math.max(0, p.length - head.length - visible))}${tail}`;
}

// E.164 validator. Permissive on length (some short codes are 5-6 digits)
// but enforces digit-only-after-optional-plus.
export function looksLikePhoneNumber(s: string): boolean {
  return /^\+?[1-9]\d{4,14}$/.test(s.trim());
}
