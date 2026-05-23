import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
  role: z.enum(["admin", "staff", "client"]).default("client"),
  timezone: z.string().default("UTC"),
  // Admin signup: workspaceName is required (a new tenant is created).
  // Staff/client signup: tenantSlug is required (joins an existing tenant).
  workspaceName: z.string().min(1).max(120).optional(),
  tenantSlug: z.string().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Wave A removed `zoom` + `teams` because neither had a working
// backend integration. Wave C re-enabled `teams` via the Microsoft
// Graph adapter. Wave D re-enables `zoom` via the side-car meeting
// dispatch in lib/calendar/sync.ts — Zoom doesn't host the calendar
// event itself, but a Zoom meeting URL is wired into the staff's
// Google or Microsoft calendar event.
//
// Read paths still tolerate legacy stored values (we never migrate
// or rewrite the column); only NEW writes are constrained.
const videoProviderSchema = z.enum(["google_meet", "teams", "zoom", "none"]);

export const serviceSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens").min(1).max(80).optional(),
  description: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(8 * 60),
  price: z.number().int().min(0).default(0),
  bufferBefore: z.number().int().min(0).max(240).default(0),
  bufferAfter: z.number().int().min(0).max(240).default(0),
  videoProvider: videoProviderSchema.default("google_meet"),
  staffUserIds: z.array(z.string().uuid()).default([]),
  // Direct department ownership (migration 0032). Optional — services
  // can be created unassigned; nullable so the operator can later
  // clear the assignment. The route validates the department belongs
  // to the caller's tenant before accepting.
  departmentId: z.string().uuid().nullable().optional(),
});

export const availabilityRuleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
});

export const availabilityPutSchema = z.object({
  rules: z.array(availabilityRuleSchema),
});

export const createBookingSchema = z.object({
  serviceId: z.string().uuid(),
  staffUserId: z.union([z.string().uuid(), z.literal("auto")]),
  startAt: z.string().datetime(),       // ISO UTC string
  clientName: z.string().min(1).max(120),
  clientEmail: z.string().email(),
  notes: z.string().max(2000).optional(),
  intakeResponses: z.record(z.unknown()).optional(),
});

// ─── Phase 17H — admin/staff-driven appointment creation ──────────────
//
// Separate schema from the public `createBookingSchema` on purpose:
//   • Internal callers select an EXISTING customer by id OR quick-
//     create one inline; the public schema only takes name+email and
//     auto-upserts a customer.
//   • Staff is explicit (no "auto" — the operator picked).
//   • Optional flags differentiate operational scenarios that public
//     bookings never need: skipPayment (admin-book a free
//     consultation against a paid service), forceBook (override the
//     overlap warning), sendConfirmation (silent admin-create).
//   • `internalNotes` is staff-only and never surfaces in
//     customer-facing emails or the public confirmation page.
//
// Public bookings cannot reach this endpoint — it lives under
// /api/tenant/* which is auth-gated.
export const createAppointmentSchema = z
  .object({
    // Customer — either by id OR quick-create payload, exclusive.
    customerId: z.string().uuid().optional(),
    customer: z
      .object({
        name: z.string().min(1).max(120),
        email: z.string().email(),
        phone: z.string().max(40).optional(),
      })
      .optional(),

    serviceId: z.string().uuid(),
    staffUserId: z.string().uuid(),     // admin/manager pick a real staff
    startAt: z.string().datetime(),     // ISO UTC string

    notes: z.string().max(2000).optional(),
    internalNotes: z.string().max(2000).optional(),

    /** When false, skip the appointment.created automation (no email,
     *  no .ics, no in-app notify to the customer). Default true. */
    sendConfirmation: z.boolean().default(true),

    /** Admin override — allow booking a paid service without routing
     *  to Stripe. The booking lands as status='confirmed' with no
     *  payment record. Audit captures the override. */
    skipPayment: z.boolean().default(false),

    /** Admin override — bypass the slot-overlap pre-check. The DB-
     *  level EXCLUDE constraint (bookings_no_overlap) still applies
     *  and will reject a true double-book; this flag only suppresses
     *  the soft warning + pre-check that the admin already saw in
     *  the modal. */
    forceBook: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.customer), {
    message: "Provide exactly one of customerId or customer",
    path: ["customer"],
  });

