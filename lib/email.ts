/**
 * Best-effort email sender.
 * - If SMTP_HOST is set, sends via nodemailer.
 *   AWS SES SMTP works out of the box: set
 *     SMTP_HOST=email-smtp.<region>.amazonaws.com
 *     SMTP_PORT=587
 *     SMTP_USER=<SES SMTP user>
 *     SMTP_PASS=<SES SMTP password>
 *     SES_REGION=us-east-1  (informational only — encoded in SMTP_HOST)
 * - If RESEND_API_KEY / POSTMARK_TOKEN are set instead, uses those.
 * - Otherwise logs a stub to stdout so devs can see the message in `npm run dev`.
 * - Every send is wrapped in try/catch by the caller — this module never
 *   throws upward. Booking creation must never fail because of email.
 *
 * Centralization rules:
 *   - This file is the ONLY place that talks to a real SMTP server or
 *     transactional-email API.
 *   - The Nodemailer transport is created exactly ONCE per process
 *     (`smtpTransporterPromise` cache). All callers reuse it.
 *   - `verifySmtpTransport()` is exposed for health checks; the result
 *     is cached for HEALTH_CACHE_MS so the LB probe never DDOSes SES.
 */

import { formatInTimeZone } from "date-fns-tz";
import { buildBookingActionUrl } from "@/lib/tokens";
import { audit } from "@/lib/audit";

type Attachment = {
  filename: string;
  content: string | Buffer;
  contentType?: string;
};

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
  /** Optional override for the From header. When unset, falls back to
   *  EMAIL_FROM env. The override is intentionally narrow — caller is
   *  responsible for using a domain we've verified with SES, otherwise
   *  SES will reject with 554 / 550. */
  from?: string;
  /** Optional Reply-To header. Autoresponders route human replies to
   *  SUPPORT_EMAIL via this header so the bounce path stays clean. */
  replyTo?: string;
  /**
   * Optional audit context. When provided, sendEmail writes an entry to
   * the audit log with action='email.sent' or 'email.failed' so the
   * Email log page can surface delivery.
   */
  audit?: {
    tenantId: string;
    kind: string;            // e.g. 'confirmation' | 'cancellation' | 'reschedule' | 'reminder'
    bookingId?: string;
  };
};

type Provider = "resend" | "postmark" | "smtp" | "stub";

export function activeProvider(): Provider {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.POSTMARK_TOKEN) return "postmark";
  if (process.env.SMTP_HOST)      return "smtp";
  return "stub";
}

/** Categorized failure code for structured logging + health surface. */
export type EmailFailureCategory =
  | "transport_unavailable"   // no transporter could be initialised
  | "auth"                    // SMTP auth failure (535, etc.)
  | "rate_limit"              // SES throttled us
  | "address_rejected"        // bad recipient / sender
  | "network"                 // connection refused / timeout / DNS
  | "tls"                     // TLS handshake failed
  | "config"                  // missing required env vars
  | "provider_api"            // Resend/Postmark non-2xx
  | "unknown";

let smtpTransporterPromise: Promise<unknown> | null = null;

/** Internal — lazy single transport. SAFE to call from many places;
 *  the promise is cached so we never instantiate twice. */
async function getSmtpTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (smtpTransporterPromise) return smtpTransporterPromise;
  smtpTransporterPromise = (async () => {
    const nodemailer = await import("nodemailer");
    // Nodemailer's typed overloads are strict; we build an
    // SMTPTransport.Options shape and cast through unknown to satisfy
    // the loose default overload at the call site.
    const smtpOpts = {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      // Conservative pool settings — SES default is 14 send/sec at
      // ramp-up; we let nodemailer queue rather than open a flood of
      // sockets. Override with SMTP_POOL=false to disable.
      pool: process.env.SMTP_POOL !== "false",
      maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS ?? 5),
      maxMessages: Number(process.env.SMTP_MAX_MESSAGES ?? 100),
    };
    return nodemailer.createTransport(smtpOpts as unknown as Parameters<typeof nodemailer.createTransport>[0]);
  })();
  return smtpTransporterPromise;
}

