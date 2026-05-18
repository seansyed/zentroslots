/**
 * Pure module — no DB imports — so tests and the variable picker UI
 * can load it without DATABASE_URL set. The DB-aware resolver lives in
 * lib/communications/templates.ts and re-exports these symbols for the
 * engine's consumers.
 */

import {
  renderCancellation,
  renderConfirmation,
  renderReminder,
  renderReschedule,
  type BookingForEmail,
} from "@/lib/email";

export type TemplateType =
  | "booking_confirmation"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "reminder_24h"
  | "reminder_1h"
  | "appointment_completed"
  | "appointment_no_show"
  | "review_request"
  | "followup";

export const TEMPLATE_TYPES: readonly TemplateType[] = [
  "booking_confirmation",
  "booking_cancelled",
  "booking_rescheduled",
  "reminder_24h",
  "reminder_1h",
  "appointment_completed",
  "appointment_no_show",
  "review_request",
  "followup",
];

export type ResolvedTemplate = {
  subject: string;
  html: string;
  text: string;
  source: "service" | "tenant" | "system";
  templateId?: string;
};

/**
 * System-default fallback. Reuses the existing code-defined renderers
 * so behavior is identical to pre-engine. Surface area kept tight: any
 * new TemplateType requires a corresponding case here.
 */
export function systemFallbackFor(
  type: TemplateType,
  payload: BookingForEmail
): ResolvedTemplate {
  let out: { subject: string; html: string; text: string };
  switch (type) {
    case "booking_confirmation":
      out = renderConfirmation(payload);
      break;
    case "booking_cancelled":
      out = renderCancellation(payload);
      break;
    case "booking_rescheduled":
      out = renderReschedule(payload);
      break;
    case "reminder_24h":
      out = renderReminder(payload, "24 hours away");
      break;
    case "reminder_1h":
      out = renderReminder(payload, "1 hour away");
      break;
    case "appointment_completed":
      out = renderCompleted(payload);
      break;
    case "appointment_no_show":
      out = renderNoShow(payload);
      break;
    case "review_request":
      out = renderReviewRequest(payload);
      break;
    case "followup":
      out = renderFollowup(payload);
      break;
  }
  return { ...out, source: "system" };
}

// ─── New system templates (defined inline to keep lib/email.ts untouched) ─

function renderCompleted(p: BookingForEmail): { subject: string; html: string; text: string } {
  return {
    subject: `Thanks for visiting — ${p.serviceName}`,
    html: simpleEmail({
      heading: "Thanks for visiting",
      body: `Hi ${p.clientName}, thanks for choosing ${p.tenantName}. We hope your ${p.serviceName} appointment went well.`,
      ctaLabel: null,
      ctaUrl: null,
    }),
    text:
      `Hi ${p.clientName},\n\nThanks for choosing ${p.tenantName}. ` +
      `We hope your ${p.serviceName} appointment went well.\n`,
  };
}

function renderNoShow(p: BookingForEmail): { subject: string; html: string; text: string } {
  return {
    subject: `We missed you — ${p.serviceName}`,
    html: simpleEmail({
      heading: "We missed you",
      body: `Hi ${p.clientName}, we didn't see you for your ${p.serviceName} appointment. ` +
            `When you're ready, you can rebook with ${p.tenantName} anytime.`,
      ctaLabel: null,
      ctaUrl: null,
    }),
    text:
      `Hi ${p.clientName},\n\nWe didn't see you for your ${p.serviceName} appointment. ` +
      `When you're ready, rebook with ${p.tenantName} anytime.\n`,
  };
}

function renderReviewRequest(p: BookingForEmail): { subject: string; html: string; text: string } {
  return {
    subject: `Quick favor — review ${p.tenantName}?`,
    html: simpleEmail({
      heading: "How was your visit?",
      body:
        `Hi ${p.clientName}, your ${p.serviceName} appointment is wrapped. ` +
        `Would you mind sharing a quick review? It really helps small businesses like ${p.tenantName}.`,
      // The orchestrator injects {{review_url}} into the body via the
      // variable renderer; the system template surfaces it as a CTA
      // when present. The renderer leaves the {{...}} token in place
      // when no value is provided — UX is "no button rendered" since
      // the href would be the literal token (still valid HTML, just
      // not clickable).
      ctaLabel: "Leave a review",
      ctaUrl: "{{review_url}}",
    }),
    text:
      `Hi ${p.clientName},\n\nWould you mind leaving a quick review for ${p.tenantName}? ` +
      `It really helps. Review link: {{review_url}}\n`,
  };
}

function renderFollowup(p: BookingForEmail): { subject: string; html: string; text: string } {
  return {
    subject: `Following up — ${p.tenantName}`,
    html: simpleEmail({
      heading: "Following up",
      body:
        `Hi ${p.clientName}, just following up on your ${p.serviceName} appointment with ${p.tenantName}. ` +
        `Reply to this email if there's anything we can help with — and book again when you're ready.`,
      ctaLabel: "Book again",
      ctaUrl: "{{booking_link}}",
    }),
    text:
      `Hi ${p.clientName},\n\nJust following up on your ${p.serviceName} appointment with ${p.tenantName}. ` +
      `Reply to this email any time. Book again: {{booking_link}}\n`,
  };
}

/**
 * Minimal HTML wrapper used by the new system templates. Email-client
 * safe (tables, inline styles). The four existing templates use the
 * pre-existing renderers in lib/email.ts.
 */
function simpleEmail(args: {
  heading: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
}): string {
  const ctaBlock =
    args.ctaLabel && args.ctaUrl
      ? `<tr><td style="padding:24px 0;text-align:center;">
           <a href="${args.ctaUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${args.ctaLabel}</a>
         </td></tr>`
      : "";
  return `<!doctype html>
<html><body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding:24px;">
  <table cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
    <tr><td style="padding:24px;">
      <h1 style="font-size:20px;margin:0 0 12px;">${args.heading}</h1>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0;">${args.body}</p>
    </td></tr>
    ${ctaBlock}
  </table>
</td></tr></table>
</body></html>`;
}

/**
 * Starter used by the admin editor for "restore default". Same render
 * path as the system fallback, with placeholder values so the admin
 * sees what the variables will become.
 */
export function templateStarterFor(type: TemplateType): {
  subject: string;
  html: string;
  text: string;
} {
  const sample: BookingForEmail = {
    id: "00000000-0000-0000-0000-000000000000",
    serviceName: "{{service_name}}",
    staffName: "{{staff_name}}",
    staffEmail: "",
    startAt: new Date(0),
    endAt: new Date(0),
    clientName: "{{customer_name}}",
    clientEmail: "{{business_email}}",
    clientTimezone: "UTC",
    meetLink: null,
    tenantName: "{{business_name}}",
    cancelToken: undefined,
    rescheduleToken: undefined,
  };
  return systemFallbackFor(type, sample);
}
