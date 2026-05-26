/**
 * Phase: SES deliverability hardening — SNS webhook for SES events.
 *
 * AWS SES publishes bounce / complaint / delivery notifications to an
 * SNS topic. SNS POSTs each notification to this endpoint as a JSON
 * envelope. We:
 *
 *   1. Authenticate the request:
 *      - Require the SNS `TopicArn` to match an env allowlist.
 *      - Verify the SNS message signature against AWS public certs.
 *      - Both checks must pass; if either fails we return 401.
 *
 *   2. On `SubscriptionConfirmation`: fetch the `SubscribeURL` (one-
 *      shot SNS handshake) and return 200. SNS sends this exactly
 *      once when ops first subscribes us to the topic; the handshake
 *      cannot be deferred.
 *
 *   3. On `Notification` with a SES bounce/complaint:
 *      - For PERMANENT bounces and complaints → UPSERT into
 *        email_suppressions via lib/email-suppression.
 *      - For TRANSIENT bounces → log only (the engine should retry
 *        later, not suppress).
 *      - Fire an adminNotify alert (warning severity) on the FIRST
 *        bounce/complaint per address (dedupe-keyed by address).
 *
 *   4. On `Notification` with a SES delivery event → log only. We
 *      don't currently surface successful deliveries beyond
 *      communication_logs (which records `status='sent'` at the
 *      send site).
 *
 *   5. Always respond 200 once the message has been processed (or
 *      categorically ignored) so SNS doesn't retry-storm us. The
 *      ONLY 4xx/5xx returns are authentication failures.
 *
 * SECURITY MODEL:
 *   - TopicArn allowlist (env `SES_SNS_TOPIC_ARNS`, comma-separated).
 *     Unknown topics → 401, no body parsed.
 *   - SNS signature verification using AWS's published cert chain.
 *     We refuse messages that fail signature verification, including
 *     SubscriptionConfirmation messages (otherwise an attacker could
 *     subscribe us to their topic).
 *   - We never echo back attacker-controlled content; only the
 *     diagnostic email + bounce reason (which SES sourced from the
 *     receiver MTA) lands in our DB, and that's bounded to 320/text.
 *
 * OPERATIONS:
 *   - To enable: configure SES bounce + complaint notifications to
 *     publish to an SNS topic, then subscribe HTTPS endpoint
 *     `https://app.zentromeet.com/api/webhooks/ses` to that topic.
 *     Add the topic ARN(s) to `SES_SNS_TOPIC_ARNS` in .env.
 *   - SubscriptionConfirmation requires the endpoint to GET the
 *     `SubscribeURL` from inside the message. This is automatic in
 *     this handler — no manual step.
 *   - For local testing, send a synthetic POST with a recognized
 *     TopicArn in the env allowlist and the signature check will
 *     fail with 401; ops must use SNS-published events in prod.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

import { recordSuppression } from "@/lib/email-suppression";
import { adminNotify } from "@/lib/admin-notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Allowlisted topic ARNs ──────────────────────────────────────────

function allowedTopicArns(): string[] {
  const raw = process.env.SES_SNS_TOPIC_ARNS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─── SNS signature verification ──────────────────────────────────────
// Reference: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

/** Cache fetched signing certificates per URL (AWS rotates them, but
 *  the same cert is reused for many messages — cache so we don't
 *  fetch on every event). 1-hour TTL. */
const certCache = new Map<string, { pem: string; expiresAt: number }>();

async function fetchSigningCert(url: string): Promise<string | null> {
  // AWS SNS signing certs always live on sns.<region>.amazonaws.com
  // — never trust a URL that isn't on that exact host pattern.
  const u = new URL(url);
  if (u.protocol !== "https:") return null;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return null;
  const cached = certCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.pem;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "ZentroMeet-SNS-Verify/1.0" } });
    if (!res.ok) return null;
    const pem = await res.text();
    certCache.set(url, { pem, expiresAt: Date.now() + 60 * 60_000 });
    return pem;
  } catch {
    return null;
  }
}

type SnsEnvelope = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
};

