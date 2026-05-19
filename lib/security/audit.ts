/**
 * Centralized security audit helper.
 *
 * Wraps the existing tenant-scoped audit() writer with a CLOSED category
 * enum and typed metadata. Every security-sensitive event in the app
 * MUST route through here so the dashboard surfaces them consistently
 * and ops can grep a single namespace.
 *
 * Design:
 *   - Tenant-scoped. The underlying audit_logs.tenant_id is NOT NULL.
 *   - Append-only. The underlying table has no DELETE/UPDATE callers.
 *   - Never throws (delegates to the underlying audit() which swallows
 *     errors). Booking/payment flows are not affected if audit fails.
 *   - Categories are namespaced "security.*" so they're trivially
 *     filterable from non-security audit rows.
 *
 * Adding a new category: add to SECURITY_AUDIT_CATEGORIES and pick a
 * deliberate severity ('info' | 'notice' | 'warning' | 'critical') in
 * SEVERITY_FOR. Defaults are conservative.
 */

import { audit as writeAuditRow } from "@/lib/audit";

/** Closed union of security audit categories. Every emit-site must pick
 *  one of these — string-typing is intentional to surface unknown values
 *  at compile time. */
export const SECURITY_AUDIT_CATEGORIES = [
  // Auth changes
  "security.password_reset.requested",
  "security.password_reset.completed",
  "security.password_changed",
  // Permission changes
  "security.permission.granted",
  "security.permission.revoked",
  "security.role_changed",
  // Sessions
  "security.session.revoked",
  "security.sessions.revoked_all",
  "security.session.suspicious_login",
  // Data exports
  "security.export.executed",
  // Automation actions
  "security.automation.created",
  "security.automation.updated",
  "security.automation.deleted",
  // Access failures
  "security.access.denied",
  "security.access.failed_login",
] as const;

export type SecurityAuditCategory = (typeof SECURITY_AUDIT_CATEGORIES)[number];

export type Severity = "info" | "notice" | "warning" | "critical";

const SEVERITY_FOR: Record<SecurityAuditCategory, Severity> = {
  "security.password_reset.requested": "info",
  "security.password_reset.completed": "notice",
  "security.password_changed": "notice",
  "security.permission.granted": "warning",
  "security.permission.revoked": "warning",
  "security.role_changed": "warning",
  "security.session.revoked": "notice",
  "security.sessions.revoked_all": "warning",
  "security.session.suspicious_login": "warning",
  "security.export.executed": "info",
  "security.automation.created": "info",
  "security.automation.updated": "info",
  "security.automation.deleted": "notice",
  "security.access.denied": "warning",
  "security.access.failed_login": "info",
};

export type SecurityAuditEntry = {
  tenantId: string;
  category: SecurityAuditCategory;
  /** The user who performed the action (or null for system / unauthenticated). */
  actorUserId?: string | null;
  actorLabel?: string;
  /** The object the action targeted (e.g. another user, an automation rule). */
  entityType?: string;
  entityId?: string;
  ipAddress?: string | null;
  /** Free-form context. Stringify-safe values only. */
  metadata?: Record<string, unknown>;
};

/** Fire-and-forget. Never throws. Adds severity + a structured single-
 *  line JSON log so ops alerting pipelines can react to security
 *  events without polling the DB. */
export async function recordSecurityAudit(entry: SecurityAuditEntry): Promise<void> {
  const severity = SEVERITY_FOR[entry.category];

  // 1. Persistent audit row in audit_logs (existing infrastructure).
  await writeAuditRow({
    tenantId: entry.tenantId,
    action: entry.category,
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel,
    entityType: entry.entityType,
    entityId: entry.entityId,
    ipAddress: entry.ipAddress ?? null,
    metadata: {
      ...(entry.metadata ?? {}),
      severity,
    },
  });

  // 2. Structured stdout — easy to forward to a log aggregator without
  //    needing a DB read. Severity warning+ is the alert tier.
  console.log(
    JSON.stringify({
      evt: "security_audit",
      severity,
      category: entry.category,
      tenant: entry.tenantId,
      actor: entry.actorUserId ?? null,
      entity: entry.entityId ?? null,
      ip: entry.ipAddress ?? null,
      ts: new Date().toISOString(),
      ...(entry.metadata ? { meta: entry.metadata } : {}),
    })
  );
}
