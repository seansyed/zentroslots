/**
 * Canonical event / column taxonomy for super-admin analytics.
 *
 * This file is the SINGLE source of truth for:
 *   • column names on tables we query repeatedly (billing_transactions,
 *     audit_logs, communication_logs, bookings, calendar_*).
 *   • enum values on those columns (status, transaction_type, ...).
 *   • action-string prefixes we filter audit_logs by.
 *
 * Why a separate file:
 *   The error "column event_type does not exist" on
 *   billing_transactions happened because a query in kpis.ts encoded
 *   a column name that wasn't actually present on that table. Other
 *   modules (intelligence.ts, tenant-intelligence.ts, anomalies.ts)
 *   queried the SAME table correctly using `status='failed'`. The
 *   string "event_type" was duplicated across modules with no shared
 *   definition — different copies drifted independently.
 *
 *   Centralizing the strings here means:
 *     1. TypeScript catches typos at the call site.
 *     2. Schema changes touch exactly one file.
 *     3. Audit_log action filters across modules stay aligned.
 *
 * Rules:
 *   • This file imports NOTHING from db/* — it's a pure constants
 *     module and can be loaded everywhere.
 *   • Every constant has a comment naming the source-of-truth (the
 *     migration that established the column or value).
 *   • Adding a new value requires updating the comment with the
 *     migration number.
 */

// ─── billing_transactions ──────────────────────────────────────────
// Schema: migrations 0026 (created), 0030 (additions).
// Drizzle: db/schema.ts:1672 (billingTransactions).

export const BILLING_TRANSACTIONS = {
  /** The column carrying the operational status. NOT event_type. */
  STATUS_COL: "status" as const,
  /** Column carrying the kind of transaction (booking payment vs subscription, etc). */
  TYPE_COL: "transaction_type" as const,
} as const;

/** Closed enum of billing_transactions.status values. */
export const BILLING_STATUS = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  REFUNDED: "refunded",
} as const;
export type BillingStatus = (typeof BILLING_STATUS)[keyof typeof BILLING_STATUS];

/** Closed enum of billing_transactions.transaction_type values. */
export const BILLING_TRANSACTION_TYPE = {
  BOOKING_PAYMENT: "booking_payment",
  SUBSCRIPTION_PAYMENT: "subscription_payment",
  INVOICE_PAYMENT: "invoice_payment",
  REFUND: "refund",
} as const;
export type BillingTransactionType =
  (typeof BILLING_TRANSACTION_TYPE)[keyof typeof BILLING_TRANSACTION_TYPE];

// ─── audit_logs.action prefixes ────────────────────────────────────
// We filter by LIKE patterns; centralize the patterns so SA-5/SA-7/
// SA-8 modules all reference the same set.

export const AUDIT_ACTION_PATTERN = {
  /** Auth events: success/failure/lockout. */
  AUTH_SUCCESS: "security.authentication.success%",
  AUTH_FAILED: "security.authentication.failed%",
  AUTH_LOCKOUT: "security.authentication.lockout%",

  /** Permission/role mutations. */
  PERMISSION_GRANT: "security.permission%",
  ROLE_CHANGE: "role%",

  /** Admin-only actions: bulk operations, manual overrides. */
  ADMIN_ANY: "admin.%",
  ADMIN_BULK: "admin.bulk.%",
  ADMIN_FINANCE: "admin.finance.%",
  ADMIN_OVERRIDE: "admin.override%",

  /** Impersonation — never wraps to a fixed prefix because legacy
   *  rows use different conventions. Match case-insensitively. */
  IMPERSONATION: "%impersonat%",

  /** Tenant lifecycle (suspended/reactivated). */
  TENANT_SUSPENDED: "tenant.suspended%",
  TENANT_REACTIVATED: "tenant.reactivated%",

  /** Subscription / billing events. */
  SUBSCRIPTION_CANCEL: "%subscription.cancel%",
  SUBSCRIPTION_CREATED: "%subscription.created%",
  BILLING_DOWNGRADE: "billing.downgrade%",
  BILLING_REFUND: "billing.refund%",

  /** Webhook / cron / worker failure classes. */
  WEBHOOK_ANY: "%webhook%",
  WEBHOOK_FAIL: "%webhook%fail%",
  WORKER_CRASH: "worker.crash%",
  CRON_FAIL: "%cron.fail%",
  FATAL_EXCEPTION: "%fatal_exception%",
  STRIPE_WEBHOOK_ERROR: "stripe_webhook_error",

  /** Rate-limiting + 429s. */
  RATE_LIMIT: "%rate_limit%",
  HTTP_429: "%429%",

  /** OAuth + token refresh. */
  OAUTH_FAIL: "%oauth%fail%",
  GOOGLE_FAIL: "google%fail%",
  MICROSOFT_FAIL: "microsoft%fail%",

  /** Suspicious-activity heuristics. */
  SUSPICIOUS: "security.suspicious%",
} as const;