/** Build the canonical "string to sign" per the SNS spec. The fields
 *  + their order differ between Notification and Subscription messages. */
function buildStringToSign(env: SnsEnvelope): string | null {
  let fields: Array<[string, string | undefined]>;
  if (env.Type === "Notification") {
    fields = [
      ["Message", env.Message],
      ["MessageId", env.MessageId],
      ["Subject", env.Subject],
      ["Timestamp", env.Timestamp],
      ["TopicArn", env.TopicArn],
      ["Type", env.Type],
    ];
  } else if (env.Type === "SubscriptionConfirmation" || env.Type === "UnsubscribeConfirmation") {
    fields = [
      ["Message", env.Message],
      ["MessageId", env.MessageId],
      ["SubscribeURL", env.SubscribeURL],
      ["Timestamp", env.Timestamp],
      ["Token", env.Token],
      ["TopicArn", env.TopicArn],
      ["Type", env.Type],
    ];
  } else {
    return null;
  }
  // Per spec: include only fields whose value is defined; emit
  // "key\nvalue\n" pairs in the exact order above.
  let s = "";
  for (const [k, v] of fields) {
    if (v === undefined) continue;
    s += `${k}\n${v}\n`;
  }
  return s;
}

async function verifySnsSignature(env: SnsEnvelope): Promise<boolean> {
  const stringToSign = buildStringToSign(env);
  if (!stringToSign) return false;
  const pem = await fetchSigningCert(env.SigningCertURL);
  if (!pem) return false;
  const algo = env.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  try {
    const verifier = crypto.createVerify(algo);
    verifier.update(stringToSign, "utf8");
    return verifier.verify(pem, env.Signature, "base64");
  } catch {
    return false;
  }
}

// ─── SES bounce/complaint payload shapes ─────────────────────────────

type SesBouncedRecipient = {
  emailAddress: string;
  status?: string;
  action?: string;
  diagnosticCode?: string;
};

type SesBounce = {
  bounceType: "Permanent" | "Transient" | "Undetermined";
  bounceSubType?: string;
  bouncedRecipients?: SesBouncedRecipient[];
  feedbackId?: string;
  timestamp?: string;
};

type SesComplaint = {
  complainedRecipients?: Array<{ emailAddress: string }>;
  complaintFeedbackType?: string;
  feedbackId?: string;
  timestamp?: string;
};

type SesDelivery = {
  recipients?: string[];
  smtpResponse?: string;
  timestamp?: string;
};

type SesNotification = {
  notificationType: "Bounce" | "Complaint" | "Delivery";
  bounce?: SesBounce;
  complaint?: SesComplaint;
  delivery?: SesDelivery;
  mail?: { messageId?: string; source?: string };
};