// ─── Verification + health surface ─────────────────────────────────────

/** Last-known verify result. Cached so /api/health doesn't open a new
 *  TLS handshake on every probe. */
type VerifyState = {
  ok: boolean;
  checkedAt: number;
  detail?: string;
  category?: EmailFailureCategory;
};
let verifyCache: VerifyState | null = null;
const VERIFY_CACHE_MS = 60_000; // 1 minute — fresh enough for LB, gentle on SES

/** Categorize a thrown Error from Nodemailer / Resend / Postmark into a
 *  closed enum the dashboard can surface. Pure, never throws. */
export function categorizeEmailError(err: unknown): EmailFailureCategory {
  if (!err) return "unknown";
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string; responseCode?: number }).code ?? "";
  const responseCode = (err as { responseCode?: number }).responseCode ?? 0;
  // Nodemailer surfaces e.code = 'EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'…
  if (code === "EAUTH" || responseCode === 535 || /auth/i.test(message)) return "auth";
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EDNS") return "network";
  if (code === "ESOCKET" || /tls|certificate/i.test(message)) return "tls";
  if (responseCode === 421 || responseCode === 450 || /throttl|rate/i.test(message)) return "rate_limit";
  if (responseCode === 550 || responseCode === 553 || /recipient|sender|address/i.test(message)) return "address_rejected";
  if (/resend|postmark/i.test(message)) return "provider_api";
  if (/SMTP_HOST|EMAIL_FROM|not initial/i.test(message)) return "config";
  return "unknown";
}

/** Verify the SMTP transport is reachable + auth works.
 *  Returns the cached result if checked recently. Soft-fails: any error
 *  is captured into the result, never thrown. */
