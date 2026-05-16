/**
 * Best-effort email sender.
 * - If SMTP_HOST is set, sends via nodemailer.
 * - Otherwise logs a stub to stdout so devs can see the message in `npm run dev`.
 * - Every send is wrapped in try/catch by the caller — this module never
 *   throws upward. Booking creation must never fail because of email.
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

function activeProvider(): Provider {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.POSTMARK_TOKEN) return "postmark";
  if (process.env.SMTP_HOST)      return "smtp";
  return "stub";
}

let smtpTransporterPromise: Promise<unknown> | null = null;

async function getSmtpTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (smtpTransporterPromise) return smtpTransporterPromise;
  smtpTransporterPromise = (async () => {
    const nodemailer = await import("nodemailer");
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  })();
  return smtpTransporterPromise;
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
    subject: args.subject,
    html: args.html,
    text: args.text,
    attachments: args.attachments,
  });
}

export async function sendEmail(args: SendArgs): Promise<{ ok: boolean; reason?: string; provider?: Provider }> {
  const from = process.env.EMAIL_FROM ?? "Scheduling SaaS <no-reply@localhost>";
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
    console.error("[email:fail]", { to: args.to, subject: args.subject, provider, err });
    result = { ok: false, reason: err instanceof Error ? err.message : "unknown" };
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
<title>Scheduling SaaS</title>
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
<div class="footer">Scheduling SaaS · automated message, please do not reply</div></div></body></html>`;
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
