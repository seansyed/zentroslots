import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  timestamp,
  time,
  date,
  smallint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  decimal,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Roles: 'admin' = tenant owner, 'manager' = ops lieutenant (can see all
// bookings/services/customers but cannot touch billing/tenant settings),
// 'staff' = scoped to own bookings, 'client' = external (booking only).
export const roleEnum = pgEnum("user_role", ["admin", "manager", "staff", "client"]);
export const bookingStatusEnum = pgEnum("booking_status", [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
  // Paid-booking lifecycle (0030).
  "pending_payment",
  "payment_failed",
  "refunded",
]);

// ─── Tenants ────────────────────────────────────────────────────────────

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    plan: varchar("plan", { length: 40 }).notNull().default("free"),
    active: boolean("active").notNull().default(true),

    // Billing
    stripeCustomerId: varchar("stripe_customer_id", { length: 120 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 120 }),
    subscriptionStatus: varchar("subscription_status", { length: 40 }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    currentPlan: varchar("current_plan", { length: 40 }).notNull().default("free"),
    billingEmail: varchar("billing_email", { length: 255 }),

    // Branding
    logoUrl: text("logo_url"),
    primaryColor: varchar("primary_color", { length: 20 }).notNull().default("#2563eb"),
    tagline: varchar("tagline", { length: 200 }),
    description: text("description"),
    bookingHeadline: varchar("booking_headline", { length: 200 }),

    // Onboarding — see lib/onboarding/* for the typed reader/writer and
    // lib/onboarding/types.ts for the jsonb shape of `onboardingProgress`.
    //
    //   completed_at  → terminal "all done" state (existing semantic)
    //   started_at    → first step persisted; set by the wizard on entry
    //   skipped_at    → "finish later" escape hatch; admin is freed from
    //                   the forced wizard redirect but onboarding is NOT
    //                   considered complete
    //   progress      → { currentStep, steps[], templateApplied, telemetry }
    //
    // Migration 0042. All three new fields are additive + backwards
    // compatible: pre-migration tenants still work, post-migration code
    // gracefully handles `{}`.
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    onboardingStartedAt: timestamp("onboarding_started_at", { withTimezone: true }),
    onboardingSkippedAt: timestamp("onboarding_skipped_at", { withTimezone: true }),
    // Phase Onboarding-UX (migration 0061) — explicit "user closed
    // the dashboard checklist" signal. Distinct from
    // onboarding_skipped_at (wizard escape hatch). When set, the
    // dashboard renders a tiny "Resume setup" pill instead of the
    // full checklist until the user clicks resume.
    onboardingDismissedAt: timestamp("onboarding_dismissed_at", { withTimezone: true }),
    onboardingProgress: jsonb("onboarding_progress").notNull().default({}),

    // Outbound webhook for operational alerts (Slack-compatible)
    notificationWebhookUrl: text("notification_webhook_url"),
    // Plan-gated: when true and plan allows, embed footer hides "Powered by"
    hidePoweredBy: boolean("hide_powered_by").notNull().default(false),

    // Wave H — feature flag for the tenant-owned payment vault (migration
    // 0050). When false (default), paid bookings continue to flow through
    // the legacy platform-charge code path. When true, the booking POST
    // looks up the tenant's default payment provider, instantiates the
    // adapter with the tenant's credentials, and creates a checkout
    // session directly on the tenant's account. Money never touches
    // ZentroMeet. Flag flipped per-tenant by super-admin during Phase 6
    // opt-in rollout.
    useTenantPaymentProviders: boolean("use_tenant_payment_providers").notNull().default(false),

    // ── Default workspace hours (migration 0034) ──
    // Tenant-level fallback weekly schedule. Staff with no rows in
    // the `availability` table inherit this. Staff WITH per-user
    // rules continue to use their own rules — workspace defaults
    // never overwrite custom schedules. See lib/workspace-hours.ts
    // for the typed reader/writer + lib/availability.ts for the
    // resolution chain (position 4).
    //
    // Shape: Partial<Record<"0".."6", { start: "HH:MM", end: "HH:MM" } | null>>
    //   • `{}` = fallback inactive (default)
    //   • day key absent or null = closed that day
    //   • day key with { start, end } = open
    defaultWorkspaceHours: jsonb("default_workspace_hours").notNull().default({}),

    // ── Workspace integration enablement (migration 0035) ──
    // Tenant-scoped provider matrix that gates which integrations
    // staff may connect. Per-staff calendar connections still own
    // tokens + sync; this layer ENABLES the providers globally.
    //
    // Shape: Partial<Record<ProviderId, { enabled: boolean; enabledAt?: string }>>
    //   • Missing key  → IMPLICITLY ENABLED (backward compat)
    //   • { enabled: true }  → enabled
    //   • { enabled: false } → disabled (existing connections stay
    //     visible + honored by engine; reconnect blocked).
    // See lib/integrations.ts for the typed reader/writer.
    enabledIntegrations: jsonb("enabled_integrations").notNull().default({}),
    // Phase SMART-1 — tenant-level scheduling intelligence defaults
    // (lunch hours, end-of-day decay, quiet hours, daily soft cap).
    // Per-staff overrides live on users.focus_rules.
    focusRules: jsonb("focus_rules"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("tenants_slug_unique").on(t.slug),
    activeIdx: index("tenants_active_idx").on(t.active),
  })
);

// ─── Users ──────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("client"),
    name: varchar("name", { length: 120 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),

    googleRefreshToken: text("google_refresh_token"),
    googleCalendarId: varchar("google_calendar_id", { length: 255 }),
    googleStatus: varchar("google_status", { length: 20 }),
    googleLastErrorAt: timestamp("google_last_error_at", { withTimezone: true }),

    // Legacy single-location pointer. Kept for backward compat;
    // the canonical source of truth after migration 0037 is the
    // `staff_location_assignments` pivot below. New code reads
    // assignments via lib/workforce-location.ts.
    primaryLocationId: uuid("primary_location_id"),
    departmentId: uuid("department_id"),

    // Per-staff delivery mode (migration 0037).
    //   in_person → only physical / hybrid location bookings
    //   virtual   → only virtual-location bookings
    //   hybrid    → either (default; preserves current behavior)
    // The engine doesn't enforce this directly — the routing +
    // presence layers consume it as context.
    deliveryMode: varchar("delivery_mode", { length: 20 }).notNull().default("hybrid"),

    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    specialties: text("specialties"),

    // ── Public-facing workforce identity (migration 0033) ──
    // Curated identity used by booking pages + service pages. Both
    // nullable; render paths fall back to `name` (and omit the
    // title) when null. See lib/identity.ts for the canonical
    // public-profile resolver.
    publicDisplayName: varchar("public_display_name", { length: 120 }),
    publicTitle: varchar("public_title", { length: 120 }),

    // ── Security hardening (additive, 0028) ──
    // Bulk-revoke marker: tokens with iat < session_min_iat are rejected
    // by verifySessionFresh(). Null = no bulk revoke has ever happened.
    sessionMinIat: timestamp("session_min_iat", { withTimezone: true }),
    // Per-user permission overrides (jsonb) — see lib/security/permissions.ts.
    permissionsExtra: jsonb("permissions_extra").notNull().default({}),
    // Phase SMART-1 — optional scheduling intelligence overrides
    // (lunch hours, daily soft cap, quiet hours, etc.). Nullable;
    // falls back to tenant focus_rules, then to engine defaults.
    focusRules: jsonb("focus_rules"),
    // Last-login bookkeeping for suspicious-activity heuristic.
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastLoginIp: varchar("last_login_ip", { length: 45 }),
    lastLoginUserAgent: text("last_login_user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // (tenant_id, email) — same email may exist across tenants
    tenantEmailUnique: uniqueIndex("users_tenant_email_unique").on(t.tenantId, t.email),
    tenantIdx: index("users_tenant_idx").on(t.tenantId),
    roleIdx: index("users_role_idx").on(t.role),
  })
);

// ─── Services ───────────────────────────────────────────────────────────

export const services = pgTable(
  "services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    price: integer("price").notNull().default(0),
    bufferBefore: integer("buffer_before").notNull().default(0),
    bufferAfter: integer("buffer_after").notNull().default(0),
    isActive: integer("is_active").notNull().default(1),
    color: varchar("color", { length: 20 }),

    intakeFormId: uuid("intake_form_id"),
    minNoticeMinutes: integer("min_notice_minutes"),
    maxAdvanceDays: integer("max_advance_days"),
    videoProvider: varchar("video_provider", { length: 20 }).notNull().default("google_meet"),

    // Per-service delivery compatibility (migration 0037).
    // jsonb array of allowed delivery modes — e.g. ["virtual"],
    // ["in_person"], or both. Default is both, preserving existing
    // behavior for every service alive today. Future routing
    // enforcement layer reads this when matching customers to
    // staff-by-day. The slot generator never reads this — it
    // remains a routing/visibility filter, not an availability gate.
    deliveryModes: jsonb("delivery_modes").notNull().default(["virtual", "in_person"]),

    // ── Department primary ownership (migration 0032) ──
    // Nullable so existing services start "unassigned" without a
    // backfill. ON DELETE SET NULL via the migration's REFERENCES
    // clause — deleting a department reverts its services to
    // unassigned rather than cascading. Tenant isolation: the API
    // validates that the chosen department belongs to the caller's
    // tenant before accepting the assignment.
    departmentId: uuid("department_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("services_tenant_idx").on(t.tenantId),
    tenantSlugUnique: uniqueIndex("services_tenant_slug_unique").on(t.tenantId, t.slug),
    activeIdx: index("services_active_idx").on(t.isActive),
    departmentIdx: index("services_department_idx").on(t.departmentId),
  })
);

// ─── Service ↔ Staff (N-N) ──────────────────────────────────────────────

export const serviceStaff = pgTable(
  "service_staff",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.userId] }),
    userIdx: index("service_staff_user_idx").on(t.userId),
    tenantIdx: index("service_staff_tenant_idx").on(t.tenantId),
  })
);

// ─── Availability ───────────────────────────────────────────────────────

export const availability = pgTable(
  "availability",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("availability_tenant_idx").on(t.tenantId),
    userDayIdx: index("availability_user_day_idx").on(t.userId, t.dayOfWeek),
  })
);