export async function verifySmtpTransport(opts: {
  force?: boolean;
  timeoutMs?: number;
} = {}): Promise<VerifyState> {
  const provider = activeProvider();
  // For non-SMTP providers there is nothing to verify against — the
  // Resend/Postmark APIs don't expose a "ping" endpoint. Report ok=true
  // with a detail string so health stays green.
  if (provider !== "smtp") {
    const state: VerifyState = {
      ok: true,
      checkedAt: Date.now(),
      detail: `provider=${provider}; no_verify_needed`,
    };
    verifyCache = state;
    return state;
  }

  if (!opts.force && verifyCache && Date.now() - verifyCache.checkedAt < VERIFY_CACHE_MS) {
    return verifyCache;
  }

  const timeoutMs = opts.timeoutMs ?? 5_000;
  try {
    const transporter = (await getSmtpTransporter()) as
      | { verify: () => Promise<true> }
      | null;
    if (!transporter) {
      const state: VerifyState = {
        ok: false,
        checkedAt: Date.now(),
        category: "transport_unavailable",
        detail: "SMTP_HOST not configured",
      };
      verifyCache = state;
      return state;
    }
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`smtp_verify_timeout_${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    const state: VerifyState = {
      ok: true,
      checkedAt: Date.now(),
      detail: `provider=smtp; host=${process.env.SMTP_HOST}`,
    };
    verifyCache = state;
    return state;
  } catch (err) {
    const category = categorizeEmailError(err);
    const detail = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    console.error("[email:verify_failed]", { category, detail });
    const state: VerifyState = {
      ok: false,
      checkedAt: Date.now(),
      category,
      detail,
    };
    verifyCache = state;
    return state;
  }
}

/** Public introspection — what's currently configured? Safe to expose
 *  via health endpoints; never returns secrets. */
export function getEmailProviderInfo(): {
  provider: Provider;
  from: string;
  smtpHost: string | null;
  smtpPort: number | null;
  sesRegion: string | null;
  supportEmail: string | null;
  demoEmail: string | null;
} {
  return {
    provider: activeProvider(),
    from: process.env.EMAIL_FROM ?? "(unset)",
    smtpHost: process.env.SMTP_HOST ?? null,
    smtpPort: process.env.SMTP_HOST ? Number(process.env.SMTP_PORT ?? 587) : null,
    sesRegion: process.env.SES_REGION ?? null,
    supportEmail: process.env.SUPPORT_EMAIL ?? null,
    demoEmail: process.env.DEMO_EMAIL ?? null,
  };
}

// ─── Provider-specific senders ─────────────────────────────────────────
// Each returns void on success or throws. Wrapped by sendEmail() in a
// try/catch so failures are logged + audited but never propagate.

async function sendViaResend(args: SendArgs, from: string): Promise<void> {
  const key = process.env.RESEND_API_KEY!;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from,
      to: args.to,
      reply_to: args.replyTo,
      subject: args.subject,
      html: args.html,
      text: args.text,
      attachments: args.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function sendViaPostmark(args: SendArgs, from: string): Promise<void> {
  const token = process.env.POSTMARK_TOKEN!;
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Postmark-Server-Token": token, Accept: "application/json" },
    body: JSON.stringify({
      From: from,
      To: args.to,
      ReplyTo: args.replyTo,
      Subject: args.subject,
      HtmlBody: args.html,
      TextBody: args.text,
      Attachments: args.attachments?.map((a) => ({
        Name: a.filename,
        Content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
        ContentType: a.contentType ?? "application/octet-stream",
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Postmark ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function sendViaSmtp(args: SendArgs, from: string): Promise<void> {
  const transporter = (await getSmtpTransporter()) as
    | { sendMail: (opts: unknown) => Promise<unknown> }
    | null;
  if (!transporter) throw new Error("SMTP transporter not initialised");
  await transporter.sendMail({
    from,
    to: args.to,
    replyTo: args.replyTo,
    subject: args.subject,
    html: args.html,
    text: args.text,
    attachments: args.attachments,
  });
}

export async function sendEmail(args: SendArgs): Promise<{ ok: boolean; reason?: string; provider?: Provider }> {
  const from = args.from ?? process.env.EMAIL_FROM ?? "ZentroMeet <no-reply@localhost>";
  const provider = activeProvider();
  let result: { ok: boolean; reason?: string };

  try {
    switch (provider) {
      case "resend":
        await sendViaResend(args, from);
        result = { ok: true };
        break;
      case "postmark":
        await sendViaPostmark(args, from);
        result = { ok: true };
        break;
      case "smtp":
        await sendViaSmtp(args, from);
        result = { ok: true };
        break;
      case "stub":
        console.log("[email:stub]", { to: args.to, subject: args.subject });
        result = { ok: true, reason: "stub" };
        break;
    }
  } catch (err) {
    const category = categorizeEmailError(err);
    const message = err instanceof Error ? err.message : "unknown";
    // Structured single-line log — easy to grep / forward to a log
    // aggregator. Never logs the recipient PII beyond domain so this
    // is safe in shared log streams.
    const toDomain = args.to.split("@")[1] ?? "?";
    console.error(
      JSON.stringify({
        evt: "email_fail",
        provider,
        category,
        subject: args.subject,
        to_domain: toDomain,
        err: message.slice(0, 300),
        ts: new Date().toISOString(),
      })
    );
    // If this looks like an infrastructure failure (auth/network/tls/
    // config), bust the verify cache so the next health probe rechecks.
    if (category === "auth" || category === "network" || category === "tls" || category === "config" || category === "transport_unavailable") {
      verifyCache = null;
    }
    result = { ok: false, reason: `${category}: ${message}` };
  }

  // Best-effort audit. Failure here never propagates.
  if (args.audit) {
    audit({
      tenantId: args.audit.tenantId,
      action: result.ok ? "email.sent" : "email.failed",
      entityType: "email",
      entityId: args.audit.bookingId,
      actorLabel: args.to,
      metadata: {
        subject: args.subject,
        kind: args.audit.kind,
        provider,
        error: result.ok ? undefined : result.reason,
      },
    });
  }

  return { ...result, provider };
}

// ─── Templates ──────────────────────────────────────────────────────────
// Inline HTML, table-based for client compatibility. Mobile-safe.

type BookingForEmail = {
  id: string;
  serviceName: string;
  staffName: string;
  staffEmail: string;
  startAt: Date;
  endAt: Date;
  clientName: string;
  clientEmail: string;
  clientTimezone?: string;
  meetLink?: string | null;
  tenantName: string;
  cancelToken?: string;
  rescheduleToken?: string;
};

function fmt(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, "EEEE, MMM d, yyyy 'at' h:mm a zzz");
}

function shell(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ZentroMeet</title>
<style>
  body { margin:0; background:#f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color:#0f172a; }
  .wrap { max-width:560px; margin:0 auto; padding:24px; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:24px; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
  h1 { font-size:20px; margin:0 0 8px; }
  .meta { color:#64748b; font-size:14px; }
  .btn { display:inline-block; background:#2563eb; color:#fff !important; text-decoration:none; padding:10px 16px; border-radius:8px; font-weight:600; font-size:14px; }
  .btn.secondary { background:#e2e8f0; color:#0f172a !important; }
  .row { padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:14px; }
  .label { color:#64748b; }
  .footer { color:#94a3b8; font-size:12px; text-align:center; margin-top:16px; }
</style></head>
<body><div class="wrap"><div class="card">${body}</div>
<div class="footer">ZentroMeet · automated message, please do not reply</div></div></body></html>`;
}

function rows(b: BookingForEmail, tz: string): string {
  const when = fmt(b.startAt, tz);
  return `
    <div class="row"><span class="label">When:</span> ${escape(when)}</div>
    <div class="row"><span class="label">Service:</span> ${escape(b.serviceName)} (${escape(b.staffName)})</div>
    <div class="row"><span class="label">Workspace:</span> ${escape(b.tenantName)}</div>
    ${b.meetLink ? `<div class="row"><span class="label">Meet link:</span> <a href="${escape(b.meetLink)}">${escape(b.meetLink)}</a></div>` : ""}
  `;
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)
  );
}

