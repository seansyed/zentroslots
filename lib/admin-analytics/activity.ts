/**
 * SA-3 Section D / SA-5 — Live operational event feed.
 *
 * Cross-tenant stream of high-signal events for super-admin
 * monitoring. Pulled from `audit_logs` with action-pattern matching.
 *
 * Surfaces 12 event types with severity tagging:
 *
 *    failed_webhook        critical
 *    stripe_error          warning
 *    oauth_failure         warning
 *    sync_failure          warning
 *    cron_failure          critical
 *    queue_spike           warning
 *    suspicious_activity   warning
 *    ses_bounce            warning
 *    new_signup            info
 *    new_subscription      info
 *    subscription_cancel   warning
 *    payment_failed        warning
 *
 * Each event normalized to a consistent shape so the UI can render
 * them in one stream. Paginated via opaque `cursor` (the created_at
 * timestamp of the oldest row in the current page).
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
  /** Tenant context — UI can link to /admin/tenants/[id]. Optional
   *  because some events are platform-level (e.g. SES bounce on a
   *  global sender). */
  tenantId: string | null;
  /** Raw audit action string for power users / drilldown. */
  action: string;
};

export type ActivityPage = {
  events: ActivityEvent[];
  /** ISO timestamp of the oldest event in this page; pass back as
   *  `?cursor=...` to fetch the next page. Null = end of stream. */
  nextCursor: string | null;
};

// Pattern → kind/severity classification. Order matters; first
// match wins.
const PATTERNS: Array<{ match: (action: string) => boolean; kind: string; severity: ActivitySeverity }> = [
  { match: (a) => a.includes("worker.crash") || a.includes("cron.fail") || a.includes("worker_crash"), kind: "cron_failure", severity: "critical" },
  { match: (a) => a.includes("webhook") && a.includes("fail"), kind: "failed_webhook", severity: "critical" },
  { match: (a) => a.startsWith("stripe.") && a.includes("error"), kind: "stripe_error", severity: "warning" },
  { match: (a) => a.startsWith("payment_failed") || a.includes("payment_intent.payment_failed") || a === "billing.payment_failed", kind: "payment_failed", severity: "warning" },
  { match: (a) => a.startsWith("oauth.") && a.includes("fail"), kind: "oauth_failure", severity: "warning" },
  { match: (a) => a.includes("google") && (a.includes("fail") || a.includes("error")), kind: "oauth_failure", severity: "warning" },
  { match: (a) => a.includes("microsoft") && (a.includes("fail") || a.includes("error")), kind: "oauth_failure", severity: "warning" },
  { match: (a) => a.includes("calendar.sync") && (a.includes("fail") || a.includes("conflict")), kind: "sync_failure", severity: "warning" },
  { match: (a) => a === "new_tenant_signup" || a === "tenant.created", kind: "new_signup", severity: "info" },
  { match: (a) => a === "new_subscription" || a === "subscription.started" || a.includes("subscription_created"), kind: "new_subscription", severity: "info" },
  { match: (a) => a === "subscription_cancelled" || a === "subscription.cancelled" || a.includes("subscription_canceled"), kind: "subscription_cancel", severity: "warning" },
  { match: (a) => a === "reminder_delivery_failure" || (a.includes("reminder") && a.includes("fail")), kind: "queue_spike", severity: "warning" },
  { match: (a) => a === "ses.bounce" || a === "ses.complaint" || a === "email_provider_error", kind: "ses_bounce", severity: "warning" },
  { match: (a) => a.startsWith("security.") && a.includes("denied"), kind: "suspicious_activity", severity: "warning" },
  { match: (a) => a.startsWith("security.authentication.failed"), kind: "suspicious_activity", severity: "warning" },
];

function classify(action: string): { kind: string; severity: ActivitySeverity } | null {
  for (const p of PATTERNS) {
    if (p.match(action)) return { kind: p.kind, severity: p.severity };
  }
  return null;
}

function summaryFor(kind: string, action: string, metadata: Record<string, unknown> | null): string {
  // Pull a short human label from metadata when present.
  const md = metadata ?? {};
  switch (kind) {
    case "failed_webhook":
      return `Webhook failed: ${String(md.provider ?? action)}`;
    case "stripe_error":
      return `Stripe error · ${action}`;
    case "payment_failed":
      return `Payment failed${md.bookingId ? " · booking " + String(md.bookingId).slice(0, 8) : ""}`;
    case "oauth_failure":
      return `OAuth refresh failed · ${action.split(".")[0]}`;
    case "sync_failure":
      return `Calendar sync failure · ${action}`;
    case "cron_failure":
      return `Worker crash · ${String(md.script ?? action)}`;
    case "queue_spike":
      return `Reminder failure (${String(md.reasonCategory ?? "unknown")})`;
    case "suspicious_activity":
      return action;
    case "ses_bounce":
      return `SES ${action.split(".")[1] ?? "event"}`;
    case "new_signup":
      return `New workspace${md.slug ? " · " + String(md.slug) : ""}`;
    case "new_subscription":
      return `New subscription${md.plan ? " · " + String(md.plan) : ""}`;
    case "subscription_cancel":
      return `Subscription cancelled`;
    default:
      return action;
  }
}

export async function fetchActivityFeed(args: {
  /** ISO timestamp; rows older than this are returned. Null = newest. */
  cursor?: string | null;
  /** Page size. Capped to 100 for safety. */
  limit?: number;
  /** Optional kind filter (UI checkbox). */
  kinds?: string[];
}): Promise<ActivityPage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  // We overshoot the fetch (×2) because the action-pattern matcher
  // may filter out some rows that don't classify into any known kind.
  // This avoids a tight cursor loop on a noisy audit table.
  const fetchN = limit * 2 + 20;

  const rows = (await db.execute(
    args.cursor
      ? sql`SELECT id::text, action, tenant_id::text AS tenant_id, metadata, created_at, ip_address
              FROM audit_logs
             WHERE created_at < ${args.cursor}::timestamptz
             ORDER BY created_at DESC
             LIMIT ${fetchN}`
      : sql`SELECT id::text, action, tenant_id::text AS tenant_id, metadata, created_at, ip_address
              FROM audit_logs
             ORDER BY created_at DESC
             LIMIT ${fetchN}`,
  )) as unknown as Array<{
    id: string;
    action: string;
    tenant_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    ip_address: string | null;
  }>;

  const events: ActivityEvent[] = [];
  for (const r of rows) {
    const c = classify(r.action);
    if (!c) continue;
    if (args.kinds && args.kinds.length > 0 && !args.kinds.includes(c.kind)) continue;
    events.push({
      id: r.id,
      ts: r.created_at,
      severity: c.severity,
      kind: c.kind,
      summary: summaryFor(c.kind, r.action, r.metadata ?? {}),
      tenantId: r.tenant_id,
      action: r.action,
    });
    if (events.length >= limit) break;
  }

  const nextCursor = events.length === limit ? events[events.length - 1].ts : null;
  return { events, nextCursor };
}
