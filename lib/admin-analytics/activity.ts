/**
 * SA-3 §D + SA-5 — Cross-tenant live operational event stream.
 *
 * Reads from `audit_logs` and applies a closed-enum classifier so the
 * UI only ever renders kinds it knows how to label. Unknown audit
 * rows are silently dropped to keep the feed signal-dense.
 *
 * SA-5 additions over the original SA-3 stub:
 *   • Expanded kind enum (24 vs 12)
 *   • Tenant id filter
 *   • Time range filter (since / until)
 *   • Full-text summary search
 *   • Metadata pass-through (UI uses it in the drawer)
 *   • Group keys for the UI's "collapse consecutive events" feature
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

export type ActivitySeverity = "info" | "warning" | "critical";

export type ActivityEvent = {
  id: string;
  ts: string;
  severity: ActivitySeverity;
  kind: string;
  summary: string;
  /** Tenant context — UI deep-links to /admin/tenants/[id]. */
  tenantId: string | null;
  /** Display label for the actor (user email when available). */
  actorLabel: string | null;
  /** Entity type/id pair from the audit row, for the drawer. */
  entityType: string | null;
  entityId: string | null;
  /** IP address, when available. UI shows it inside the metadata drawer. */
  ipAddress: string | null;
  /** Raw audit action string for power-user drilldown. */
  action: string;
  /** Full metadata jsonb passthrough for the drawer. */
  metadata: Record<string, unknown> | null;
  /** Group key — the UI collapses adjacent rows that share a key
   *  (e.g. 10 reminder failures in 30s become a "stacked" event).
   *  Keyed by `${kind}:${tenantId}` so different tenants stay split. */
  groupKey: string;
};

export type ActivityPage = {
  events: ActivityEvent[];
  /** ISO timestamp of the oldest event in this page; pass back as
   *  `?cursor=...` to fetch the next page. Null = end of stream. */
  nextCursor: string | null;
};

// ─── Closed enum of kinds shipped to the UI ────────────────────────

export const ACTIVITY_KIND_LABELS: Record<string, string> = {
  new_signup: "New signup",
  subscription_created: "Subscription created",
  subscription_upgraded: "Subscription upgraded",
  subscription_downgraded: "Subscription downgraded",
  subscription_cancelled: "Subscription cancelled",
  payment_failed: "Payment failed",
  invoice_paid: "Invoice paid",
  webhook_failed: "Webhook failed",
  webhook_recovered: "Webhook recovered",
  oauth_connected: "OAuth connected",
  oauth_failed: "OAuth failure",
  oauth_token_expired: "OAuth token expired",
  calendar_sync_failed: "Calendar sync failed",
  reminder_failed: "Reminder failed",
  queue_spike: "Queue spike",
  cron_failure: "Cron failure",
  suspicious_activity: "Suspicious activity",
  login_failure: "Login failure",
  impersonation_started: "Impersonation started",
  bulk_admin_action: "Bulk admin action",
  tenant_suspended: "Tenant suspended",
  tenant_reactivated: "Tenant reactivated",
  custom_domain_connected: "Custom domain connected",
  ses_bounce: "SES bounce/complaint",
  sms_failure: "SMS failure",
};

export const ACTIVITY_KIND_SEVERITY: Record<string, ActivitySeverity> = {
  new_signup: "info",
  subscription_created: "info",
  subscription_upgraded: "info",
  subscription_downgraded: "warning",
  subscription_cancelled: "warning",
  payment_failed: "warning",
  invoice_paid: "info",
  webhook_failed: "critical",
  webhook_recovered: "info",
  oauth_connected: "info",
  oauth_failed: "warning",
  oauth_token_expired: "warning",
  calendar_sync_failed: "warning",
  reminder_failed: "warning",
  queue_spike: "warning",
  cron_failure: "critical",
  suspicious_activity: "warning",
  login_failure: "warning",
  impersonation_started: "info",
  bulk_admin_action: "info",
  tenant_suspended: "warning",
  tenant_reactivated: "info",
  custom_domain_connected: "info",
  ses_bounce: "warning",
  sms_failure: "warning",
};

// ─── Action → kind classifier ──────────────────────────────────────
//
// Patterns are ordered most-specific first. Each function takes the
// raw audit action and returns the matching kind, or null. The first
// match wins.