function actionButtons(b: BookingForEmail): string {
  const parts: string[] = [];
  if (b.rescheduleToken) {
    const url = buildBookingActionUrl(b.rescheduleToken, "reschedule");
    parts.push(`<a class="btn" href="${escape(url)}">Reschedule</a>`);
  }
  if (b.cancelToken) {
    const url = buildBookingActionUrl(b.cancelToken, "cancel");
    parts.push(`<a class="btn secondary" href="${escape(url)}">Cancel</a>`);
  }
  return parts.length ? `<div style="margin-top:20px;">${parts.join(" &nbsp; ")}</div>` : "";
}

export function renderConfirmation(b: BookingForEmail): { html: string; text: string; subject: string } {
  const tz = b.clientTimezone ?? "UTC";
  const subject = `Confirmed: ${b.serviceName} on ${formatInTimeZone(b.startAt, tz, "MMM d 'at' h:mm a")}`;
  const html = shell(`
    <h1>You're confirmed</h1>
    <p class="meta">Hi ${escape(b.clientName)}, your appointment is booked.</p>
    ${rows(b, tz)}
    ${actionButtons(b)}
  `);
  const text = `You're confirmed.\n\n${b.serviceName} with ${b.staffName}\n${fmt(b.startAt, tz)}\n${b.meetLink ? "Meet: " + b.meetLink + "\n" : ""}`;
  return { html, text, subject };
}

