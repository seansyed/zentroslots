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

import { and, eq, isNull, sql } from "drizzle-orm";

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
// Phase ICAL-1 — swapped from buildIcs (lib/ics.ts) to the universal
// generator. buildIcs still exists as a deprecated re-export shim
// for back-compat; no live caller depends on it inside this file.
import { generateBookingIcs } from "@/lib/calendar/ics/booking-ics";
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
  | "appointment.reminder_2h"
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
  /** Override the recipient address. By default the engine emails the
   *  ORIGINATING booking's clientEmail. The waitlist "slot available"
   *  event must instead email the WAITLIST WINNER (a different person),
   *  whose booking id is reused only as the idempotency key — so that
   *  flow passes their address here. Leave unset for all customer-facing
   *  appointment events (they correctly target the booking's client). */
  recipientOverride?: string;
  /** Optional deterministic discriminator folded into the success-dedup key.
   *  Used by reschedule (`r:<new-start-epoch>`) so each legit move to a NEW
   *  time emails once while same-time retries (webhook/double-submit) dedup.
   *  Leave unset for one-shot events (confirmation/cancellation/reminder) —
   *  they dedup on (tenant, booking, event, channel). */
  dedupeKey?: string;
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
    // The dedupeKey term lets a legitimately-distinct event for the same
    // booking (e.g. a 2nd reschedule to a NEW time, keyed on the new instant)
    // proceed, while a same-key retry collides and is skipped. Callers that
    // pass no dedupeKey match the NULL-key rows (confirmation/reminder/cancel)
    // — unchanged behavior.
    const already = await db.query.communicationLogs.findFirst({
      where: and(
        eq(communicationLogs.tenantId, args.tenantId),
        eq(communicationLogs.bookingId, args.bookingId),
        eq(communicationLogs.eventType, args.eventType),
        eq(communicationLogs.channel, channel),
        eq(communicationLogs.status, "sent"),
        args.dedupeKey
          ? eq(communicationLogs.dedupeKey, args.dedupeKey)
          : isNull(communicationLogs.dedupeKey)
      ),
    });
    if (already) {
      return { status: "skipped", logId: already.id, reason: "already_sent" };
    }

    // ── (1b) Tenant feature gates. Two layers, evaluated in order:
    //   1. emailNotifications — master switch for ALL outbound email.
    //      When off, no scheduling email of any kind is sent. This is
    //      the kill switch a tenant flips during a migration, sandbox
    //      test, or compliance freeze.
    //   2. reminders — narrower: silences only the 24h + 1h reminders
    //      while leaving confirmation / cancel / reschedule alive.
    // Both load through the 60s in-process cache; one call covers both.
    {
      const features = await loadTenantFeatures(args.tenantId);
      if (!features.emailNotifications) {
        return await writeLog({
          ...skeleton(args, channel),
          status: "skipped",
          skippedReason: "feature_disabled_email_notifications",
        });
      }
      if (
        (args.eventType === "appointment.reminder_24h" ||
          args.eventType === "appointment.reminder_2h" ||
          args.eventType === "appointment.reminder_1h") &&
        !features.reminders
      ) {
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
      // Wave A — customer trust safety. Pass the service's configured
      // video provider so the renderer can decide between (a) showing
      // a real meet link, (b) showing an honest "your host will share
      // the link" fallback for video-services that didn't get a link,
      // and (c) omitting the row entirely for non-video services.
      videoProvider: service.videoProvider ?? null,
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
    //
    // Phase ICAL-1 — the ICS attachment now goes through the
    // universal generator (lib/calendar/ics/booking-ics.ts) which:
    //   • emits VTIMEZONE so Apple Calendar renders local time
    //     correctly (the previous minimal generator emitted UTC
    //     only, which Apple displayed as a UTC string)
    //   • folds lines at 75 octets so long meeting URLs don't
    //     break Outlook's parser
    //   • derives SEQUENCE from bookings.updated_at so each
    //     reschedule cleanly UPDATES the existing calendar entry
    //     instead of creating a duplicate
    //   • FIXES the prior bug where the Content-Type always said
    //     method=REQUEST even when the body was METHOD:CANCEL
    //     (Outlook ignored cancellations as a result)
    //   • attaches the default 24h + 15min VALARM reminders for
    //     REQUEST events (suppressed automatically on CANCEL)
    const ics = args.attachIcs
      ? generateBookingIcs({
          booking: {
            id: booking.id,
            startAt: booking.startAt,
            endAt: booking.endAt,
            clientEmail: booking.clientEmail,
            clientName: booking.clientName,
            notes: booking.notes,
            meetLink: booking.meetLink,
            updatedAt: booking.updatedAt,
          },
          service: { name: service.name },
          staff: { email: staff.email, name: staff.name, timezone: staff.timezone },
          tenant: { name: tenant.name },
          method: args.eventType === "appointment.cancelled" ? "CANCEL" : "REQUEST",
          alarms: [{ minutesBefore: 1440 }, { minutesBefore: 15 }],
        })
      : null;
    const attachments = ics
      ? [{
          filename: ics.filename,
          content: ics.body,
          contentType: ics.contentType,
        }]
      : undefined;

    const sendResult = await sendEmail({
      // Default to the booking's client; waitlist-slot-available overrides
      // this with the waitlist winner's address (see TriggerArgs).
      to: args.recipientOverride ?? booking.clientEmail,
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
    case "appointment.reminder_2h":    return "reminder_2h";
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
    case "appointment.reminder_2h":    return "appointment_reminder_2h";
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
    // Timezone abbreviation (e.g. PDT/EST/UTC) so custom-template authors can
    // render an unambiguous time: "{{appointment_time}} {{appointment_timezone}}".
    appointment_timezone: safeFormat(booking.startAt, tz, "zzz"),
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
    // Bad/unknown tz string — fall back to UTC formatted with the SAME
    // pattern + an explicit "UTC" label. Never emit a raw ISO string
    // (which reads as an unlabeled UTC timestamp in the email body).
    try {
      return `${formatInTimeZone(d, "UTC", pattern)} UTC`;
    } catch {
      return `${d.toISOString()} UTC`;
    }
  }
}

type LogSkeleton = {
  tenantId: string;
  bookingId: string;
  customerId?: string | null;
  templateId?: string | null;
  channel: string;
  eventType: string;
  dedupeKey?: string | null;
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
    dedupeKey: args.dedupeKey ?? null,
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
        dedupeKey: s.dedupeKey ?? null,
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