// ─── Staff ↔ Location assignments (migration 0037) ──────────────────────
//
// Multi-location workforce pivot. One row per (tenant, staff,
// location). Replaces the legacy single-pointer `users.primary_location_id`
// as the source of truth for "where does this staff member work."
//
// `daysOfWeek` semantics:
//   • [] (empty)         → staff is at this location on ANY day they work
//   • ["1","2"]          → staff is at this location ONLY on Mon/Tue
//   Stringified 0..6 (Sun..Sat) to match how default_workspace_hours
//   and availability already represent days.
//
// `isPrimary`: at most one true per (tenant, staffId). Enforcement
// lives in the API write path — partial unique indexes get clumsy
// when you also need a "no primaries" state, and centralizing the
// rule in code makes it readable for anyone touching the routes.
//
// Booking engine remains untouched: this pivot is a CONTEXT layer,
// consumed by the (future) routing-presence filter, never by the
// slot generator.
export const staffLocationAssignments = pgTable(
  "staff_location_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    daysOfWeek: jsonb("days_of_week").notNull().default([]),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    staffIdx: index("staff_location_assignments_staff_idx").on(t.staffId),
    locationIdx: index("staff_location_assignments_location_idx").on(t.locationId),
    tenantIdx: index("staff_location_assignments_tenant_idx").on(t.tenantId),
    pairUnique: uniqueIndex("staff_location_assignments_pair_unique").on(
      t.tenantId, t.staffId, t.locationId,
    ),
  })
);

// ─── Bookings ───────────────────────────────────────────────────────────

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    clientName: varchar("client_name", { length: 120 }).notNull(),
    clientEmail: varchar("client_email", { length: 255 }).notNull(),

    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: bookingStatusEnum("status").notNull().default("confirmed"),

    googleEventId: varchar("google_event_id", { length: 255 }),
    // Provider-agnostic event id (set by the sync orchestrator). Kept
    // separately from googleEventId for backward compat with existing
    // bookings; new code writes to both for now.
    externalEventId: varchar("external_event_id", { length: 255 }),
    externalEventProvider: varchar("external_event_provider", { length: 20 }),
    // Wave D — side-car meeting provider columns.
    //
    // For Google Meet + Microsoft Teams bookings these stay null:
    // the meeting URL is embedded in the calendar event itself and
    // the calendar provider's event id is the only thing we need to
    // track for the meeting lifecycle.
    //
    // For Zoom bookings these capture the SEPARATE meeting resource
    // that lives outside the calendar event:
    //   • meetingProvider          — provider id ("zoom" today)
    //   • meetingProviderEventId  — Zoom's meeting id (numeric, but
    //                                stored as varchar for symmetry
    //                                with the existing external_event_id)
    // The calendar event itself (if any) is still referenced via
    // externalEventId + externalEventProvider, and meet_link holds
    // the Zoom join URL — same column the rest of the app already
    // reads. (Migration 0047.)
    meetingProvider: varchar("meeting_provider", { length: 20 }),
    meetingProviderEventId: varchar("meeting_provider_event_id", { length: 255 }),
    meetLink: text("meet_link"),
    notes: text("notes"),
    // Phase 17H — admin/staff-only annotation, never surfaced on
    // customer-facing emails or public pages. Set exclusively by
    // POST /api/tenant/appointments. Public /api/bookings does not
    // write this field. Migration 0054.
    internalNotes: text("internal_notes"),

    locationId: uuid("location_id"),
    departmentId: uuid("department_id"),
    customerId: uuid("customer_id"),

    intakeResponses: jsonb("intake_responses"),
    assignmentMode: varchar("assignment_mode", { length: 20 }).notNull().default("direct"),

    reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
    reminder1hSentAt: timestamp("reminder_1h_sent_at", { withTimezone: true }),

    // Back-pointers when this booking was materialized from a series.
    // NULL on one-off bookings (default). Set by the materializer.
    bookingSeriesId: uuid("booking_series_id"),
    bookingOccurrenceId: uuid("booking_occurrence_id"),

    // ── Paid-booking lifecycle (0030, all additive + nullable) ──
    /** Soft-hold expiry. When status='pending_payment' and this is in
     *  the past, the cleanup cron transitions the booking to
     *  'cancelled' (releasing the slot via the existing EXCLUDE
     *  constraint behavior — confirmed-only). */
    paymentHoldExpiresAt: timestamp("payment_hold_expires_at", { withTimezone: true }),
    /** Set when we create the Stripe Checkout session. Used by the
     *  webhook handler to look the booking up by session id. */
    stripeSessionId: varchar("stripe_session_id", { length: 255 }),
    /** Set on payment_intent.succeeded. Used for refund lookup. */
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    /** Charged cents at confirmation. Source of truth for refunds. */
    amountChargedCents: integer("amount_charged_cents"),

    // ── Wave H — tenant-owned payment provider linkage (migration 0050) ──
    // NULL on:
    //   • Every booking created BEFORE Wave H deployment
    //   • Free bookings (no payment provider needed)
    //   • Tenants where `tenants.use_tenant_payment_providers = false`
    //     (the legacy platform-charge path still creates the row)
    //
    // Set on Wave H paid bookings to record which tenant_payment_providers
    // row created the checkout. The Phase 4 webhook receiver uses this
    // to validate that an incoming event's provider matches what
    // created the booking — prevents cross-provider spoofing. ON DELETE
    // SET NULL so deleting a provider row preserves booking history
    // (the row goes back to "unattributed" rather than cascading away).
    paymentProviderId: uuid("payment_provider_id"),

    // ── Customer feedback loop (migration 0043) — additive, nullable ──
    /** F30: free-text reason captured on /cancel/[token]. NULL when
     *  unspecified. No PII enforcement — surfaced only in CRM. */
    cancellationReason: text("cancellation_reason"),
    /** F31: 1-5 star post-visit rating, set by the customer in portal.
     *  CHECK constraint in the migration enforces the range. */
    feedbackRating: smallint("feedback_rating"),
    /** F31: optional free-text accompanying the rating. */
    feedbackNote: text("feedback_note"),
    /** F31: idempotency marker — once set, the portal hides the rating
     *  prompt for this booking. */
    feedbackSubmittedAt: timestamp("feedback_submitted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("bookings_tenant_idx").on(t.tenantId),
    staffStartIdx: index("bookings_staff_start_idx").on(t.staffUserId, t.startAt),
    clientEmailIdx: index("bookings_client_email_idx").on(t.clientEmail),
    statusIdx: index("bookings_status_idx").on(t.status),
  })
);

// ─── Calendar Events (Phase 17H+) ────────────────────────────────────
// Operational scheduling events that block staff availability but are
// NOT customer-facing bookings:
//   • blocked_time     — lunch, PTO, focus, tax-season blocking
//   • internal_meeting — team standups, internal reviews
//
// Sibling to `bookings`. Never carries customer / payment / intake /
// service fields. The availability engine reads BOTH tables to
// compute a staff's busy set. Migration 0055.
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 'blocked_time' | 'internal_meeting' — closed enum at the app
     *  layer; varchar so future types (focus_block, travel, etc.) can
     *  be added without a Postgres enum migration. */
    eventType: varchar("event_type", { length: 20 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    /** Primary owner. Blocked_time: the blocked staff. Internal_meeting:
     *  the organizer. Additional internal-meeting participants live in
     *  attendeeUserIds. */
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** jsonb array of user ids — participants for internal meetings;
     *  empty array for blocked time. */
    attendeeUserIds: jsonb("attendee_user_ids").notNull().default([]),
    notes: text("notes"),
    /** Admin/staff-only annotation, never surfaced on customer-facing
     *  emails (none are sent for these events anyway). */
    internalNotes: text("internal_notes"),
    location: text("location"),
    videoProvider: varchar("video_provider", { length: 20 }),
    meetLink: text("meet_link"),
    externalEventId: varchar("external_event_id", { length: 255 }),
    externalEventProvider: varchar("external_event_provider", { length: 20 }),
    /** When true, push to the organizer's connected external calendar.
     *  Default true so the block shows up on the staff's Outlook/Google. */
    syncExternal: boolean("sync_external").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("calendar_events_tenant_idx").on(t.tenantId),
    staffWindowIdx: index("calendar_events_staff_window_idx").on(t.staffUserId, t.startAt),
    tenantWindowIdx: index("calendar_events_tenant_window_idx").on(t.tenantId, t.startAt, t.endAt),
  }),
);

// ─── Group Sessions (Phase 17I-3A) ──────────────────────────────────────
//
// Customer-facing group events: one host + many attendees + one shared
// meeting link (webinars, onboarding, workshops, office hours). Sibling
// to bookings (1:1) and calendar_events (operational, non-customer).
// Migration 0056.

export const groupSessions = pgTable(
  "group_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    /** Optional service linkage — nullable for ad-hoc sessions
     *  (e.g. office hours) that don't map to a priced service. */
    serviceId: uuid("service_id").references(() => services.id, {
      onDelete: "set null",
    }),
    /** Primary host. v1 supports a single host; multi-host extension
     *  ships when public registration does. */
    hostUserId: uuid("host_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    /** 0 = unlimited; positive integer caps registrations. */
    maxCapacity: integer("max_capacity").notNull().default(0),
    /** Cached count of confirmed registrations (maintained by future
     *  public registration flow; stays 0 in v1). */
    currentRegistrations: integer("current_registrations").notNull().default(0),
    videoProvider: varchar("video_provider", { length: 20 }),
    meetLink: text("meet_link"),
    location: text("location"),
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    registrationDeadline: timestamp("registration_deadline", {
      withTimezone: true,
    }),
    externalEventId: varchar("external_event_id", { length: 255 }),
    externalEventProvider: varchar("external_event_provider", { length: 20 }),
    syncExternal: boolean("sync_external").notNull().default(true),
    /** scheduled | cancelled. Cancelled rows are soft-deleted (kept for
     *  audit) and excluded from the host-overlap EXCLUDE constraint. */
    status: varchar("status", { length: 20 }).notNull().default("scheduled"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("group_sessions_tenant_idx").on(t.tenantId),
    hostWindowIdx: index("group_sessions_host_window_idx").on(t.hostUserId, t.startAt),
    tenantWindowIdx: index("group_sessions_tenant_window_idx").on(t.tenantId, t.startAt, t.endAt),
  }),
);