export function renderCancellation(b: BookingForEmail): { html: string; text: string; subject: string } {
  const tz = b.clientTimezone ?? "UTC";
  const subject = `Cancelled: ${b.serviceName} on ${formatInTimeZone(b.startAt, tz, "MMM d 'at' h:mm a")}`;
  const html = shell(`
    <h1>Appointment cancelled</h1>
    <p class="meta">Your appointment has been cancelled.</p>
    ${rows(b, tz)}
  `);
  const text = `Cancelled.\n${b.serviceName}\n${fmt(b.startAt, tz)}`;
  return { html, text, subject };
}

export function renderReschedule(b: BookingForEmail): { html: string; text: string; subject: string } {
  const tz = b.clientTimezone ?? "UTC";
  const subject = `Rescheduled: ${b.serviceName} to ${formatInTimeZone(b.startAt, tz, "MMM d 'at' h:mm a")}`;
  const html = shell(`
    <h1>New time confirmed</h1>
    <p class="meta">Your appointment has been moved to a new time.</p>
    ${rows(b, tz)}
    ${actionButtons(b)}
  `);
  const text = `Rescheduled.\n${b.serviceName}\n${fmt(b.startAt, tz)}`;
  return { html, text, subject };
}

export function renderReminder(b: BookingForEmail, leadLabel: string): { html: string; text: string; subject: string } {
  const tz = b.clientTimezone ?? "UTC";
  const subject = `Reminder: ${b.serviceName} ${leadLabel}`;
  const html = shell(`
    <h1>Reminder — ${escape(leadLabel)}</h1>
    <p class="meta">Just a heads-up before your upcoming appointment.</p>
    ${rows(b, tz)}
    ${actionButtons(b)}
  `);
  const text = `Reminder ${leadLabel}.\n${b.serviceName}\n${fmt(b.startAt, tz)}`;
  return { html, text, subject };
}

export type { BookingForEmail };

// ─── Website / inbound-form templates ───────────────────────────────────
// Used by /api/public/contact + /api/public/demo. Mobile-safe inline
// HTML matching shell() pattern above. Branding deliberately tied to
// the platform (not per-tenant) because these forms are platform-level.