const PATTERNS: Array<{ match: (action: string) => boolean; kind: string }> = [
  // High-priority specific matches
  { match: (a) => a === "new_tenant_signup" || a === "tenant.created", kind: "new_signup" },
  { match: (a) => a === "new_subscription" || a === "subscription.started" || a.includes("subscription_created"), kind: "subscription_created" },
  { match: (a) => a.includes("billing.upgrade_applied") || a.includes("subscription.upgraded"), kind: "subscription_upgraded" },
  { match: (a) => a.includes("billing.downgrade_applied") || a.includes("subscription.downgraded"), kind: "subscription_downgraded" },
  { match: (a) => a === "subscription_cancelled" || a === "subscription.cancelled" || a.includes("subscription_canceled"), kind: "subscription_cancelled" },
  { match: (a) => a === "invoice.paid" || a === "billing.invoice_paid", kind: "invoice_paid" },
  { match: (a) => a === "payment_failed" || a.includes("payment_intent.payment_failed") || a === "billing.payment_failed", kind: "payment_failed" },

  // Webhook events
  { match: (a) => a.includes("webhook") && a.includes("recover"), kind: "webhook_recovered" },
  { match: (a) => a.includes("webhook") && a.includes("fail"), kind: "webhook_failed" },
  { match: (a) => a === "stripe_webhook_error", kind: "webhook_failed" },

  // OAuth events
  { match: (a) => a.includes("token") && (a.includes("expire") || a.includes("invalid_grant")), kind: "oauth_token_expired" },
  { match: (a) => a === "calendar.connect" || a.startsWith("oauth.success") || a.endsWith(".connected"), kind: "oauth_connected" },
  { match: (a) => a.startsWith("oauth.") && a.includes("fail"), kind: "oauth_failed" },
  { match: (a) => (a.includes("google") || a.includes("microsoft")) && (a.includes("fail") || a.includes("error")) && !a.includes("calendar.sync"), kind: "oauth_failed" },

  // Calendar
  { match: (a) => a.includes("calendar.sync") && (a.includes("fail") || a.includes("conflict")), kind: "calendar_sync_failed" },

  // Reminders / queue
  { match: (a) => a === "reminder_delivery_failure" || (a.includes("reminder") && a.includes("fail")), kind: "reminder_failed" },
  { match: (a) => a === "booking_volume_spike" || a === "queue_spike", kind: "queue_spike" },

  // Cron / worker
  { match: (a) => a.includes("worker.crash") || a.includes("cron.fail") || a.includes("worker_crash") || a === "fatal_exception", kind: "cron_failure" },

  // Security
  { match: (a) => a.startsWith("security.authentication.failed") || a === "repeated_login_failures", kind: "login_failure" },
  { match: (a) => a.startsWith("security.") && a.includes("denied"), kind: "suspicious_activity" },
  { match: (a) => a.startsWith("security.suspicious") || a.includes("suspicious"), kind: "suspicious_activity" },

  // Admin actions
  { match: (a) => a.startsWith("admin.bulk."), kind: "bulk_admin_action" },
  { match: (a) => a.includes("impersonat"), kind: "impersonation_started" },
  { match: (a) => a === "admin.bulk.suspend" || a === "tenant.suspended", kind: "tenant_suspended" },
  { match: (a) => a === "admin.bulk.reactivate" || a === "tenant.reactivated", kind: "tenant_reactivated" },

  // Domains
  { match: (a) => a.includes("domain") && a.includes("connect"), kind: "custom_domain_connected" },

  // Email + SMS
  { match: (a) => a === "ses.bounce" || a === "ses.complaint" || a === "email_provider_error", kind: "ses_bounce" },
  { match: (a) => a.startsWith("sms.") && a.includes("fail"), kind: "sms_failure" },
];

function classify(action: string): string | null {
  for (const p of PATTERNS) if (p.match(action)) return p.kind;
  return null;
}

// ─── Summary builders ──────────────────────────────────────────────