// ─── Staff Calendar Feed Tokens (Phase ICAL-2) ──────────────────────────
//
// Per-staff secrets backing Apple Calendar webcal:// subscription feeds.
// Migration 0057. See db/migrations/0057_staff_calendar_feed_tokens.sql
// for full design notes.
//
// SHA-256-hashed at rest; never reversible. One active token per
// (tenant_id, user_id); rotation soft-revokes the prior row for
// audit instead of hard-deleting it.

export const staffCalendarFeedTokens = pgTable(
  "staff_calendar_feed_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // SHA-256 hex of the 256-bit secret. 64 chars.
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    lastAccessedIp: varchar("last_accessed_ip", { length: 45 }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // 'rotated' | 'user_revoke' | 'admin_revoke' | 'staff_offboarded'
    revokedReason: varchar("revoked_reason", { length: 40 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUnique: uniqueIndex("staff_calendar_feed_tokens_hash_unique").on(t.tokenHash),
    activeIdx: index("staff_calendar_feed_tokens_active_idx").on(t.tenantId, t.userId),
    tenantIdx: index("staff_calendar_feed_tokens_tenant_idx").on(t.tenantId, t.createdAt),
  }),
);

// ─── External Calendar Feeds (Phase ICAL-3) ─────────────────────────────
//
// Read-only inbound ICS feed import. Users paste shared/published
// calendar URLs (Apple iCloud share URL, Outlook published .ics,
// Google iCal URL, Exchange feed, etc.) and ZentroMeet:
//   • periodically fetches the feed
//   • parses RFC 5545 events
//   • caches normalized busy windows in external_feed_events
//   • blocks overlapping booking slots in the availability engine
//
// No CalDAV. No write-back. No Apple credentials. Feed URLs are
// encrypted at rest via lib/crypto.ts. Migration 0058.

export const externalCalendarFeeds = pgTable(
  "external_calendar_feeds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerLabel: varchar("provider_label", { length: 120 }).notNull(),
    feedUrlEncrypted: text("feed_url_encrypted").notNull(),
    normalizedFeedHash: varchar("normalized_feed_hash", { length: 64 }).notNull(),
    providerKind: varchar("provider_kind", { length: 20 }).notNull().default("other"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // 'ok' | 'error' | 'pending' | 'rate_limited' | 'fetch_failed' |
    // 'parse_failed' | 'too_large' | 'ssrf_blocked'
    lastSyncStatus: varchar("last_sync_status", { length: 30 }),
    lastError: text("last_error"),
    etag: varchar("etag", { length: 255 }),
    lastModified: varchar("last_modified", { length: 64 }),
    nextSyncAfter: timestamp("next_sync_after", { withTimezone: true }).notNull().defaultNow(),
    // Phase ICAL-4 diagnostic columns (migration 0059) — additive,
    // all nullable or default-bearing so pre-ICAL-4 code paths
    // remain byte-compatible.
    syncDurationMs: integer("sync_duration_ms"),
    eventCount: integer("event_count"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    notifiedStaleAt: timestamp("notified_stale_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDedupe: uniqueIndex("external_calendar_feeds_user_dedupe").on(
      t.tenantId,
      t.userId,
      t.normalizedFeedHash,
    ),
    activeIdx: index("external_calendar_feeds_active_idx").on(t.tenantId, t.userId),
    dueIdx: index("external_calendar_feeds_due_idx").on(t.nextSyncAfter),
    // Partial index used by the admin observability endpoint to
    // surface problematic feeds without scanning the whole table.
    failuresIdx: index("external_calendar_feeds_failures_idx").on(
      t.tenantId,
      t.consecutiveFailures,
    ),
  }),
);

export const externalFeedEvents = pgTable(
  "external_feed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => externalCalendarFeeds.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceUid: varchar("source_uid", { length: 255 }).notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    summary: varchar("summary", { length: 200 }),
    status: varchar("status", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userWindowIdx: index("external_feed_events_user_window_idx").on(
      t.userId,
      t.startAt,
      t.endAt,
    ),
    feedIdx: index("external_feed_events_feed_idx").on(t.feedId),
  }),
);

// ─── Availability Overrides ─────────────────────────────────────────────
// Vacations, holidays, lunch breaks, custom one-off schedules.
// Multiple rows per (user_id, date) supported for split-day schedules.

export const availabilityOverrides = pgTable(
  "availability_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),               // YYYY-MM-DD in user's tz
    unavailable: boolean("unavailable").notNull().default(false),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: varchar("reason", { length: 200 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("availability_overrides_tenant_idx").on(t.tenantId),
    userDateIdx: index("availability_overrides_user_date_idx").on(t.userId, t.date),
  })
);

// ─── Wave H — Tenant Payment Provider Vault (migration 0050) ────────────
// One row per (tenant, provider, mode). Secrets stored as v1: envelopes
// from lib/crypto.encryptSecret. See db/migrations/0050_tenant_payment
// _providers.sql for the full column-level commentary — these
// definitions mirror that DDL.

export const tenantPaymentProviders = pgTable(
  "tenant_payment_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** 'stripe' today; 'paypal' Phase 2; 'square'/'authorize_net' future.
     *  Varchar (not enum) so additions don't require enum migration. */
    provider: varchar("provider", { length: 20 }).notNull(),
    /** 'live' | 'test' — tenant can configure both in parallel. */
    mode: varchar("mode", { length: 10 }).notNull().default("live"),
    /** Tenant-chosen display name. Never used as credential. */
    accountLabel: varchar("account_label", { length: 120 }).notNull().default(""),

    // ── Credentials (all v1: envelopes from lib/crypto.encryptSecret) ──
    /** Master credential: Stripe secret key / PayPal client_secret. Never
     *  decrypted on a path that returns to the client. */
    secretEncrypted: text("secret_encrypted").notNull(),
    /** Stripe publishable key — safe to expose, stored plaintext for UI. */
    publishableKey: text("publishable_key"),
    /** PayPal client_id — semi-public, stored plaintext. */
    clientId: text("client_id"),
    /** Webhook signing secret (Stripe whsec_… / PayPal webhook_id).
     *  Encrypted because some providers treat it as credential-grade. */
    webhookSecretEncrypted: text("webhook_secret_encrypted"),

    // ── Connection state ──
    /** 'pending' | 'verified' | 'invalid' | 'disabled' */
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),

    /** Provider-reported capabilities from validateCredentials(). */
    capabilities: jsonb("capabilities").notNull().default({}),

    /** Partial unique index in migration enforces exactly one per
     *  (tenant, mode) where is_default = true. */
    isDefault: boolean("is_default").notNull().default(false),
    /** Soft toggle. Disabled providers preserved for audit. */
    enabled: boolean("enabled").notNull().default(true),

    /** Updated by webhook receiver (Phase 4) on every classified 'paid'
     *  event. Surfaces "last paid 2h ago" in dashboard health card. */
    lastPaymentEventAt: timestamp("last_payment_event_at", { withTimezone: true }),

    // ── Wave H Phase 2 — webhook health + operational metadata (0051) ──
    /** 'unconfigured' | 'configured' | 'verified' | 'failing'. See the
     *  0051 migration for the lifecycle. Defaults 'unconfigured' so
     *  pre-Phase-2 rows behave correctly. */
    webhookStatus: varchar("webhook_status", { length: 20 }).notNull().default("unconfigured"),
    lastWebhookVerifiedAt: timestamp("last_webhook_verified_at", { withTimezone: true }),
    lastWebhookError: text("last_webhook_error"),
    lastWebhookErrorAt: timestamp("last_webhook_error_at", { withTimezone: true }),
    /** Operational snapshot (lastValidateLatencyMs, recentEventCount24h,
     *  etc.). Distinct from `capabilities` which is the provider's
     *  static account info. Adapter + worker write here. */
    health: jsonb("health").notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id"),
  },
  (t) => ({
    /** Re-saving a provider overwrites in place rather than duplicating. */
    tenantProviderModeUq: uniqueIndex("tenant_payment_providers_tenant_provider_mode_key")
      .on(t.tenantId, t.provider, t.mode),
  })
);

export const tenantPaymentWebhookEvents = pgTable(
  "tenant_payment_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => tenantPaymentProviders.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    /** Provider's event id (Stripe evt_…, PayPal event id). The UNIQUE
     *  on (provider_id, external_event_id) gives us idempotent dedup
     *  across replays without colliding with processed_stripe_events. */
    externalEventId: varchar("external_event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    /** Set when classifier resolved a booking; NULL otherwise. */
    bookingId: uuid("booking_id"),
    /** 'received' | 'processed' | 'invalid_signature' | 'replay' | 'unhandled' */
    status: varchar("status", { length: 20 }).notNull(),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // ── Wave H Phase 3 — forensic retention (migration 0052) ──
    /** Parsed (NOT raw bytes) event payload. JSON.parse'd ONCE inside the
     *  receiver, redacted of token-shaped substrings via adapter's
     *  redactSecrets(), then stored. PII (customer email, name, billing
     *  country) IS present and governed by tenant retention policy. */
    rawPayload: jsonb("raw_payload"),
    /** Lowercase-keyed map of provider-prefixed headers we received
     *  (stripe-*, paypal-*). Used for offline signature re-verification
     *  + cert_url debugging. Never includes auth/cookies/forwarded headers. */
    signatureHeaders: jsonb("signature_headers"),
    /** ms from receiver entry to 200 response. Surfaces slow PayPal
     *  verify calls in dashboard health card. */
    processingDurationMs: integer("processing_duration_ms"),
  },
  (t) => ({
    providerEventUq: uniqueIndex("tenant_payment_webhook_events_provider_event_key")
      .on(t.providerId, t.externalEventId),
    tenantReceivedIdx: index("tenant_payment_webhook_events_tenant_idx")
      .on(t.tenantId, t.receivedAt),
  })
);

// ─── Relations ──────────────────────────────────────────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  services: many(services),
  bookings: many(bookings),
  paymentProviders: many(tenantPaymentProviders),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
  availability: many(availability),
  bookingsAsStaff: many(bookings),
  serviceStaff: many(serviceStaff),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  tenant: one(tenants, { fields: [services.tenantId], references: [tenants.id] }),
  bookings: many(bookings),
  serviceStaff: many(serviceStaff),
}));