// ─── Phase 17I — calendar_events (blocked time + internal meeting) ────
//
// Single endpoint handles both; the discriminator + payload shape
// differ enough that a union schema keeps validation honest.
//
// Blocked time fields:
//   • title (e.g. "Lunch", "PTO")
//   • staffUserId — whose calendar is blocked (admin/manager can
//     specify any; staff is locked to self at the route layer)
//   • startAt + endAt (or allDay)
//   • notes / internalNotes
//   • syncExternal — push to the connected external calendar
//
// Internal meeting fields (everything above PLUS):
//   • attendeeUserIds — other staff participants (busy-time blocked)
//   • videoProvider — optional Teams/Meet/Zoom link auto-create
//   • location — free-form
//
// Both forms reject every customer-facing field (no customerId, no
// serviceId, no payment toggles).
const calendarEventBaseSchema = z.object({
  title: z.string().min(1).max(255),
  staffUserId: z.string().uuid(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  allDay: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(2000).optional(),
  syncExternal: z.boolean().default(true),
});

export const createBlockedTimeSchema = calendarEventBaseSchema.extend({
  eventType: z.literal("blocked_time"),
});

export const createInternalMeetingSchema = calendarEventBaseSchema.extend({
  eventType: z.literal("internal_meeting"),
  /** Other staff participants. Their availability is also blocked.
   *  Empty array allowed — internal meeting with only the organizer
   *  is a "solo focus block" use case. */
  attendeeUserIds: z.array(z.string().uuid()).default([]),
  /** When set, the calendar sync orchestrator passes videoConference:
   *  true to the provider adapter, which spawns Teams/Meet/Zoom on
   *  the event create. Requires the organizer's connected calendar
   *  to support the chosen provider. */
  videoProvider: z.enum(["google_meet", "teams", "zoom"]).optional(),
  location: z.string().max(500).optional(),
});

/** Discriminated union — the endpoint picks the right schema from
 *  the eventType field. */
export const createCalendarEventSchema = z.discriminatedUnion("eventType", [
  createBlockedTimeSchema,
  createInternalMeetingSchema,
]);

export const slotsQuerySchema = z.object({
  serviceId: z.string().uuid(),
  staffUserId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
});

// ─── Availability overrides ────────────────────────────────────────────

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const hm = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "expected HH:MM");

export const overrideCreateSchema = z.object({
  userId: z.string().uuid().optional(), // defaults to caller; admin can target others
  date: ymd,
  unavailable: z.boolean().default(false),
  startTime: hm.optional(),
  endTime: hm.optional(),
  reason: z.string().max(200).optional(),
}).superRefine((v, ctx) => {
  if (v.unavailable && (v.startTime || v.endTime)) {
    ctx.addIssue({ code: "custom", message: "times must be empty when unavailable=true", path: ["unavailable"] });
  }
  if (!v.unavailable && (!v.startTime || !v.endTime)) {
    ctx.addIssue({ code: "custom", message: "startTime + endTime required when unavailable=false", path: ["startTime"] });
  }
});

export const overrideBulkSchema = z.object({
  userId: z.string().uuid().optional(),
  dates: z.array(ymd).min(1).max(366),
  unavailable: z.boolean().default(true),
  startTime: hm.optional(),
  endTime: hm.optional(),
  reason: z.string().max(200).optional(),
});

// ─── Booking status updates ────────────────────────────────────────────

export const bookingStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]),
});

export const bookingRescheduleSchema = z.object({
  startAt: z.string().datetime(),
});

// ─── Public token-based actions ────────────────────────────────────────

export const publicRescheduleSchema = z.object({
  startAt: z.string().datetime(),
});