function summaryFor(kind: string, action: string, metadata: Record<string, unknown> | null): string {
  const md = metadata ?? {};
  const slug = (k: string) => (typeof md[k] === "string" ? String(md[k]) : null);
  switch (kind) {
    case "new_signup":
      return slug("slug") ? `New workspace · ${slug("slug")}` : "New workspace";
    case "subscription_created":
      return `New subscription${slug("plan") ? " · " + slug("plan") : ""}`;
    case "subscription_upgraded":
      return `Upgrade${slug("plan") ? " → " + slug("plan") : ""}`;
    case "subscription_downgraded":
      return `Downgrade${slug("plan") ? " → " + slug("plan") : ""}`;
    case "subscription_cancelled":
      return "Subscription cancelled";
    case "invoice_paid":
      return `Invoice paid${md.amount_cents ? " · $" + (Number(md.amount_cents) / 100).toFixed(2) : ""}`;
    case "payment_failed":
      return `Payment failed${slug("bookingId") ? " · booking " + (slug("bookingId") ?? "").slice(0, 8) : ""}`;
    case "webhook_failed":
      return `Webhook failed${slug("provider") ? " · " + slug("provider") : ""}`;
    case "webhook_recovered":
      return "Webhook recovered";
    case "oauth_connected":
      return `OAuth connected${slug("provider") ? " · " + slug("provider") : ""}`;
    case "oauth_failed":
      return `OAuth failure · ${action.split(".")[0]}`;
    case "oauth_token_expired":
      return `OAuth token expired${slug("provider") ? " · " + slug("provider") : ""}`;
    case "calendar_sync_failed":
      return `Calendar sync · ${action}`;
    case "reminder_failed":
      return `Reminder failure (${slug("reasonCategory") ?? "unknown"})`;
    case "queue_spike":
      return `Queue spike${md.count ? " · " + md.count : ""}`;
    case "cron_failure":
      return `Worker crash · ${slug("script") ?? action}`;
    case "login_failure":
      return slug("email") ? `Login failure · ${slug("email")}` : "Login failure";
    case "suspicious_activity":
      return action;
    case "impersonation_started":
      return "Impersonation started";
    case "bulk_admin_action":
      return action.replace("admin.bulk.", "Bulk: ");
    case "tenant_suspended":
      return "Tenant suspended";
    case "tenant_reactivated":
      return "Tenant reactivated";
    case "custom_domain_connected":
      return `Custom domain connected${slug("domain") ? " · " + slug("domain") : ""}`;
    case "ses_bounce":
      return `SES ${action.split(".")[1] ?? "event"}`;
    case "sms_failure":
      return `SMS failure · ${action}`;
    default:
      return action;
  }
}

// ─── Public: feed fetch ────────────────────────────────────────────

export async function fetchActivityFeed(args: {
  cursor?: string | null;
  limit?: number;
  kinds?: string[];
  /** Filter to a specific tenant (UUID). */
  tenantId?: string | null;
  /** Full-text search across summary string (case-insensitive). */
  search?: string | null;
  /** ISO since (inclusive). Used to constrain the window. */
  since?: string | null;
  /** ISO until (exclusive). Used to constrain the window. */
  until?: string | null;
}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  // Overshoot to account for action-pattern misses.
  const fetchN = limit * 3 + 20;

  // We compose the WHERE in raw SQL — Drizzle's typed builders don't
  // express the cursor + optional filters cleanly, and using sql.raw
  // for parameters is unsafe. Each parameter is passed via the sql
  // tag so it's bound, not interpolated.
  const cursor = args.cursor ?? null;
  const tenantId = args.tenantId ?? null;
  const since = args.since ?? null;
  const until = args.until ?? null;

  const rows = (await db.execute(
    sql`SELECT id::text AS id,
               action,
               tenant_id::text AS tenant_id,
               actor_label,
               entity_type,
               entity_id::text AS entity_id,
               ip_address,
               metadata,
               created_at
          FROM audit_logs
         WHERE (${cursor}::text IS NULL OR created_at < ${cursor}::timestamptz)
           AND (${tenantId}::text IS NULL OR tenant_id = ${tenantId}::uuid)
           AND (${since}::text IS NULL OR created_at >= ${since}::timestamptz)
           AND (${until}::text IS NULL OR created_at <  ${until}::timestamptz)
         ORDER BY created_at DESC
         LIMIT ${fetchN}`,
  )) as unknown as Array<{
    id: string;
    action: string;
    tenant_id: string | null;
    actor_label: string | null;
    entity_type: string | null;
    entity_id: string | null;
    ip_address: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;

  const events: ActivityEvent[] = [];
  const searchLower = args.search ? args.search.toLowerCase() : null;
  for (const r of rows) {
    const kind = classify(r.action);
    if (!kind) continue;
    if (args.kinds && args.kinds.length > 0 && !args.kinds.includes(kind)) continue;
    const summary = summaryFor(kind, r.action, r.metadata);
    if (searchLower && !summary.toLowerCase().includes(searchLower) && !r.action.toLowerCase().includes(searchLower)) {
      continue;
    }
    const severity = ACTIVITY_KIND_SEVERITY[kind] ?? "info";
    events.push({
      id: r.id,
      ts: r.created_at,
      severity,
      kind,
      summary,
      tenantId: r.tenant_id,
      actorLabel: r.actor_label,
      entityType: r.entity_type,
      entityId: r.entity_id,
      ipAddress: r.ip_address,
      action: r.action,
      metadata: r.metadata,
      groupKey: `${kind}:${r.tenant_id ?? "platform"}`,
    });
    if (events.length >= limit) break;
  }

  const nextCursor = events.length === limit ? events[events.length - 1].ts : null;
  return { events, nextCursor };
}
