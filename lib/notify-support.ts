/**
 * Support / demo routing helpers — centralized inbound-form notifications.
 *
 * Every public form endpoint (contact, demo, future enterprise inquiry)
 * MUST route through this module rather than calling sendEmail directly.
 * Reasons:
 *
 *   1. SUPPORT_EMAIL / DEMO_EMAIL env resolution lives in ONE place.
 *      Operators rotate the destination without touching route code.
 *   2. The "from" address stays canonical (EMAIL_FROM) — SES rejects
 *      mail from un-verified domains, and routing helpers ensure no
 *      form ever forges the submitter's address as the From header.
 *   3. The Reply-To header is set to the submitter so a human reply
 *      from the team lands directly in the submitter's inbox.
 *   4. Result shape stays uniform — endpoints only care if the
 *      notification dispatched, autoresponder dispatched, or both
 *      failed (in which case they should still 200 OK to the caller
 *      to avoid leaking provider state, but record the failure).
 *
 * Never throws. Everything is fire-and-forget from the endpoint's
 * perspective; this module returns a structured result that the
 * endpoint can pipe into its audit log.
 */

import {
  sendEmail,
  renderContactNotification,
  renderContactAutoresponder,
  renderDemoRequestNotification,
  renderDemoAutoresponder,
} from "@/lib/email";

const BRAND_NAME = process.env.BRAND_NAME ?? "ZentroBiz";

/** Resolves the support inbox. Falls back to EMAIL_FROM so a misconfigured
 *  deploy still routes somewhere reachable rather than silently dropping
 *  the message. Returns null only if BOTH are unset (development / stub). */
export function resolveSupportInbox(): string | null {
  return process.env.SUPPORT_EMAIL ?? process.env.EMAIL_FROM ?? null;
}

export function resolveDemoInbox(): string | null {
  return process.env.DEMO_EMAIL ?? process.env.SUPPORT_EMAIL ?? process.env.EMAIL_FROM ?? null;
}

export type SupportDispatchResult = {
  notificationDispatched: boolean;
  autoresponderDispatched: boolean;
  /** Categorized failure if notification failed. Undefined on success. */
  notificationError?: string;
  /** Categorized failure if autoresponder failed. Undefined on success. */
  autoresponderError?: string;
  /** Destination inbox the notification went to (for audit). */
  notificationTo?: string | null;
};

// ─── Public surface ──────────────────────────────────────────────────

export async function sendContactFormNotification(args: {
  name: string;
  email: string;
  company?: string;
  message: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<SupportDispatchResult> {
  const supportInbox = resolveSupportInbox();
  const result: SupportDispatchResult = {
    notificationDispatched: false,
    autoresponderDispatched: false,
    notificationTo: supportInbox,
  };

  // Notify the support team.
  if (supportInbox) {
    const notification = renderContactNotification(args);
    const r = await sendEmail({
      to: supportInbox,
      subject: notification.subject,
      html: notification.html,
      text: notification.text,
      // Reply-To = submitter so the team can hit Reply directly.
      replyTo: `${args.name} <${args.email}>`,
    });
    result.notificationDispatched = r.ok;
    if (!r.ok) result.notificationError = r.reason;
  } else {
    result.notificationError = "no_inbox_configured";
  }

  // Autoresponder to the submitter — best-effort, never blocks the
  // notification result.
  if (supportInbox) {
    const auto = renderContactAutoresponder({
      name: args.name,
      supportEmail: supportInbox,
      brandName: BRAND_NAME,
    });
    const r = await sendEmail({
      to: args.email,
      subject: auto.subject,
      html: auto.html,
      text: auto.text,
      replyTo: supportInbox,
    });
    result.autoresponderDispatched = r.ok;
    if (!r.ok) result.autoresponderError = r.reason;
  }

  return result;
}

export async function sendDemoRequestNotification(args: {
  name: string;
  email: string;
  company?: string;
  teamSize?: string;
  useCase?: string;
  phone?: string;
  message?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<SupportDispatchResult> {
  const demoInbox = resolveDemoInbox();
  const supportInbox = resolveSupportInbox();
  const result: SupportDispatchResult = {
    notificationDispatched: false,
    autoresponderDispatched: false,
    notificationTo: demoInbox,
  };

  if (demoInbox) {
    const notification = renderDemoRequestNotification(args);
    const r = await sendEmail({
      to: demoInbox,
      subject: notification.subject,
      html: notification.html,
      text: notification.text,
      replyTo: `${args.name} <${args.email}>`,
    });
    result.notificationDispatched = r.ok;
    if (!r.ok) result.notificationError = r.reason;
  } else {
    result.notificationError = "no_inbox_configured";
  }

  if (supportInbox) {
    const auto = renderDemoAutoresponder({
      name: args.name,
      supportEmail: supportInbox,
      brandName: BRAND_NAME,
    });
    const r = await sendEmail({
      to: args.email,
      subject: auto.subject,
      html: auto.html,
      text: auto.text,
      replyTo: supportInbox,
    });
    result.autoresponderDispatched = r.ok;
    if (!r.ok) result.autoresponderError = r.reason;
  }

  return result;
}

// ─── Future enterprise flow scaffolding ──────────────────────────────
// The architecture is designed so a future enterprise-sales endpoint
// can be added by:
//   1. Defining a new render*Notification + render*Autoresponder pair
//      in lib/email.ts.
//   2. Adding a sendEnterpriseInquiryNotification() function here that
//      reuses the same SupportDispatchResult shape.
//   3. Routing it to a new ENTERPRISE_SALES_EMAIL env (falling back to
//      DEMO_EMAIL → SUPPORT_EMAIL → EMAIL_FROM, identical pattern).
//
// Endpoints stay 100% additive — same rate-limit + honeypot + audit
// recipe, only the destination + payload changes.