export const serviceStaffRelations = relations(serviceStaff, ({ one }) => ({
  service: one(services, { fields: [serviceStaff.serviceId], references: [services.id] }),
  user: one(users, { fields: [serviceStaff.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [serviceStaff.tenantId], references: [tenants.id] }),
}));

export const availabilityRelations = relations(availability, ({ one }) => ({
  user: one(users, { fields: [availability.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [availability.tenantId], references: [tenants.id] }),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  service: one(services, { fields: [bookings.serviceId], references: [services.id] }),
  staff: one(users, { fields: [bookings.staffUserId], references: [users.id] }),
  tenant: one(tenants, { fields: [bookings.tenantId], references: [tenants.id] }),
  paymentProvider: one(tenantPaymentProviders, {
    fields: [bookings.paymentProviderId],
    references: [tenantPaymentProviders.id],
  }),
}));

export const tenantPaymentProvidersRelations = relations(
  tenantPaymentProviders,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [tenantPaymentProviders.tenantId],
      references: [tenants.id],
    }),
    webhookEvents: many(tenantPaymentWebhookEvents),
  })
);

export const tenantPaymentWebhookEventsRelations = relations(
  tenantPaymentWebhookEvents,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tenantPaymentWebhookEvents.tenantId],
      references: [tenants.id],
    }),
    provider: one(tenantPaymentProviders, {
      fields: [tenantPaymentWebhookEvents.providerId],
      references: [tenantPaymentProviders.id],
    }),
  })
);

export const availabilityOverridesRelations = relations(availabilityOverrides, ({ one }) => ({
  user: one(users, { fields: [availabilityOverrides.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [availabilityOverrides.tenantId], references: [tenants.id] }),
}));

// ─── Locations ──────────────────────────────────────────────────────────

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    address: text("address"),
    timezone: varchar("timezone", { length: 64 }),
    phone: varchar("phone", { length: 40 }),
    email: varchar("email", { length: 255 }),
    isActive: boolean("is_active").notNull().default(true),

    // Location identity enrichment (migration 0036).
    //
    // logoUrl       — content-addressed path served by nginx; reuses
    //                 the existing /uploads/ alias (avatars phase).
    // locationType  — 'physical' | 'virtual' | 'hybrid'. Stored as
    //                 varchar (not DB enum) so adding new types is a
    //                 one-line Zod change.
    // notes         — admin-only operational metadata. NEVER selected
    //                 by public-facing routes.
    logoUrl: text("logo_url"),
    locationType: varchar("location_type", { length: 20 }).notNull().default("physical"),
    notes: text("notes"),

    // System-protected location (migration 0037). True when the
    // platform created this row — e.g. the auto-spawned "Virtual
    // Hub" produced when a tenant first sets a staff member to
    // delivery_mode='virtual'. /api/locations/[id] DELETE refuses
    // to remove rows where is_system=true.
    isSystem: boolean("is_system").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("locations_tenant_idx").on(t.tenantId),
    activeIdx: index("locations_active_idx").on(t.isActive),
  })
);

export const locationsRelations = relations(locations, ({ one }) => ({
  tenant: one(tenants, { fields: [locations.tenantId], references: [tenants.id] }),
}));

// ─── Departments ────────────────────────────────────────────────────────

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    color: varchar("color", { length: 20 }),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("departments_tenant_idx").on(t.tenantId),
  })
);

export const departmentsRelations = relations(departments, ({ one }) => ({
  tenant: one(tenants, { fields: [departments.tenantId], references: [tenants.id] }),
}));

// ─── Customers ──────────────────────────────────────────────────────────

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 40 }),
    notes: text("notes"),
    tags: jsonb("tags").notNull().default([]),
    // Per-customer communication preferences. Shape is defined in
    // lib/client-prefs.ts so missing keys fall back to sensible defaults.
    commPrefs: jsonb("comm_prefs").notNull().default({}),
    status: varchar("status", { length: 40 }).notNull().default("active"),
    // F32 — Notification read-state. Updated when the customer visits
    // /client/[slug]/notifications. The portal shell shows an unread
    // dot when any audit_log event newer than this exists for one of
    // this customer's bookings. NULL = never visited (everything
    // before "now" counts as unread on first visit).
    notificationsLastSeenAt: timestamp("notifications_last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("customers_tenant_idx").on(t.tenantId),
  })
);

export const customersRelations = relations(customers, ({ one }) => ({
  tenant: one(tenants, { fields: [customers.tenantId], references: [tenants.id] }),
}));

// ─── Notifications ──────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 60 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTimeIdx: index("notifications_user_time_idx").on(t.userId, t.createdAt),
    tenantIdx: index("notifications_tenant_idx").on(t.tenantId),
  })
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  tenant: one(tenants, { fields: [notifications.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

// ─── Tasks ──────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    /** Optional explicit priority ("urgent" | "high" | "medium" | "low").
     *  When null, the client derives a visual priority from `dueAt` so
     *  legacy rows still render with sensible rail / chip treatments.
     *  See migration 0031_task_priority.sql. */
    priority: varchar("priority", { length: 16 }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    relatedCustomerId: uuid("related_customer_id").references(() => customers.id, { onDelete: "set null" }),
    relatedBookingId: uuid("related_booking_id").references(() => bookings.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantStatusIdx: index("tasks_tenant_status_idx").on(t.tenantId, t.status),
    assignedIdx: index("tasks_assigned_idx").on(t.assignedUserId),
  })
);

export const tasksRelations = relations(tasks, ({ one }) => ({
  tenant: one(tenants, { fields: [tasks.tenantId], references: [tenants.id] }),
  assignedTo: one(users, { fields: [tasks.assignedUserId], references: [users.id] }),
  customer: one(customers, { fields: [tasks.relatedCustomerId], references: [customers.id] }),
  booking: one(bookings, { fields: [tasks.relatedBookingId], references: [bookings.id] }),
}));

// ─── Intake Forms ───────────────────────────────────────────────────────

export const intakeForms = pgTable(
  "intake_forms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    fields: jsonb("fields").notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    // Wave I additions (migration 0053)
    description: text("description"),
    submissionCount: integer("submission_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("intake_forms_tenant_idx").on(t.tenantId),
  })
);

export const intakeFormsRelations = relations(intakeForms, ({ one, many }) => ({
  tenant: one(tenants, { fields: [intakeForms.tenantId], references: [tenants.id] }),
  responses: many(intakeFieldResponses),
}));

// ─── Wave I — normalized intake field responses (migration 0053) ────────
// One row per (booking, field). The persistResponses helper writes here
// in the same transaction that updates bookings.intake_responses jsonb
// (kept for backward compat with existing readers).
export const intakeFieldResponses = pgTable(
  "intake_field_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    /** Nullable: response history survives form deletion (FK SET NULL). */
    intakeFormId: uuid("intake_form_id").references(() => intakeForms.id, {
      onDelete: "set null",
    }),
    fieldKey: varchar("field_key", { length: 60 }).notNull(),
    /** Snapshot of label at submit time — preserves audit fidelity even
     *  if the form definition diverges later. */
    fieldLabel: varchar("field_label", { length: 200 }).notNull(),
    fieldType: varchar("field_type", { length: 30 }).notNull(),
    /** One of value_text / value_number / value_json is populated based
     *  on field_type. The persistResponses helper enforces this; the
     *  schema does not (a CHECK would add maintenance overhead). */
    valueText: text("value_text"),
    valueNumber: text("value_number"), // numeric stored as text for precision
    valueJson: jsonb("value_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("intake_field_responses_tenant_idx").on(t.tenantId, t.createdAt),
    bookingIdx: index("intake_field_responses_booking_idx").on(t.bookingId),
    fieldIdx: index("intake_field_responses_field_idx").on(t.tenantId, t.fieldKey),
    // One response per (booking, field). persistResponses uses
    // ON CONFLICT for atomic upsert on retries.
    bookingFieldUq: uniqueIndex("intake_field_responses_booking_field_key").on(
      t.bookingId,
      t.fieldKey,
    ),
  }),
);

export const intakeFieldResponsesRelations = relations(intakeFieldResponses, ({ one }) => ({
  tenant: one(tenants, {
    fields: [intakeFieldResponses.tenantId],
    references: [tenants.id],
  }),
  booking: one(bookings, {
    fields: [intakeFieldResponses.bookingId],
    references: [bookings.id],
  }),
  form: one(intakeForms, {
    fields: [intakeFieldResponses.intakeFormId],
    references: [intakeForms.id],
  }),
}));

// ─── Tenant Domains ─────────────────────────────────────────────────────

export const tenantDomains = pgTable(
  "tenant_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    host: varchar("host", { length: 253 }).notNull(),
    // Lowercased + trailing-dot-stripped form. Used by middleware for
    // O(1) hostname → tenant resolution. Globally unique.
    normalizedHost: varchar("normalized_host", { length: 253 }).notNull(),
    verificationToken: varchar("verification_token", { length: 64 }).notNull(),
    // Lifecycle: pending → verified | failed
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    // SSL provisioning lifecycle (architecture-ready). Real cert issuance
    // is delegated to the edge (Caddy / Cloudflare SSL for SaaS / ACM)
    // and reflected back into this column when wired.
    sslStatus: varchar("ssl_status", { length: 32 }).notNull().default("pending"),
    // Cloudflare Custom Hostname UUID — populated by the edge
    // provisioning step after DNS verification passes.
    cfHostnameId: varchar("cf_hostname_id", { length: 64 }),
    // Last error message from CF or DNS — surfaced in the UI when the
    // domain is unhealthy. Null when there's nothing wrong.
    verificationErrors: text("verification_errors"),
    // Wall-clock when ssl_status first transitioned to "active".
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("tenant_domains_tenant_idx").on(t.tenantId),
    normalizedHostUnique: index("tenant_domains_normalized_host_unique").on(t.normalizedHost),
    statusIdx: index("tenant_domains_status_idx").on(t.status),
    cfHostnameIdx: index("tenant_domains_cf_hostname_id_idx").on(t.cfHostnameId),
  })
);

export const tenantDomainsRelations = relations(tenantDomains, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantDomains.tenantId], references: [tenants.id] }),
}));

// ─── Embed Events ───────────────────────────────────────────────────────

