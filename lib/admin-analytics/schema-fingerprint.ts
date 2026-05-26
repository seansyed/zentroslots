/**
 * Schema fingerprint — runtime drift detector for admin analytics.
 *
 * Compares the columns each admin-analytics module DEPENDS on against
 * `information_schema.columns`. Any missing column = drift. Surface
 * in /admin/diagnostics so a deploy that ships a new query against a
 * stale schema is caught BEFORE a customer sees "Unable to compute".
 *
 * This is read-only — it never mutates the DB. The check itself is
 * one query against information_schema, sub-millisecond.
 *
 * Adding a new admin-analytics query? Register the column it touches
 * in EXPECTED_SCHEMA. Build will then flag drift if the live DB ever
 * loses or renames the column.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

/**
 * Tables + columns the admin-analytics layer depends on. The MOST
 * critical column for each table is listed — we don't need to
 * exhaustively register every column, just the ones whose absence
 * would silently break a KPI / chart / panel.
 */
export const EXPECTED_SCHEMA: Record<string, readonly string[]> = {
  billing_transactions: [
    "id",
    "tenant_id",
    "amount_cents",
    "currency",
    "transaction_type", // ← the bug we just fixed referenced 'event_type' here.
    "status",
    "created_at",
    "paid_at",
    "refunded_at",
  ],
  audit_logs: [
    "id",
    "tenant_id",
    "action",
    "actor_user_id",
    "actor_label",
    "entity_type",
    "entity_id",
    "ip_address",
    "metadata",
    "created_at",
  ],
  bookings: [
    "id",
    "tenant_id",
    "service_id",
    "staff_user_id",
    "status",
    "start_at",
    "end_at",
    "payment_hold_expires_at",
    "payment_provider_id",
    "created_at",
  ],
  tenants: [
    "id",
    "name",
    "slug",
    "plan",
    "current_plan",
    "active",
    "subscription_status",
    "stripe_subscription_id",
    "trial_end",
    "onboarding_completed_at",
    "onboarding_started_at",
    "created_at",
  ],
  users: ["id", "tenant_id", "email", "role", "google_status", "created_at"],
  communication_logs: [
    "id",
    "tenant_id",
    "channel",
    "event_type", // ← yes, this table DOES have event_type
    "status",
    "created_at",
  ],
  calendar_connections: ["id", "provider", "status", "tenant_id"],
  tenant_payment_providers: [
    "id",
    "tenant_id",
    "provider",
    "status",
    "webhook_status",
    "enabled",
    "last_verified_at",
  ],
  tenant_payment_webhook_events: [
    "id",
    "tenant_id",
    "status",
    "booking_id",
    "received_at",
  ],
  cron_runs: ["id", "job_name", "started_at", "finished_at", "duration_ms", "status", "detail"],
  analytics_snapshots_daily: ["id", "snapshot_date", "total_tenants", "mrr_cents"],
  analytics_snapshots_hourly: ["id", "snapshot_hour", "bookings", "failed_logins"],
  tenant_health_snapshots: ["id", "tenant_id", "snapshot_date", "health_score", "risk_level"],
  financial_snapshots: ["id", "snapshot_date", "plan", "mrr_cents", "active_subscriptions"],
} as const;

export type SchemaDrift = {
  table: string;
  /** Columns we expected but couldn't find. */
  missingColumns: string[];
  /** True when the entire table is missing. */
  tableMissing: boolean;
};

export type SchemaFingerprintReport = {
  /** Drift entries — empty when everything is healthy. */
  drift: SchemaDrift[];
  /** Total number of (table, column) pairs verified. */
  totalChecks: number;
  /** Generated timestamp. */
  generatedAt: string;
  /** Whether the live schema matches every expected column. */
  healthy: boolean;
};

/** Computes the fingerprint. Caches for 5 minutes (schema changes
 *  are migrations, not hot-path). */
export async function computeSchemaFingerprint(): Promise<SchemaFingerprintReport> {
  return memoize(
    "admin:schema:fingerprint:v1",
    async () => {
      const tableNames = Object.keys(EXPECTED_SCHEMA);
      // information_schema.columns is reliably indexed; one query
      // returns every (table_name, column_name) pair in public.
      const rows = (await db.execute(
        sql`SELECT table_name, column_name
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = ANY(${sql.raw(`ARRAY[${tableNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`,
      )) as unknown as Array<{ table_name: string; column_name: string }>;

      // Build a lookup: table -> Set<column>.
      const live = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!live.has(r.table_name)) live.set(r.table_name, new Set());
        live.get(r.table_name)!.add(r.column_name);
      }

      let totalChecks = 0;
      const drift: SchemaDrift[] = [];
      for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
        totalChecks += columns.length;
        const liveCols = live.get(table);
        if (!liveCols) {
          drift.push({ table, missingColumns: [], tableMissing: true });
          continue;
        }
        const missing = columns.filter((c) => !liveCols.has(c));
        if (missing.length > 0) {
          drift.push({ table, missingColumns: missing, tableMissing: false });
        }
      }

      return {
        drift,
        totalChecks,
        generatedAt: new Date().toISOString(),
        healthy: drift.length === 0,
      };
    },
    300_000, // 5 min — schema only changes on migrations.
  );
}
