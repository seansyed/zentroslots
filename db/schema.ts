import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  time,
  date,
  smallint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
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

    // Onboarding
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),

    // Outbound webhook for operational alerts (Slack-compatible)
    notificationWebhookUrl: text("notification_webhook_url"),
    // Plan-gated: when true and plan allows, embed footer hides "Powered by"
    hidePoweredBy: boolean("hide_powered_by").notNull().default(false),

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

    primaryLocationId: uuid("primary_location_id"),
    departmentId: uuid("department_id"),

    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    specialties: text("specialties"),

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

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("services_tenant_idx").on(t.tenantId),
    tenantSlugUnique: uniqueIndex("services_tenant_slug_unique").on(t.tenantId, t.slug),
    activeIdx: index("services_active_idx").on(t.isActive),
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
    meetLink: text("meet_link"),
    notes: text("notes"),

    locationId: uuid("location_id"),
    departmentId: uuid("department_id"),
    customerId: uuid("customer_id"),

    intakeResponses: jsonb("intake_responses"),
    assignmentMode: varchar("assignment_mode", { length: 20 }).notNull().default("direct"),

    reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
    reminder1hSentAt: timestamp("reminder_1h_sent_at", { withTimezone: true }),

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

// ─── Relations ──────────────────────────────────────────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  services: many(services),
  bookings: many(bookings),
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
}));

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("intake_forms_tenant_idx").on(t.tenantId),
  })
);

export const intakeFormsRelations = relations(intakeForms, ({ one }) => ({
  tenant: one(tenants, { fields: [intakeForms.tenantId], references: [tenants.id] }),
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
    verificationToken: varchar("verification_token", { length: 64 }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("tenant_domains_tenant_idx").on(t.tenantId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("calendar_connections_tenant_idx").on(t.tenantId),
    statusIdx: index("calendar_connections_status_idx").on(t.status),
  })
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("calendar_sync_logs_tenant_idx").on(t.tenantId, t.createdAt),
    connectionIdx: index("calendar_sync_logs_connection_idx").on(t.connectionId, t.createdAt),
    bookingIdx: index("calendar_sync_logs_booking_idx").on(t.bookingId),
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