export const embedEvents = pgTable(
  "embed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    kind: varchar("kind", { length: 40 }).notNull(),
    referer: text("referer"),
    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTimeIdx: index("embed_events_tenant_time_idx").on(t.tenantId, t.createdAt),
    serviceIdx: index("embed_events_service_idx").on(t.serviceId),
    kindIdx: index("embed_events_kind_idx").on(t.kind),
  })
);

export const embedEventsRelations = relations(embedEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [embedEvents.tenantId], references: [tenants.id] }),
  service: one(services, { fields: [embedEvents.serviceId], references: [services.id] }),
}));

// ─── Audit Log ──────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: varchar("actor_label", { length: 120 }),
    action: varchar("action", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 40 }),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantTimeIdx: index("audit_logs_tenant_time_idx").on(t.tenantId, t.createdAt),
    actionIdx: index("audit_logs_action_idx").on(t.action),
    entityIdx: index("audit_logs_entity_idx").on(t.entityType, t.entityId),
  })
);

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  tenant: one(tenants, { fields: [auditLogs.tenantId], references: [tenants.id] }),
  actor: one(users, { fields: [auditLogs.actorUserId], references: [users.id] }),
}));

// ─── Communication engine ──────────────────────────────────────────────
// Tenant-customizable templates + automation rules + delivery logs.
// Backward-compat: missing template rows fall back to system code defaults
// (see lib/communications/templates.ts) so existing tenants behave
// identically until they explicitly customize.

export const communicationTemplates = pgTable(
  "communication_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id"),
    templateType: varchar("template_type", { length: 60 }).notNull(),
    channel: varchar("channel", { length: 20 }).notNull().default("email"),
    subject: varchar("subject", { length: 500 }),
    htmlContent: text("html_content"),
    textContent: text("text_content"),
    enabled: boolean("enabled").notNull().default(true),
    systemDefault: boolean("system_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("comm_templates_tenant_idx").on(t.tenantId),
  })
);

export const automationRules = pgTable(
  "automation_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id"),
    triggerEvent: varchar("trigger_event", { length: 60 }).notNull(),
    delayMinutes: integer("delay_minutes").notNull().default(0),
    channel: varchar("channel", { length: 20 }).notNull().default("email"),
    templateId: uuid("template_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("automation_rules_tenant_idx").on(t.tenantId),
    triggerIdx: index("automation_rules_trigger_idx").on(t.tenantId, t.triggerEvent),
  })
);

export const communicationLogs = pgTable(
  "communication_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id"),
    customerId: uuid("customer_id"),
    templateId: uuid("template_id"),
    channel: varchar("channel", { length: 20 }).notNull(),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    provider: varchar("provider", { length: 40 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    failureReason: text("failure_reason"),
    skippedReason: varchar("skipped_reason", { length: 60 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("comm_logs_tenant_idx").on(t.tenantId),
    bookingIdx: index("comm_logs_booking_idx").on(t.bookingId),
    eventIdx: index("comm_logs_event_idx").on(t.tenantId, t.eventType),
    statusIdx: index("comm_logs_status_idx").on(t.status),
  })
);

// ─── Email suppression list (SES deliverability hardening) ──────────────
// Permanent bounces + complaints from SES SNS notifications populate
// this table. The sendEmail() pre-send check skips any address
// matched here so we don't degrade SES sender reputation.
//
// Migration: 0062_email_suppressions.sql
// Webhook:   app/api/webhooks/ses/route.ts
// Helper:    lib/email-suppression.ts
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    emailLower: varchar("email_lower", { length: 320 }).notNull(),
    /** 'bounce' | 'complaint' | 'manual' — see migration header */
    kind: varchar("kind", { length: 20 }).notNull(),
    /** SES bounce sub-type; only 'Permanent' should suppress */
    bounceSubtype: varchar("bounce_subtype", { length: 40 }),
    /** Free-form attribution ('ses-sns', 'manual:<userId>', etc) */
    source: varchar("source", { length: 120 }).notNull().default("ses-sns"),
    /** Diagnostic string from SES (last SMTP code, etc) */
    reason: text("reason"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    eventCount: integer("event_count").notNull().default(1),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => ({
    // UPSERT key — one row per (address, kind)
    emailKindUnique: uniqueIndex("idx_email_suppressions_email_kind").on(t.emailLower, t.kind),
    emailIdx: index("idx_email_suppressions_email").on(t.emailLower),
    kindTimeIdx: index("idx_email_suppressions_kind_time").on(t.kind, t.lastSeenAt),
  })
);

// ─── Tenant feature toggles ─────────────────────────────────────────────
// One row per tenant; absence = all defaults (everything on). Flags is a
// jsonb blob: which keys are valid and what their defaults are is owned
// by lib/features.ts (the migration-free path for adding toggles).
//
// Only the toggles whose runtime backend exists are honored at the
// gate sites — see lib/features.ts for the closed FeatureFlag union.
export const tenantFeatureSettings = pgTable(
  "tenant_feature_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    flags: jsonb("flags").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantUnique: uniqueIndex("tenant_feature_settings_tenant_unique").on(t.tenantId),
  })
);

// ─── Calendar connections + sync logs ───────────────────────────────────
// One row per (user, provider) when active; reconnect updates in place,
// disconnect flips status to 'disconnected' but keeps the row for audit.
// Provider is a varchar so future MS Graph (outlook/office365) lands
// without a schema change — the lib/calendar/types CalendarProvider
// union is the runtime gatekeeper. Tokens are AES-256-GCM encrypted via
// lib/crypto.ts envelopes (v1: prefix).
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    accessTokenEncrypted: text("access_token_encrypted"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    calendarId: varchar("calendar_id", { length: 255 }).notNull().default("primary"),
    scopes: jsonb("scopes").notNull().default([]),
    accountEmail: varchar("account_email", { length: 255 }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    // Wave A — connection health foundation (migration 0044).
    // consecutiveFailures: incremented on every sync-call failure,
    //   reset to 0 on success. Used by the future health-check cron to
    //   surface "5+ failures in a row" before the staff member discovers
    //   the broken connection via a missing Meet link.
    // lastReconnectEmailAt: dedupe marker so we email the staff at most
    //   once per 24h when their connection flips to needs_reconnect.
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastReconnectEmailAt: timestamp("last_reconnect_email_at", { withTimezone: true }),
    // Wave E — multi-calendar foundation. jsonb array of
    // `{ id: string, summary: string }` objects. NOT YET CONSUMED by
    // the orchestrator; future wave will read this to aggregate busy
    // time across secondary calendars (e.g. shared vacations).
    // Default `[]` preserves all existing behavior.
    secondaryCalendarIds: jsonb("secondary_calendar_ids").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("calendar_connections_tenant_idx").on(t.tenantId),
    statusIdx: index("calendar_connections_status_idx").on(t.status),
  })
);

// ─── Wave E — webhook subscriptions ─────────────────────────────────────
// One row per active provider push subscription. The receiver routes
// incoming webhooks back to the right (tenant, user, connection) via
// external_channel_id; the renewal cron extends expiring rows.
export const webhookChannels = pgTable(
  "webhook_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => calendarConnections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    externalChannelId: varchar("external_channel_id", { length: 255 }).notNull(),
    externalResourceId: varchar("external_resource_id", { length: 255 }),
    clientState: varchar("client_state", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionUnique: uniqueIndex("webhook_channels_connection_unique").on(t.connectionId),
    expiresIdx: index("webhook_channels_expires_idx").on(t.expiresAt),
    externalIdIdx: index("webhook_channels_external_id_idx").on(t.externalChannelId),
  }),
);

// ─── Wave E — freebusy cache ───────────────────────────────────────────
// DB-backed cache keyed on (connection_id, window_start, window_end).
// Wired into the orchestrator's freebusy reader; invalidated by the
// webhook receiver on any external event change.
export const freebusyCache = pgTable(
  "freebusy_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => calendarConnections.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    busyIntervals: jsonb("busy_intervals").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookupIdx: index("freebusy_cache_lookup_idx").on(t.connectionId, t.windowStart, t.windowEnd),
    expiresIdx: index("freebusy_cache_expires_idx").on(t.expiresAt),
    connectionIdx: index("freebusy_cache_connection_idx").on(t.connectionId),
  }),
);

// ─── Wave E — sync drift events ────────────────────────────────────────
// Append-only log of detected drift between our booking state and the
// provider's state. Detection-only in Wave E; future wave can add
// auto-repair workflows that read from this table.
export const syncDriftEvents = pgTable(
  "sync_drift_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => calendarConnections.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    bookingId: uuid("booking_id"),
    provider: varchar("provider", { length: 20 }).notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull().default("warn"),
    details: jsonb("details").notNull().default({}),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("sync_drift_tenant_idx").on(t.tenantId, t.detectedAt),
    kindIdx: index("sync_drift_kind_idx").on(t.kind),
  }),
);

export const calendarSyncLogs = pgTable(
  "calendar_sync_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => calendarConnections.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    bookingId: uuid("booking_id"),
    provider: varchar("provider", { length: 20 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    errorClass: varchar("error_class", { length: 20 }),
    errorMessage: text("error_message"),
    externalEventId: varchar("external_event_id", { length: 255 }),
    latencyMs: integer("latency_ms"),
    // Wave A — number of retries attempted before this final outcome.
    // 0 = succeeded on first try. >0 = retried N times. Visible in the
    // sync-log surface so admins can see "succeeded after 2 retries"
    // vs "failed after 3 retries". (migration 0044)
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("calendar_sync_logs_tenant_idx").on(t.tenantId, t.createdAt),
    connectionIdx: index("calendar_sync_logs_connection_idx").on(t.connectionId, t.createdAt),
    bookingIdx: index("calendar_sync_logs_booking_idx").on(t.bookingId),
  })
);

// ─── Scheduled reports ──────────────────────────────────────────────────
// One row per (tenant, period_type, period_start). Body is a jsonb
// snapshot of the KPI summary at generation time — admins can scroll
// back to historical reports without recomputing. Cron UPSERTs by
// the unique tuple so re-runs overwrite with the latest numbers.
export const scheduledReports = pgTable(
  "scheduled_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    periodType: varchar("period_type", { length: 20 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    body: jsonb("body").notNull().default({}),
    generationMs: integer("generation_ms"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("scheduled_reports_tenant_idx").on(t.tenantId),
    periodIdx: index("scheduled_reports_period_idx").on(t.tenantId, t.periodType, t.periodStart),
    unique: uniqueIndex("scheduled_reports_unique").on(t.tenantId, t.periodType, t.periodStart),
  })
);

