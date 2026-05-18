/**
 * Centralized automation orchestrator.
 *
 * One entry point — `triggerAutomation()` — replaces the scattered
 *   `await sendEmail({...})` + inline `renderConfirmation(...)` pairs
 * that used to live at every booking lifecycle touch point.
 *
 * Responsibilities, in order:
 *   1. Idempotency check — `communication_logs` already has a 'sent'
 *      row for (tenant, booking, event, channel)? short-circuit.
 *   2. Load booking + ancillary records (service, staff, tenant).
 *   3. Customer-preference gate (reuses lib/communications/preferences
 *      from the prior phase — auth/billing kinds CANNOT be passed here
 *      because the eventType union is closed).
 *   4. Resolve template (service-level → tenant-level → system fallback).
 *   5. Render variables.
 *   6. Send.
 *   7. Persist a `communication_logs` row (sent/skipped/failed).
 *
 * Never throws. Booking flows already wrap email sends in their own
 * try/catch, but defense in depth: every branch here resolves to a
 * structured result with a status field.
 *
 * Delay is not honored — automation_rules.delay_minutes > 0 is rejected
 * because we don't have a queue (intentional, per task rules).
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  automationRules,
  bookings,
  communicationLogs,
  customers,
  services,
  tenants,
  users,
} from "@/db/schema";
import { signBookingToken } from "@/lib/tokens";
import { sendEmail, type BookingForEmail } from "@/lib/email";
import { buildIcs } from "@/lib/ics";
import {
  gateSchedulingEmail,
  logSuppressed,
} from "@/lib/communications/preferences";
import {
  resolveAndRenderTemplate,
  type TemplateType,
} from "@/lib/communications/templates";
import { loadTenantFeatures } from "@/lib/features";
import type { SchedulingEmailKind } from "@/lib/communications/email-rules";
import type { TemplateContext } from "@/lib/communications/variables";
import { formatInTimeZone } from "date-fns-tz";

// ─── Public surface ────────────────────────────────────────────────────

/**
 * Canonical event names spoken by the engine. Keep this union closed —
 * adding a new event requires explicit handling in `eventToTemplateType()`
 * and `eventToSchedulingEmailKind()` below.
 */
export type AutomationEvent =
  | "appointment.created"
  | "appointment.cancelled"
  | "appointment.rescheduled"
  | "appointment.reminder_24h"
  | "appointment.reminder_1h"
  | "appointment.completed"
  | "appointment.no_show"
  | "appointment.review_request"
  | "appointment.followup"
  | "appointment.waitlist_slot_available";

export type TriggerArgs = {
  tenantId: string;
  bookingId: string;
  eventType: AutomationEvent;
  /** When true, ignores the customer-preference gate. Reserved for
   *  manual staff resends from the admin UI — no caller passes this yet. */
  overridePrefs?: boolean;
  /** Attach the booking's iCal invite. Confirmation flow uses this so
   *  the customer can add the event to their calendar in one tap.
   *  Plain optional flag rather than a generic `attachments` array —
   *  the engine deliberately keeps the public surface tight. */
  attachIcs?: boolean;
  /** Optional event-specific extras merged into the rendering context.
   *  Used by the review-request automation to inject {{review_url}} +
   *  {{review_platform}}. The engine never invents these values; the
   *  caller is the source of truth. */
  contextExtras?: Partial<Record<string, string>>;
};

export type TriggerResult =
  | { status: "sent"; logId: string; provider?: string; messageId?: string | null }
  | { status: "skipped"; logId: string; reason: string }
  | { status: "failed"; logId?: string; reason: string };

/**
 * Fire (or suppress, or skip) the email side of a scheduling event.
 * Booking has already been mutated by the caller — this function never
 * touches the booking row's status; it only owns the customer comm.
 */