export function renderContactNotification(args: {
  name: string;
  email: string;
  company?: string;
  message: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): { html: string; text: string; subject: string } {
  const subject = `New contact form: ${args.name}${args.company ? ` (${args.company})` : ""}`;
  const html = shell(`
    <h1>New contact form submission</h1>
    <p class="meta">Reply directly to this email to contact the sender.</p>
    <div class="row"><span class="label">Name:</span> ${escape(args.name)}</div>
    <div class="row"><span class="label">Email:</span> <a href="mailto:${escape(args.email)}">${escape(args.email)}</a></div>
    ${args.company ? `<div class="row"><span class="label">Company:</span> ${escape(args.company)}</div>` : ""}
    <div class="row" style="white-space:pre-wrap"><span class="label">Message:</span><br>${escape(args.message)}</div>
    ${args.ipAddress ? `<div class="row"><span class="label">IP:</span> ${escape(args.ipAddress)}</div>` : ""}
    ${args.userAgent ? `<div class="row"><span class="label">User agent:</span> <span style="font-size:11px;color:#94a3b8">${escape(args.userAgent.slice(0, 200))}</span></div>` : ""}
  `);
  const text = `New contact form submission\n\nName: ${args.name}\nEmail: ${args.email}\n${args.company ? `Company: ${args.company}\n` : ""}\nMessage:\n${args.message}\n${args.ipAddress ? `\nIP: ${args.ipAddress}` : ""}`;
  return { html, text, subject };
}

export function renderDemoRequestNotification(args: {
  name: string;
  email: string;
  company?: string;
  teamSize?: string;
  useCase?: string;
  phone?: string;
  message?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): { html: string; text: string; subject: string } {
  const subject = `New demo request: ${args.name}${args.company ? ` — ${args.company}` : ""}`;
  const html = shell(`
    <h1>New demo request</h1>
    <p class="meta">Reply directly to this email to contact the requester.</p>
    <div class="row"><span class="label">Name:</span> ${escape(args.name)}</div>
    <div class="row"><span class="label">Email:</span> <a href="mailto:${escape(args.email)}">${escape(args.email)}</a></div>
    ${args.company ? `<div class="row"><span class="label">Company:</span> ${escape(args.company)}</div>` : ""}
    ${args.teamSize ? `<div class="row"><span class="label">Team size:</span> ${escape(args.teamSize)}</div>` : ""}
    ${args.useCase ? `<div class="row"><span class="label">Use case:</span> ${escape(args.useCase)}</div>` : ""}
    ${args.phone ? `<div class="row"><span class="label">Phone:</span> ${escape(args.phone)}</div>` : ""}
    ${args.message ? `<div class="row" style="white-space:pre-wrap"><span class="label">Message:</span><br>${escape(args.message)}</div>` : ""}
    ${args.ipAddress ? `<div class="row"><span class="label">IP:</span> ${escape(args.ipAddress)}</div>` : ""}
    ${args.userAgent ? `<div class="row"><span class="label">User agent:</span> <span style="font-size:11px;color:#94a3b8">${escape(args.userAgent.slice(0, 200))}</span></div>` : ""}
  `);
  const text = `New demo request\n\nName: ${args.name}\nEmail: ${args.email}\n${args.company ? `Company: ${args.company}\n` : ""}${args.teamSize ? `Team size: ${args.teamSize}\n` : ""}${args.useCase ? `Use case: ${args.useCase}\n` : ""}${args.phone ? `Phone: ${args.phone}\n` : ""}${args.message ? `\nMessage:\n${args.message}\n` : ""}${args.ipAddress ? `\nIP: ${args.ipAddress}` : ""}`;
  return { html, text, subject };
}

export function renderContactAutoresponder(args: {
  name: string;
  supportEmail: string;
  brandName?: string;
}): { html: string; text: string; subject: string } {
  const brand = args.brandName ?? "ZentroBiz";
  const subject = `We received your message — ${brand}`;
  const html = shell(`
    <h1>Thanks for reaching out, ${escape(args.name)}.</h1>
    <p class="meta">We received your message and our team will get back to you shortly — usually within one business day.</p>
    <p class="meta" style="margin-top:16px">
      If your inquiry is urgent, you can reply directly to this email and it will reach our support team at
      <a href="mailto:${escape(args.supportEmail)}">${escape(args.supportEmail)}</a>.
    </p>
    <p class="meta" style="margin-top:16px">— The ${escape(brand)} team</p>
  `);
  const text = `Thanks for reaching out, ${args.name}.\n\nWe received your message and our team will get back to you shortly — usually within one business day.\n\nIf urgent, reply directly to this email (${args.supportEmail}).\n\n— The ${brand} team`;
  return { html, text, subject };
}

export function renderDemoAutoresponder(args: {
  name: string;
  supportEmail: string;
  brandName?: string;
}): { html: string; text: string; subject: string } {
  const brand = args.brandName ?? "ZentroBiz";
  const subject = `Your ${brand} demo request — next steps`;
  const html = shell(`
    <h1>Hi ${escape(args.name)} — your demo request is in.</h1>
    <p class="meta">Thanks for your interest in ${escape(brand)}. A member of our team will reach out within one business day to schedule a personalized walkthrough.</p>
    <p class="meta" style="margin-top:16px">
      In the meantime, feel free to reply to this email with any specific questions about your use case, team size, or integrations. Your reply will go straight to
      <a href="mailto:${escape(args.supportEmail)}">${escape(args.supportEmail)}</a>.
    </p>
    <p class="meta" style="margin-top:16px">— The ${escape(brand)} team</p>
  `);
  const text = `Hi ${args.name} — your demo request is in.\n\nThanks for your interest in ${brand}. A member of our team will reach out within one business day.\n\nReply to this email with any specific questions (${args.supportEmail}).\n\n— The ${brand} team`;
  return { html, text, subject };
}
