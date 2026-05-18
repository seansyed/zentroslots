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
  | "reminder_1h";

export const TEMPLATE_TYPES: readonly TemplateType[] = [
  "booking_confirmation",
  "booking_cancelled",
  "booking_rescheduled",
  "reminder_24h",
  "reminder_1h",
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
  }
  return { ...out, source: "system" };
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