// ─── Route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let envelope: SnsEnvelope;
  try {
    const text = await req.text();
    envelope = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // ── 1. Topic ARN allowlist ─────────────────────────────────────
  const allowed = allowedTopicArns();
  if (allowed.length === 0) {
    // No topics configured at all → reject everything. Ops must set
    // SES_SNS_TOPIC_ARNS before this endpoint is functional.
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (!allowed.includes(envelope.TopicArn)) {
    return NextResponse.json({ error: "topic_not_allowed" }, { status: 401 });
  }

  // ── 2. SNS signature verification ──────────────────────────────
  const sigOk = await verifySnsSignature(envelope);
  if (!sigOk) {
    try {
      console.warn(
        JSON.stringify({
          evt: "ses_webhook_bad_signature",
          ts: new Date().toISOString(),
          topic: envelope.TopicArn,
          type: envelope.Type,
        }),
      );
    } catch {}
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // ── 3. Subscription handshake ──────────────────────────────────
  if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
    try {
      const u = new URL(envelope.SubscribeURL);
      // Same host check as the cert URL — SNS subscribe URLs are on
      // the same sns.<region>.amazonaws.com host.
      if (
        u.protocol === "https:" &&
        /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)
      ) {
        await fetch(envelope.SubscribeURL, { method: "GET" });
      }
    } catch {
      // Subscription will retry from SNS side; ack 200.
    }
    return NextResponse.json({ ok: true, type: "subscription_confirmed" });
  }

  if (envelope.Type !== "Notification") {
    // UnsubscribeConfirmation and anything else: ack + ignore.
    return NextResponse.json({ ok: true, type: "ignored", echo: envelope.Type });
  }

  // ── 4. Parse SES inner payload ─────────────────────────────────
  let inner: SesNotification;
  try {
    inner = JSON.parse(envelope.Message);
  } catch {
    return NextResponse.json({ error: "invalid_inner_payload" }, { status: 200 });
  }

  // ── 5. Bounce handling ─────────────────────────────────────────
  if (inner.notificationType === "Bounce" && inner.bounce) {
    const b = inner.bounce;
    const isPermanent = b.bounceType === "Permanent";
    for (const r of b.bouncedRecipients ?? []) {
      if (!r.emailAddress) continue;
      if (isPermanent) {
        await recordSuppression({
          email: r.emailAddress,
          kind: "bounce",
          bounceSubtype: b.bounceSubType ?? b.bounceType,
          reason: r.diagnosticCode?.slice(0, 1000),
          source: "ses-sns",
          metadata: {
            feedbackId: b.feedbackId,
            action: r.action,
            status: r.status,
            sesMessageId: inner.mail?.messageId,
          },
        });
        // Per-recipient operational alert. Dedupe-keyed by address so
        // a flood from a single mailbox collapses to one alert per
        // cooldown window.
        void adminNotify({
          kind: "email_provider_error",
          severity: "warning",
          summary: `Permanent bounce: ${r.emailAddress}`,
          details: r.diagnosticCode?.slice(0, 500),
          dedupeKey: `bounce::${r.emailAddress.toLowerCase()}`,
          metadata: {
            bounceSubType: b.bounceSubType,
            sesMessageId: inner.mail?.messageId,
            source: inner.mail?.source,
          },
        });
      } else {
        // Transient bounce — log only. The engine MAY retry these.
        try {
          console.warn(
            JSON.stringify({
              evt: "ses_transient_bounce",
              ts: new Date().toISOString(),
              to_domain: r.emailAddress.split("@")[1] ?? "?",
              subType: b.bounceSubType,
              diagnostic: r.diagnosticCode?.slice(0, 200),
            }),
          );
        } catch {}
      }
    }
    return NextResponse.json({ ok: true, type: "bounce", permanent: isPermanent });
  }

  // ── 6. Complaint handling ──────────────────────────────────────
  if (inner.notificationType === "Complaint" && inner.complaint) {
    const c = inner.complaint;
    for (const r of c.complainedRecipients ?? []) {
      if (!r.emailAddress) continue;
      await recordSuppression({
        email: r.emailAddress,
        kind: "complaint",
        reason: c.complaintFeedbackType ?? null,
        source: "ses-sns",
        metadata: {
          feedbackId: c.feedbackId,
          sesMessageId: inner.mail?.messageId,
        },
      });
      void adminNotify({
        kind: "email_provider_error",
        severity: "warning",
        summary: `Spam complaint: ${r.emailAddress}`,
        details: c.complaintFeedbackType ? `feedbackType=${c.complaintFeedbackType}` : undefined,
        dedupeKey: `complaint::${r.emailAddress.toLowerCase()}`,
        metadata: {
          sesMessageId: inner.mail?.messageId,
          source: inner.mail?.source,
        },
      });
    }
    return NextResponse.json({ ok: true, type: "complaint" });
  }

  // ── 7. Delivery confirmation (log only) ────────────────────────
  if (inner.notificationType === "Delivery") {
    try {
      console.log(
        JSON.stringify({
          evt: "ses_delivery",
          ts: new Date().toISOString(),
          sesMessageId: inner.mail?.messageId,
          recipients_count: inner.delivery?.recipients?.length ?? 0,
        }),
      );
    } catch {}
    return NextResponse.json({ ok: true, type: "delivery" });
  }

  // Unknown notificationType — ack + ignore so SNS doesn't retry.
  return NextResponse.json({ ok: true, type: "ignored_unknown" });
}

// Reject other methods cleanly. SNS only POSTs.
export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