export async function triggerAutomation(args: TriggerArgs): Promise<TriggerResult> {
  const channel = "email";

  try {
    // ── (1) Idempotency — bail if we've already successfully sent.
    const already = await db.query.communicationLogs.findFirst({
      where: and(
        eq(communicationLogs.tenantId, args.tenantId),
        eq(communicationLogs.bookingId, args.bookingId),
        eq(communicationLogs.eventType, args.eventType),
        eq(communicationLogs.channel, channel),
        eq(communicationLogs.status, "sent")
      ),
    });
    if (already) {
      return { status: "skipped", logId: already.id, reason: "already_sent" };
    }

    // ── (1b) Tenant feature gate. Reminders are the only scheduling
    // event currently behind a feature toggle — the admin can disable
    // them at Settings → Feature Controls. Disabling silently skips
    // both the 24h and 1h reminders; confirmations / cancels /
    // reschedules are unaffected (they're separate toggles enforced
    // elsewhere — cancel/reschedule are gated at the API layer, not
    // here, because the gate decides whether the ACTION runs at all).
    if (
      args.eventType === "appointment.reminder_24h" ||
      args.eventType === "appointment.reminder_1h"
    ) {
      const features = await loadTenantFeatures(args.tenantId);
      if (!features.reminders) {
        return await writeLog({
          ...skeleton(args, channel),
          status: "skipped",
          skippedReason: "feature_disabled",
        });
      }
    }

    // ── (2) Load booking + ancillaries.
    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)),
    });
    if (!booking) {
      return await writeLog({
        ...skeleton(args, channel),
        status: "failed",
        failureReason: "booking_not_found",
      });
    }

    const [service, staff, tenant, customer] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, booking.serviceId) }),
      db.query.users.findFirst({ where: eq(users.id, booking.staffUserId) }),
      db.query.tenants.findFirst({ where: eq(tenants.id, args.tenantId) }),
      db.query.customers.findFirst({
        where: and(
          eq(customers.tenantId, args.tenantId),
          sql`lower(${customers.email}) = lower(${booking.clientEmail})`
        ),
      }),
    ]);
    if (!service || !staff || !tenant) {
      return await writeLog({
        ...skeleton(args, channel),
        status: "failed",
        failureReason: "missing_ancillary_records",
      });
    }

    // ── (3) Check tenant has an automation rule for this event. Missing
    // row = use system default (everything on). An admin can insert a
    // disabled rule to turn off an event without disabling the template.
    const rule = await db.query.automationRules.findFirst({
      where: and(
        eq(automationRules.tenantId, args.tenantId),
        eq(automationRules.triggerEvent, args.eventType),
        eq(automationRules.channel, channel)
      ),
    });
    if (rule && !rule.enabled) {
      return await writeLog({
        ...skeleton(args, channel, customer?.id),
        status: "skipped",
        skippedReason: "rule_disabled",
      });
    }
    if (rule && rule.delayMinutes > 0) {
      // Delay scheduling requires a queue (out of scope). Don't silently
      // drop; record so an admin can see the rule isn't honored.
      return await writeLog({
        ...skeleton(args, channel, customer?.id),
        status: "skipped",
        skippedReason: "delay_not_supported",
      });
    }

    // ── (4) Customer preference gate. Auth/billing kinds are
    // structurally impossible to pass here because the
    // SchedulingEmailKind union is closed and the mapping is total.
    if (!args.overridePrefs) {
      const kind = eventToSchedulingEmailKind(args.eventType);
      const gate = await gateSchedulingEmail({
        tenantId: args.tenantId,
        email: booking.clientEmail,
        kind,
      });
      if (!gate.allowed) {
        logSuppressed({
          kind,
          reason: gate.reason,
          tenantId: args.tenantId,
          email: booking.clientEmail,
          bookingId: booking.id,
        });
        return await writeLog({
          ...skeleton(args, channel, customer?.id),
          status: "skipped",
          skippedReason: gate.reason,
        });
      }
    }

    // ── (5) Resolve + render template.
    const templateType = eventToTemplateType(args.eventType);
    const [cancelToken, rescheduleToken] = await Promise.all([
      signBookingToken({ bookingId: booking.id, tenantId: args.tenantId, kind: "cancel" }),
      signBookingToken({ bookingId: booking.id, tenantId: args.tenantId, kind: "reschedule" }),
    ]);
    const tz = staff.timezone ?? "UTC";

    const payload: BookingForEmail = {
      id: booking.id,
      serviceName: service.name,
      staffName: staff.name,
      staffEmail: staff.email,
      startAt: booking.startAt,
      endAt: booking.endAt,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientTimezone: tz,
      meetLink: booking.meetLink ?? null,
      tenantName: tenant.name,
      cancelToken,
      rescheduleToken,
    };

    const baseContext: TemplateContext = buildContext({
      booking, service, staff, tenant, cancelToken, rescheduleToken, tz,
    });
    // Caller-provided extras (review_url, review_platform) merged on
    // top. Unknown keys are silently dropped by the renderer's
    // whitelist — adding a fake variable here can't poison templates.
    const context: TemplateContext = args.contextExtras
      ? { ...baseContext, ...args.contextExtras }
      : baseContext;

    const rendered = await resolveAndRenderTemplate({
      tenantId: args.tenantId,
      serviceId: booking.serviceId,
      templateType,
      context,
      systemFallbackPayload: payload,
    });

    // ── (6) Send.
    const attachments = args.attachIcs
      ? [{
          filename: "invite.ics",
          content: buildIcs({
            uid: `${booking.id}@scheduling-saas`,
            start: booking.startAt,
            end: booking.endAt,
            summary: `${service.name} with ${staff.name}`,
            description: booking.notes ?? "",
            location: booking.meetLink ?? undefined,
            organizerEmail: staff.email,
            organizerName: staff.name,
            attendeeEmail: booking.clientEmail,
            attendeeName: booking.clientName,
            method: args.eventType === "appointment.cancelled" ? "CANCEL" : "REQUEST",
          }),
          contentType: "text/calendar; charset=utf-8; method=REQUEST",
        }]
      : undefined;

    const sendResult = await sendEmail({
      to: booking.clientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments,
      // No legacy audit hook — communication_logs is now the canonical
      // record of every send attempt.
    });

    if (!sendResult.ok) {
      return await writeLog({
        ...skeleton(args, channel, customer?.id, rendered.templateId),
        status: "failed",
        failureReason: sendResult.reason ?? "unknown",
        provider: sendResult.provider,
      });
    }

    return await writeLog({
      ...skeleton(args, channel, customer?.id, rendered.templateId),
      status: "sent",
      provider: sendResult.provider,
      sentAt: new Date(),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[automation] unexpected error", reason);
    try {
      return await writeLog({
        ...skeleton(args, channel),
        status: "failed",
        failureReason: reason.slice(0, 500),
      });
    } catch {
      return { status: "failed", reason };
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

function eventToTemplateType(e: AutomationEvent): TemplateType {
  switch (e) {
    case "appointment.created":        return "booking_confirmation";
    case "appointment.cancelled":      return "booking_cancelled";
    case "appointment.rescheduled":    return "booking_rescheduled";
    case "appointment.reminder_24h":   return "reminder_24h";
    case "appointment.reminder_1h":    return "reminder_1h";
    case "appointment.completed":      return "appointment_completed";
    case "appointment.no_show":        return "appointment_no_show";
    case "appointment.review_request": return "review_request";
    case "appointment.followup":       return "followup";
    case "appointment.waitlist_slot_available": return "waitlist_slot_available";
  }
}

function eventToSchedulingEmailKind(e: AutomationEvent): SchedulingEmailKind {
  switch (e) {
    case "appointment.created":        return "appointment_confirmation";
    case "appointment.cancelled":      return "appointment_cancelled";
    case "appointment.rescheduled":    return "appointment_rescheduled";
    case "appointment.reminder_24h":   return "appointment_reminder_24h";
    case "appointment.reminder_1h":    return "appointment_reminder_1h";
    case "appointment.completed":      return "appointment_completed";
    case "appointment.no_show":        return "appointment_no_show";
    case "appointment.review_request": return "appointment_review_request";
    case "appointment.followup":       return "appointment_followup";
    case "appointment.waitlist_slot_available": return "appointment_waitlist_slot_available";
  }
}

function buildContext(args: {
  booking: typeof bookings.$inferSelect;
  service: typeof services.$inferSelect;
  staff: typeof users.$inferSelect;
  tenant: typeof tenants.$inferSelect;
  cancelToken: string;
  rescheduleToken: string;
  tz: string;
}): TemplateContext {
  const { booking, service, staff, tenant, tz } = args;
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  return {
    customer_name: booking.clientName,
    customer_first_name: booking.clientName.split(" ")[0] ?? booking.clientName,
    business_name: tenant.name,
    service_name: service.name,
    staff_name: staff.name,
    appointment_date: safeFormat(booking.startAt, tz, "EEEE, MMMM d, yyyy"),
    appointment_time: safeFormat(booking.startAt, tz, "h:mm a"),
    appointment_end_time: safeFormat(booking.endAt, tz, "h:mm a"),
    location_name: undefined, // location join deferred; service+staff suffice for now
    meeting_link: booking.meetLink ?? undefined,
    booking_link: `${base}/u/${tenant.slug}`,
    cancel_link: `${base}/cancel/${encodeURIComponent(args.cancelToken)}`,
    reschedule_link: `${base}/reschedule/${encodeURIComponent(args.rescheduleToken)}`,
    business_phone: undefined,
    business_email: tenant.billingEmail ?? undefined,
    notes: booking.notes ?? undefined,
  };
}

function safeFormat(d: Date, tz: string, pattern: string): string {
  try {
    return formatInTimeZone(d, tz, pattern);
  } catch {
    return d.toISOString();
  }
}

type LogSkeleton = {
  tenantId: string;
  bookingId: string;
  customerId?: string | null;
  templateId?: string | null;
  channel: string;
  eventType: string;
};

function skeleton(
  args: TriggerArgs,
  channel: string,
  customerId?: string | null,
  templateId?: string | null
): LogSkeleton {
  return {
    tenantId: args.tenantId,
    bookingId: args.bookingId,
    customerId: customerId ?? null,
    templateId: templateId ?? null,
    channel,
    eventType: args.eventType,
  };
}

async function writeLog(
  s: LogSkeleton & {
    status: "sent" | "skipped" | "failed";
    skippedReason?: string;
    failureReason?: string;
    provider?: string;
    providerMessageId?: string | null;
    sentAt?: Date;
  }
): Promise<TriggerResult> {
  try {
    const [row] = await db
      .insert(communicationLogs)
      .values({
        tenantId: s.tenantId,
        bookingId: s.bookingId,
        customerId: s.customerId ?? null,
        templateId: s.templateId ?? null,
        channel: s.channel,
        eventType: s.eventType,
        status: s.status,
        provider: s.provider ?? null,
        providerMessageId: s.providerMessageId ?? null,
        failureReason: s.failureReason ?? null,
        skippedReason: s.skippedReason ?? null,
        sentAt: s.sentAt ?? null,
      })
      .returning({ id: communicationLogs.id });

    if (s.status === "sent") {
      return { status: "sent", logId: row.id, provider: s.provider, messageId: s.providerMessageId ?? null };
    }
    if (s.status === "skipped") {
      return { status: "skipped", logId: row.id, reason: s.skippedReason ?? "unknown" };
    }
    return { status: "failed", logId: row.id, reason: s.failureReason ?? "unknown" };
  } catch (e) {
    // Idempotency race: another caller succeeded between our check and
    // insert. The partial unique index threw 23505 — treat as "already
    // sent" rather than an error.
    if ((e as { code?: string })?.code === "23505") {
      return { status: "skipped", logId: "", reason: "already_sent" };
    }
    // Don't propagate — caller wrapping already handles, but we need
    // SOME result.
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