// ─── Canonical billing ledger ───────────────────────────────────────────
// Captures Stripe webhook events (and manual adjustments) as the source
// of truth for revenue analytics. Strictly additive — tenants without
// Stripe traffic continue normally. Stripe retry idempotency via partial
// unique indexes on stripe_event_id + stripe_payment_intent_id (handler
// swallows 23505).
export const billingTransactions = pgTable(
  "billing_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    stripeEventId: varchar("stripe_event_id", { length: 120 }),
    stripeInvoiceId: varchar("stripe_invoice_id", { length: 120 }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 120 }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 120 }),
    customerId: uuid("customer_id"),
    bookingId: uuid("booking_id"),
    subscriptionId: uuid("subscription_id"),
    // bigint(mode:'number') maps int8 → number — safe up to 2^53 cents
    // ($90T), more than enough headroom for per-transaction amounts.
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 8 }).notNull().default("usd"),
    transactionType: varchar("transaction_type", { length: 30 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantPaidIdx: index("billing_transactions_tenant_paid_idx").on(t.tenantId, t.paidAt),
    tenantStatusIdx: index("billing_transactions_tenant_status_idx").on(t.tenantId, t.status),
    tenantTypeIdx: index("billing_transactions_tenant_type_idx").on(t.tenantId, t.transactionType),
  })
);

// ─── Stripe webhook idempotency dedup table ─────────────────────────────
// Phase 4 of billing enforcement. The webhook handler INSERTs each
// event_id at the top; ON CONFLICT DO NOTHING + a returned-rows check
// tells us whether this is a fresh event or a retry. Retries return
// 200 immediately and skip the switch — protects against re-mutating
// the tenants row when Stripe replays.
//
// The billing_transactions ledger already has its own dedup on
// stripe_event_id, but it only tracks payment/refund events, NOT
// subscription.created/updated/deleted. This table covers EVERY
// event type and is the canonical webhook dedup boundary.
export const processedStripeEvents = pgTable(
  "processed_stripe_events",
  {
    eventId: varchar("event_id", { length: 120 }).primaryKey(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("processed_stripe_events_tenant_idx").on(t.tenantId),
    processedAtIdx: index("processed_stripe_events_processed_at_idx").on(t.processedAt),
  })
);

// ─── Analytics daily snapshots ──────────────────────────────────────────
// One row per (tenant, day). The aggregation worker upserts this table
// nightly. Without rows, the analytics page falls back to live queries
// — preserves the existing pre-feature behavior (rule #12).
export const analyticsDailySnapshots = pgTable(
  "analytics_daily_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date").notNull(),
    totalBookings: integer("total_bookings").notNull().default(0),
    completedBookings: integer("completed_bookings").notNull().default(0),
    cancelledBookings: integer("cancelled_bookings").notNull().default(0),
    noShowBookings: integer("no_show_bookings").notNull().default(0),
    recurringBookings: integer("recurring_bookings").notNull().default(0),
    waitlistJoins: integer("waitlist_joins").notNull().default(0),
    waitlistConversions: integer("waitlist_conversions").notNull().default(0),
    reviewRequestsSent: integer("review_requests_sent").notNull().default(0),
    reviewsCompleted: integer("reviews_completed").notNull().default(0),
    reminderEmailsSent: integer("reminder_emails_sent").notNull().default(0),
    reminderEmailsSuppressed: integer("reminder_emails_suppressed").notNull().default(0),
    followupsSent: integer("followups_sent").notNull().default(0),
    averageBookingLeadHours: integer("average_booking_lead_hours"),
    /** jsonb side-channel — keys defined by aggregation modules. */
    extras: jsonb("extras").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("analytics_daily_snapshots_tenant_idx").on(t.tenantId),
    dateIdx: index("analytics_daily_snapshots_date_idx").on(t.snapshotDate),
    unique: uniqueIndex("analytics_daily_snapshots_unique").on(t.tenantId, t.snapshotDate),
  })
);

// ─── Recurring bookings (series + occurrences) ─────────────────────────
// One series per recurring appointment. The materialization worker
// rolls a 30-day window forward, generating occurrence rows and
// inserting real bookings (via the existing booking validation chain).
// Tenants without any active series see byte-identical behavior.
//
// overrides jsonb on booking_occurrences carries per-occurrence
// deviations (different start_at / staff_user_id / skip flag) so
// "edit this occurrence only" doesn't have to mutate the series rule.
export const bookingSeries = pgTable(
  "booking_series",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    staffUserId: uuid("staff_user_id").references(() => users.id, { onDelete: "set null" }),
    locationId: uuid("location_id"),
    customerId: uuid("customer_id"),
    customerEmail: varchar("customer_email", { length: 255 }).notNull(),
    customerName: varchar("customer_name", { length: 120 }).notNull(),
    recurrenceRule: text("recurrence_rule").notNull(),
    startLocal: varchar("start_local", { length: 19 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    endDate: date("end_date"),
    occurrenceCount: integer("occurrence_count"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    lastMaterializedIndex: integer("last_materialized_index").notNull().default(-1),
    notes: text("notes"),
    // Phase 5 — downgrade enforcement orchestrator. enforcement_paused_at
    // is the canonical "paused by orchestrator" marker. Cleared on
    // reactivation. Independent of the user-set `status` column —
    // user-pause and enforcement-pause are two separate axes.
    enforcementPausedAt: timestamp("enforcement_paused_at", { withTimezone: true }),
    enforcementPausedReason: varchar("enforcement_paused_reason", { length: 60 }),
    enforcementEventId: varchar("enforcement_event_id", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("booking_series_tenant_idx").on(t.tenantId),
    statusIdx: index("booking_series_status_idx").on(t.status),
    enforcementEventIdx: index("booking_series_enforcement_event_idx").on(t.enforcementEventId),
  })
);

// ─── Tenant enforcement overrides ───────────────────────────────────────
// Operator-controlled per-(tenant, capability) policy override (Phase 5).
// Default policy resolution lives in lib/billing/enforcement/policies.ts;
// rows here override the default for a specific tenant + capability.
// `expires_at` supports time-bounded grace periods (set on
// support/sales escalations); NULL = no expiry.
export const tenantEnforcementOverrides = pgTable(
  "tenant_enforcement_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    capability: varchar("capability", { length: 60 }).notNull(),
    mode: varchar("mode", { length: 20 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantedBy: varchar("granted_by", { length: 120 }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("tenant_enforcement_overrides_unique").on(t.tenantId, t.capability),
    tenantIdx: index("tenant_enforcement_overrides_tenant_idx").on(t.tenantId),
  })
);

export const bookingOccurrences = pgTable(
  "booking_occurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bookingSeriesId: uuid("booking_series_id")
      .notNull()
      .references(() => bookingSeries.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id"),
    occurrenceIndex: integer("occurrence_index").notNull(),
    occurrenceStartAt: timestamp("occurrence_start_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("scheduled"),
    overrides: jsonb("overrides").notNull().default({}),
    failureReason: text("failure_reason"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seriesIdx: index("booking_occurrences_series_idx").on(t.bookingSeriesId),
    tenantIdx: index("booking_occurrences_tenant_idx").on(t.tenantId),
    statusIdx: index("booking_occurrences_status_idx").on(t.status),
    startIdx: index("booking_occurrences_start_idx").on(t.occurrenceStartAt),
  })
);

// ─── Waitlists + waitlist_notifications ─────────────────────────────────
// One waitlist row per (tenant, service, customer email) at a time —
// the active-customer unique index gates re-joins. Status transitions:
// waiting → notified → claimed | expired | cancelled.
//
// waitlist_notifications: every promotion attempt + reservation hold.
// The partial unique index on (waitlist_id) WHERE status='sent' makes
// it impossible to have two outstanding offers for the same customer.
//
// Tenants who never accept a waitlist join see byte-identical booking
// behavior — the trigger orchestrators in cancel/reschedule wrap
// every call in try/catch and no-op when no candidates match.
export const waitlists = pgTable(
  "waitlists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    locationId: uuid("location_id"),
    customerEmail: varchar("customer_email", { length: 255 }).notNull(),
    customerName: varchar("customer_name", { length: 120 }).notNull(),
    customerPhone: varchar("customer_phone", { length: 40 }),
    preferredDate: varchar("preferred_date", { length: 10 }),
    preferredTimeRange: varchar("preferred_time_range", { length: 16 }).notNull().default("any"),
    status: varchar("status", { length: 20 }).notNull().default("waiting"),
    priority: integer("priority").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBookingId: uuid("claimed_booking_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("waitlists_tenant_idx").on(t.tenantId),
    serviceIdx: index("waitlists_service_idx").on(t.serviceId),
    statusIdx: index("waitlists_status_idx").on(t.status),
  })
);

export const waitlistNotifications = pgTable(
  "waitlist_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    waitlistId: uuid("waitlist_id")
      .notNull()
      .references(() => waitlists.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id"),
    notificationType: varchar("notification_type", { length: 30 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("sent"),
    staffUserId: uuid("staff_user_id"),
    slotStartAt: timestamp("slot_start_at", { withTimezone: true }),
    slotEndAt: timestamp("slot_end_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("waitlist_notifications_tenant_idx").on(t.tenantId, t.createdAt),
    waitlistIdx: index("waitlist_notifications_waitlist_idx").on(t.waitlistId),
  })
);

// ─── Review-request rules + follow-up automations + pending queue ──────
// review_request_rules: per-(tenant, service) configuration for the
// post-completion review-request automation. Without a row, no review
// request fires — preserves byte-identical pre-feature behavior.
// followup_automation_rules: generic "send a custom template N minutes
// after event X for this service" rule. Conditions are evaluated at
// queue-drain time, not enqueue time.
// pending_automations: cron-scanned queue for delayed sends.
//
// Idempotency for actual delivery is at communication_logs (existing
// partial unique index). The queue's status field is lifecycle only.
export const reviewRequestRules = pgTable(
  "review_request_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    delayMinutes: integer("delay_minutes").notNull().default(60),
    reviewPlatform: varchar("review_platform", { length: 20 }).notNull().default("google"),
    reviewUrl: text("review_url"),
    suppressIfCancelled: boolean("suppress_if_cancelled").notNull().default(true),
    suppressIfNoShow: boolean("suppress_if_no_show").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("review_request_rules_tenant_idx").on(t.tenantId),
    serviceIdx: index("review_request_rules_service_idx").on(t.serviceId),
  })
);

export const followupAutomationRules = pgTable(
  "followup_automation_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    triggerEvent: varchar("trigger_event", { length: 60 }).notNull(),
    delayMinutes: integer("delay_minutes").notNull().default(0),
    templateId: uuid("template_id").references(() => communicationTemplates.id, {
      onDelete: "set null",
    }),
    onlyFirstTimeCustomers: boolean("only_first_time_customers").notNull().default(false),
    onlyCompletedBookings: boolean("only_completed_bookings").notNull().default(false),
    requireSuccessfulPayment: boolean("require_successful_payment").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("followup_automation_rules_tenant_idx").on(t.tenantId),
    serviceIdx: index("followup_automation_rules_service_idx").on(t.serviceId),
    eventIdx: index("followup_automation_rules_event_idx").on(t.tenantId, t.triggerEvent),
  })
);

export const pendingAutomations = pgTable(
  "pending_automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id").notNull(),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    ruleKind: varchar("rule_kind", { length: 20 }).notNull(),
    ruleId: uuid("rule_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    reason: varchar("reason", { length: 60 }),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("pending_automations_tenant_idx").on(t.tenantId),
    bookingIdx: index("pending_automations_booking_idx").on(t.bookingId),
  })
);