// ─── communication_logs ────────────────────────────────────────────
// Schema: migrations 0017 / 0017 hardening.
// Drizzle: db/schema.ts:1377 — column is `event_type` (snake_case
// in the DB; eventType camelCase on the JS side).

export const COMMUNICATION_LOGS = {
  /** Yes — this table DOES have event_type. Don't confuse with
   *  billing_transactions which does not. */
  EVENT_TYPE_COL: "event_type" as const,
  STATUS_COL: "status" as const,
  CHANNEL_COL: "channel" as const,
} as const;

export const COMMUNICATION_STATUS = {
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped",
  BOUNCED: "bounced",
} as const;
export type CommunicationStatus =
  (typeof COMMUNICATION_STATUS)[keyof typeof COMMUNICATION_STATUS];

export const COMMUNICATION_EVENT_PATTERN = {
  APPOINTMENT_REMINDER: "appointment.reminder%",
  APPOINTMENT_CONFIRMATION: "appointment.confirmation%",
  PASSWORD_RESET: "password_reset%",
  WAITLIST_NOTIFICATION: "waitlist%",
  AUTOMATION: "automation.%",
} as const;

// ─── bookings status ──────────────────────────────────────────────
// Schema: migrations 0001 + 0030 (paid lifecycle extensions).
// Drizzle: db/schema.ts:25 — bookingStatusEnum.

export const BOOKING_STATUS = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  NO_SHOW: "no_show",
  PENDING_PAYMENT: "pending_payment",
  PAYMENT_FAILED: "payment_failed",
  REFUNDED: "refunded",
} as const;
export type BookingStatus = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

// ─── tenants.subscription_status (Stripe mirror) ──────────────────

export const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  TRIALING: "trialing",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
} as const;
export type SubscriptionStatus =
  (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

/** Active billing states — used by all "is paying customer" checks. */
export const SUBSCRIPTION_ACTIVE_STATES: readonly SubscriptionStatus[] = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.TRIALING,
  SUBSCRIPTION_STATUS.PAST_DUE,
] as const;

/** Terminal / billing-suspended states. */
export const SUBSCRIPTION_SUSPENDED_STATES: readonly SubscriptionStatus[] = [
  SUBSCRIPTION_STATUS.CANCELED,
  SUBSCRIPTION_STATUS.UNPAID,
  SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
] as const;

// ─── calendar_connections.status ──────────────────────────────────

export const CALENDAR_CONNECTION_STATUS = {
  VERIFIED: "verified",
  NEEDS_RECONNECT: "needs_reconnect",
  EXPIRED: "expired",
  ERROR: "error",
} as const;

// ─── tenant_payment_providers.status ──────────────────────────────

export const PAYMENT_PROVIDER_STATUS = {
  VERIFIED: "verified",
  PENDING: "pending",
  INVALID: "invalid",
  DISCONNECTED: "disconnected",
} as const;

export const PAYMENT_WEBHOOK_STATUS = {
  HEALTHY: "healthy",
  FAILING: "failing",
  UNKNOWN: "unknown",
} as const;

// ─── Helper builders ───────────────────────────────────────────────

/** Concatenate audit-action patterns into an OR-list for SQL.
 *  Returns a string like "action LIKE 'admin.%' OR action LIKE 'security.permission%'". */
export function actionLikeOr(patterns: readonly string[], column = "action"): string {
  return patterns
    .map((p) => `${column} LIKE '${p.replace(/'/g, "''")}'`)
    .join(" OR ");
}