// ─── Booking rules (notice / advance / caps / cooldown / blackouts) ────
// One rule per scope bucket: service > location > tenant default.
// Tenants without a row continue to use the legacy fields on `services`
// (minNoticeMinutes, maxAdvanceDays) — byte-identical pre-feature
// behavior. When a rule exists, its notice/advance override the legacy
// fields. Other rule fields (caps, cooldown, blackouts, business hours)
// are new — no legacy equivalent.
export const bookingRules = pgTable(
  "booking_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    locationId: uuid("location_id"),
    enabled: boolean("enabled").notNull().default(true),
    minNoticeMinutes: integer("min_notice_minutes"),
    maxAdvanceDays: integer("max_advance_days"),
    maxBookingsPerDay: integer("max_bookings_per_day"),
    maxBookingsPerCustomerPerDay: integer("max_bookings_per_customer_per_day"),
    maxConcurrentBookings: integer("max_concurrent_bookings"),
    cooldownMinutes: integer("cooldown_minutes"),
    /** jsonb string[] of "YYYY-MM-DD" dates (tenant TZ). */
    blackoutDates: jsonb("blackout_dates").notNull().default([]),
    requireBusinessHours: boolean("require_business_hours").notNull().default(false),
    /** {0..6: {start: "HH:MM", end: "HH:MM"}} or {} */
    businessHours: jsonb("business_hours").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("booking_rules_tenant_idx").on(t.tenantId),
    serviceIdx: index("booking_rules_service_idx").on(t.serviceId),
    locationIdx: index("booking_rules_location_idx").on(t.locationId),
  })
);

// ─── Staff routing rules + assignment stats ─────────────────────────────
// One rule per scope: service-specific > location-specific > tenant default.
// Mode is varchar so adding a mode is a one-line addition to the
// lib/routing types union (no migration). priorityOrder is jsonb array of
// staff ids; weightedDistribution is jsonb object {staffId: percent}.
// Tenants without any rule fall through to the legacy pickRoundRobinStaff
// path in /api/bookings POST — preserves byte-identical behavior.
export const staffAssignmentRules = pgTable(
  "staff_assignment_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    // Location-pinned pool scope. The staff_location pivot now
    // exists (migration 0037) and is the canonical source of per-
    // staff presence; the routing-presence filter (future) will
    // consume it ABOVE slot generation. This column stays as the
    // pool-level location pin — NULL = scope ignores location.
    locationId: uuid("location_id"),
    mode: varchar("mode", { length: 20 }).notNull().default("manual"),
    enabled: boolean("enabled").notNull().default(true),
    priorityOrder: jsonb("priority_order").notNull().default([]),
    weightedDistribution: jsonb("weighted_distribution").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("staff_assignment_rules_tenant_idx").on(t.tenantId),
    serviceIdx: index("staff_assignment_rules_service_idx").on(t.serviceId),
    locationIdx: index("staff_assignment_rules_location_idx").on(t.locationId),
  })
);

// Rolling assignment counts. day/week windows reset lazily on next
// write (no cron required) — recorder compares the window anchor to
// the current day-of-year / iso-week and zeros if rolled over.
export const staffAssignmentStats = pgTable(
  "staff_assignment_stats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    totalAssignments: integer("total_assignments").notNull().default(0),
    lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
    assignmentsToday: integer("assignments_today").notNull().default(0),
    assignmentsThisWeek: integer("assignments_this_week").notNull().default(0),
    dayWindowStart: timestamp("day_window_start", { withTimezone: true }),
    weekWindowStart: timestamp("week_window_start", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    staffUnique: uniqueIndex("staff_assignment_stats_staff_unique").on(t.tenantId, t.staffId),
    tenantIdx: index("staff_assignment_stats_tenant_idx").on(t.tenantId),
  })
);

// ─── Tenant SMS provider connections ────────────────────────────────────
// One active provider per tenant. Secrets are AES-256-GCM encrypted —
// never store or return plaintext. See lib/crypto.ts for envelope shape.
export const tenantSmsProviders = pgTable(
  "tenant_sms_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // 'twilio' | 'telnyx'
    provider: varchar("provider", { length: 20 }).notNull(),
    accountId: varchar("account_id", { length: 120 }),
    authTokenEncrypted: text("auth_token_encrypted").notNull(),
    senderId: varchar("sender_id", { length: 40 }).notNull(),
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
    active: boolean("active").notNull().default(true),
    totalSent: integer("total_sent").notNull().default(0),
    totalFailed: integer("total_failed").notNull().default(0),
    lastSendAt: timestamp("last_send_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantUnique: uniqueIndex("tenant_sms_providers_tenant_unique").on(t.tenantId),
    activeIdx: index("tenant_sms_providers_active_idx").on(t.active),
  })
);

// ─── Plans (super-admin managed pricing catalog) ────────────────────────
// Edited via /admin/plans. Tenants link to a plan by slug through
// `tenants.current_plan` — no FK so legacy slugs don't break upgrades.
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 40 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    priceMonthlyCents: integer("price_monthly_cents").notNull().default(0),
    priceYearlyCents: integer("price_yearly_cents").notNull().default(0),
    stripePriceIdMonthly: varchar("stripe_price_id_monthly", { length: 120 }),
    stripePriceIdYearly: varchar("stripe_price_id_yearly", { length: 120 }),
    quotaStaff: integer("quota_staff").notNull().default(1),
    quotaManagers: integer("quota_managers").notNull().default(0),
    quotaBookingsPerMonth: integer("quota_bookings_per_month").notNull().default(100),
    quotaServices: integer("quota_services").notNull().default(5),
    features: jsonb("features").notNull().default([]),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUnique: uniqueIndex("plans_slug_unique").on(t.slug),
    activeIdx: index("plans_active_idx").on(t.active),
    sortIdx: index("plans_sort_idx").on(t.sortOrder),
  })
);

// ─── Promotions / coupons (super-admin managed) ─────────────────────────
export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 40 }).notNull(),
    description: text("description"),
    // 'percent' | 'fixed' | 'trial_extension'
    kind: varchar("kind", { length: 20 }).notNull(),
    percentOff: smallint("percent_off"),
    amountOffCents: integer("amount_off_cents"),
    trialExtensionDays: smallint("trial_extension_days"),
    appliesToPlan: varchar("applies_to_plan", { length: 40 }),
    maxRedemptions: integer("max_redemptions"),
    redemptionCount: integer("redemption_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex("promotions_code_unique").on(t.code),
    activeIdx: index("promotions_active_idx").on(t.active),
    expiresIdx: index("promotions_expires_idx").on(t.expiresAt),
  })
);

// ─── Announcements (platform-wide notices) ──────────────────────────────
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    // 'info' | 'warning' | 'critical'
    severity: varchar("severity", { length: 20 }).notNull().default("info"),
    // 'all' | plan slug
    audience: varchar("audience", { length: 40 }).notNull().default("all"),
    linkUrl: text("link_url"),
    linkLabel: varchar("link_label", { length: 80 }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index("announcements_active_idx").on(t.active),
    audienceIdx: index("announcements_audience_idx").on(t.audience),
    publishedIdx: index("announcements_published_idx").on(t.publishedAt),
  })
);

// ─── Security hardening tables (0028) ───────────────────────────────────

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** bcrypt hash of the raw token. Raw token only ever leaves the
     *  process inside the outbound email. NEVER stored in the clear. */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set on first (and only) successful consume. Replay protection. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestedIp: varchar("requested_ip", { length: 45 }),
    consumedIp: varchar("consumed_ip", { length: 45 }),
    consumedUserAgent: text("consumed_user_agent"),
  },
  (t) => ({
    userIdx: index("prt_user_idx").on(t.userId),
    tenantIdx: index("prt_tenant_idx").on(t.tenantId),
    expiresIdx: index("prt_expires_idx").on(t.expiresAt),
  })
);

export const sessionAuditEvents = pgTable(
  "session_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Nullable for failed-login events on unknown emails. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Closed enum maintained in lib/security/sessionEvents.ts. */
    eventType: varchar("event_type", { length: 40 }).notNull(),
    sessionJti: varchar("session_jti", { length: 64 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    deviceLabel: varchar("device_label", { length: 120 }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("sae_user_idx").on(t.userId),
    tenantIdx: index("sae_tenant_idx").on(t.tenantId),
    eventIdx: index("sae_event_idx").on(t.eventType),
    createdIdx: index("sae_created_idx").on(t.createdAt),
    tenantCreatedIdx: index("sae_tenant_created_idx").on(t.tenantId, t.createdAt),
  })
);

export const revokedSessionJtis = pgTable(
  "revoked_session_jtis",
  {
    jti: varchar("jti", { length: 64 }).primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
    /** Original token expiry — once past, cron can prune. */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    reason: varchar("reason", { length: 40 }),
  },
  (t) => ({
    userIdx: index("revoked_user_idx").on(t.userId),
    expiresIdx: index("revoked_expires_idx").on(t.tokenExpiresAt),
  })
);

// ─── Governance tables (0029) ───────────────────────────────────────────

export const tenantGovernanceSettings = pgTable(
  "tenant_governance_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Retention windows. NULL = retain forever (no automatic pruning). */
    auditRetentionDays: integer("audit_retention_days"),
    sessionEventRetentionDays: integer("session_event_retention_days"),
    resetTokenRetentionDays: integer("reset_token_retention_days"),
    analyticsRetentionDays: integer("analytics_retention_days"),
    exportAuditRetentionDays: integer("export_audit_retention_days"),

    passwordMinLength: integer("password_min_length").notNull().default(10),
    passwordRequireUppercase: boolean("password_require_uppercase").notNull().default(false),
    passwordRequireLowercase: boolean("password_require_lowercase").notNull().default(false),
    passwordRequireDigit: boolean("password_require_digit").notNull().default(false),
    passwordRequireSymbol: boolean("password_require_symbol").notNull().default(false),
    passwordMaxAgeDays: integer("password_max_age_days").notNull().default(0),

    sessionMaxAgeDays: integer("session_max_age_days").notNull().default(0),
    suspiciousLoginSensitivity: varchar("suspicious_login_sensitivity", { length: 10 })
      .notNull()
      .default("medium"),

    allowedLoginIps: jsonb("allowed_login_ips"),

    restrictExports: boolean("restrict_exports").notNull().default(false),
    maxExportRows: integer("max_export_rows"),

    requireAutomationApproval: boolean("require_automation_approval").notNull().default(false),

    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedIdx: index("tgs_updated_idx").on(t.updatedAt),
  })
);

export const exportAuditEvents = pgTable(
  "export_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    exportType: varchar("export_type", { length: 40 }).notNull(),
    exportedAt: timestamp("exported_at", { withTimezone: true }).notNull().defaultNow(),
    recordCount: integer("record_count"),
    fileSizeBytes: integer("file_size_bytes"),
    filtersUsed: jsonb("filters_used").notNull().default({}),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
  },
  (t) => ({
    tenantIdx: index("eae_tenant_idx").on(t.tenantId),
    userIdx: index("eae_user_idx").on(t.userId),
    typeIdx: index("eae_type_idx").on(t.exportType),
    exportedIdx: index("eae_exported_idx").on(t.exportedAt),
    tenantTimeIdx: index("eae_tenant_time_idx").on(t.tenantId, t.exportedAt),
  })
);

// ─── SA-10 — Admin analytics snapshot tables ────────────────────────────
// Migration 0063. Pre-computed cross-tenant rollups so the super-admin
// dashboard never has to re-scan source tables on every page load.
// Populated by scripts/aggregate-admin-snapshots.ts.

export const analyticsSnapshotsDaily = pgTable(
  "analytics_snapshots_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotDate: date("snapshot_date").notNull(),
    totalTenants: integer("total_tenants").notNull().default(0),
    activeTenants: integer("active_tenants").notNull().default(0),
    payingTenants: integer("paying_tenants").notNull().default(0),
    newTenants: integer("new_tenants").notNull().default(0),
    churnedTenants: integer("churned_tenants").notNull().default(0),
    totalBookings: integer("total_bookings").notNull().default(0),
    bookingsCompleted: integer("bookings_completed").notNull().default(0),
    bookingsNoShow: integer("bookings_no_show").notNull().default(0),
    totalUsers: integer("total_users").notNull().default(0),
    newUsers: integer("new_users").notNull().default(0),
    activeUsersDau: integer("active_users_dau").notNull().default(0),
    mrrCents: bigint("mrr_cents", { mode: "number" }).notNull().default(0),
    arrCents: bigint("arr_cents", { mode: "number" }).notNull().default(0),
    grossRevenueCents: bigint("gross_revenue_cents", { mode: "number" }).notNull().default(0),
    refundsCents: bigint("refunds_cents", { mode: "number" }).notNull().default(0),
    failedCharges: integer("failed_charges").notNull().default(0),
    emailsSent: integer("emails_sent").notNull().default(0),
    emailsFailed: integer("emails_failed").notNull().default(0),
    smsSent: integer("sms_sent").notNull().default(0),
    failedLogins: integer("failed_logins").notNull().default(0),
    adminActions: integer("admin_actions").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dateUnique: uniqueIndex("analytics_snapshots_daily_date_unique").on(t.snapshotDate),
  }),
);

export const analyticsSnapshotsHourly = pgTable(
  "analytics_snapshots_hourly",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotHour: timestamp("snapshot_hour", { withTimezone: true }).notNull(),
    bookings: integer("bookings").notNull().default(0),
    signups: integer("signups").notNull().default(0),
    logins: integer("logins").notNull().default(0),
    failedLogins: integer("failed_logins").notNull().default(0),
    emailsSent: integer("emails_sent").notNull().default(0),
    emailsFailed: integer("emails_failed").notNull().default(0),
    webhookEvents: integer("webhook_events").notNull().default(0),
    webhookFailures: integer("webhook_failures").notNull().default(0),
    errorsTotal: integer("errors_total").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hourUnique: uniqueIndex("analytics_snapshots_hourly_hour_unique").on(t.snapshotHour),
  }),
);

export const tenantHealthSnapshots = pgTable(
  "tenant_health_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date").notNull(),
    healthScore: integer("health_score").notNull(),
    riskLevel: varchar("risk_level", { length: 20 }).notNull(),
    mrrCents: bigint("mrr_cents", { mode: "number" }).notNull().default(0),
    bookings30d: integer("bookings_30d").notNull().default(0),
    bookingsGrowthPct: decimal("bookings_growth_pct", { precision: 8, scale: 2 }),
    failedLogins7d: integer("failed_logins_7d").notNull().default(0),
    failedCharges30d: integer("failed_charges_30d").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    notes: jsonb("notes").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantDateUnique: uniqueIndex("tenant_health_snapshots_tenant_date_unique").on(
      t.tenantId,
      t.snapshotDate,
    ),
    riskIdx: index("tenant_health_snapshots_risk_idx").on(t.riskLevel, t.snapshotDate),
  }),
);

// ─── Stabilization Wave — cron_runs (migration 0064) ────────────────────
// Per-tick observability for every cron worker. Driven by the
// `withCronRun()` wrapper in lib/cronObservability.ts.

export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobName: varchar("job_name", { length: 80 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    detail: jsonb("detail").notNull().default({}),
    host: varchar("host", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobStartedIdx: index("cron_runs_job_started_idx").on(t.jobName, t.startedAt),
    statusStartedIdx: index("cron_runs_status_started_idx").on(t.status, t.startedAt),
  }),
);

export const financialSnapshots = pgTable(
  "financial_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotDate: date("snapshot_date").notNull(),
    plan: varchar("plan", { length: 40 }).notNull(),
    activeSubscriptions: integer("active_subscriptions").notNull().default(0),
    newSubscriptions: integer("new_subscriptions").notNull().default(0),
    cancelledSubscriptions: integer("cancelled_subscriptions").notNull().default(0),
    mrrCents: bigint("mrr_cents", { mode: "number" }).notNull().default(0),
    grossRevenueCents: bigint("gross_revenue_cents", { mode: "number" }).notNull().default(0),
    refundsCents: bigint("refunds_cents", { mode: "number" }).notNull().default(0),
    netRevenueCents: bigint("net_revenue_cents", { mode: "number" }).notNull().default(0),
    failedCharges: integer("failed_charges").notNull().default(0),
    dunningActive: integer("dunning_active").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    datePlanUnique: uniqueIndex("financial_snapshots_date_plan_unique").on(t.snapshotDate, t.plan),
  }),
);

// ─── Types ──────────────────────────────────────────────────────────────

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type Availability = typeof availability.$inferSelect;
export type NewAvailability = typeof availability.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
// Phase 17H+ — calendar_events sibling table for blocked_time + internal_meeting
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;
export type GroupSession = typeof groupSessions.$inferSelect;
export type NewGroupSession = typeof groupSessions.$inferInsert;
export type AvailabilityOverride = typeof availabilityOverrides.$inferSelect;
export type NewAvailabilityOverride = typeof availabilityOverrides.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type IntakeForm = typeof intakeForms.$inferSelect;
export type NewIntakeForm = typeof intakeForms.$inferInsert;
// Wave I
export type IntakeFieldResponse = typeof intakeFieldResponses.$inferSelect;
export type NewIntakeFieldResponse = typeof intakeFieldResponses.$inferInsert;
export type TenantDomain = typeof tenantDomains.$inferSelect;
export type NewTenantDomain = typeof tenantDomains.$inferInsert;
export type EmbedEvent = typeof embedEvents.$inferSelect;
export type NewEmbedEvent = typeof embedEvents.$inferInsert;
export type TenantSmsProvider = typeof tenantSmsProviders.$inferSelect;
export type NewTenantSmsProvider = typeof tenantSmsProviders.$inferInsert;
export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;
export type Announcement = typeof announcements.$inferSelect;
export type NewAnnouncement = typeof announcements.$inferInsert;
export type Role = (typeof roleEnum.enumValues)[number];
export type BookingStatus = (typeof bookingStatusEnum.enumValues)[number];
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type SessionAuditEvent = typeof sessionAuditEvents.$inferSelect;
export type NewSessionAuditEvent = typeof sessionAuditEvents.$inferInsert;
export type RevokedSessionJti = typeof revokedSessionJtis.$inferSelect;
export type NewRevokedSessionJti = typeof revokedSessionJtis.$inferInsert;
export type TenantGovernanceSettings = typeof tenantGovernanceSettings.$inferSelect;
export type NewTenantGovernanceSettings = typeof tenantGovernanceSettings.$inferInsert;
export type ExportAuditEvent = typeof exportAuditEvents.$inferSelect;
export type NewExportAuditEvent = typeof exportAuditEvents.$inferInsert;
// Wave H — tenant payment provider vault (migration 0050)
export type TenantPaymentProvider = typeof tenantPaymentProviders.$inferSelect;
export type NewTenantPaymentProvider = typeof tenantPaymentProviders.$inferInsert;
export type TenantPaymentWebhookEvent = typeof tenantPaymentWebhookEvents.$inferSelect;
export type NewTenantPaymentWebhookEvent = typeof tenantPaymentWebhookEvents.$inferInsert;
