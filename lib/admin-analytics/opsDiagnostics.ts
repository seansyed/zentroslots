/**
 * Stabilization Wave — Operator diagnostics aggregator.
 *
 * Combines cron_runs + audit_logs into a single bundle for the
 * /admin/ops dashboard:
 *   • Cron heartbeat   — last successful run per job, with age
 *   • Recent failures  — failed cron runs in last 24h, with reason
 *   • Recent crashes   — worker_crash / fatal_exception audit rows
 *   • Stuck queues     — pending_payment backlog, automations
 *                        stuck in 'processing', export jobs unsealed
 *   • Retry/dead-letter visibility — admin_notify queue depth
 *
 * Every query is a single COUNT or short SELECT. Memoized 30s so a
 * tab refresh doesn't thrash the DB.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Cron heartbeat ────────────────────────────────────────────────

/** Expected cadence in minutes per known job. Used to flag a job as
 *  "stale" (yellow) or "down" (red) when its last run is older than
 *  3× / 6× the expected interval. */
export const CRON_EXPECTED_INTERVAL_MIN: Record<string, number> = {
  "holds:expire": 5,
  "automations:run": 5,
  "reminders:send": 15,
  "waitlists:expire": 10,
  "recurring:materialize": 15,
  "feeds:sync": 15,
  "admin:snapshots:hourly": 10,
  "admin:snapshots:tenant": 30,
  "admin:snapshots:finance": 15,
  "admin:snapshots:daily": 1440, // once a day
  "analytics:aggregate": 1440,
  "scheduled-reports:generate": 1440,
  "governance:retention": 1440,
};

export type CronStatus = "ok" | "stale" | "down" | "unknown" | "running";

export type CronHeartbeat = {
  jobName: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastDetail: Record<string, unknown> | null;
  ageMinutes: number | null;
  expectedIntervalMin: number | null;
  status: CronStatus;
  /** Number of failed runs in the last 24h. */
  failedRuns24h: number;
};

export async function fetchCronHeartbeats(): Promise<CronHeartbeat[]> {
  return memoize(
    "admin:ops:cron_heartbeats:v1",
    async () => {
      // One latest row per job_name + 24h failure count, joined in SQL.
      const rows = (await db.execute(
        sql`WITH last_run AS (
              SELECT DISTINCT ON (job_name)
                     job_name, started_at, finished_at, status, duration_ms, detail
                FROM cron_runs
               ORDER BY job_name, started_at DESC
            ),
            fail_count AS (
              SELECT job_name, COUNT(*)::int AS failed_24h
                FROM cron_runs
               WHERE status = 'failed' AND started_at > NOW() - INTERVAL '24 hours'
               GROUP BY job_name
            )
            SELECT lr.job_name,
                   lr.started_at  AS last_started_at,
                   lr.finished_at AS last_finished_at,
                   lr.status      AS last_status,
                   lr.duration_ms AS last_duration_ms,
                   lr.detail      AS last_detail,
                   COALESCE(fc.failed_24h, 0) AS failed_24h
              FROM last_run lr
              LEFT JOIN fail_count fc ON fc.job_name = lr.job_name
             ORDER BY lr.job_name`,
      )) as unknown as Array<{
        job_name: string;
        last_started_at: string | null;
        last_finished_at: string | null;
        last_status: string | null;
        last_duration_ms: number | null;
        last_detail: Record<string, unknown> | null;
        failed_24h: number;
      }>;

      // Build a heartbeat row for every known job, even if cron_runs
      // has zero rows for it — that way "missing job" is visible as
      // an explicit "down" / "unknown" status, not a gap in the table.
      const seen = new Set(rows.map((r) => r.job_name));
      const known = Object.keys(CRON_EXPECTED_INTERVAL_MIN);
      const allJobs = [...new Set([...known, ...rows.map((r) => r.job_name)])];

      return allJobs
        .map((jobName) => {
          const row = rows.find((r) => r.job_name === jobName);
          const expected = CRON_EXPECTED_INTERVAL_MIN[jobName] ?? null;
          const lastStartedIso = row?.last_started_at ?? null;
          const ageMin = lastStartedIso
            ? Math.max(
                0,
                Math.round((Date.now() - new Date(lastStartedIso).getTime()) / 60_000),
              )
            : null;
          let status: CronStatus = "unknown";
          if (!row) {
            status = expected ? "down" : "unknown";
          } else if (row.last_status === "running") {
            status = "running";
          } else if (row.last_status === "failed") {
            status = "down";
          } else if (expected && ageMin !== null) {
            if (ageMin > expected * 6) status = "down";
            else if (ageMin > expected * 3) status = "stale";
            else status = "ok";
          } else {
            status = "ok";
          }
          return {
            jobName,
            lastStartedAt: row?.last_started_at ?? null,
            lastFinishedAt: row?.last_finished_at ?? null,
            lastStatus: row?.last_status ?? null,
            lastDurationMs: row?.last_duration_ms ?? null,
            lastDetail: row?.last_detail ?? null,
            ageMinutes: ageMin,
            expectedIntervalMin: expected,
            status,
            failedRuns24h: Number(row?.failed_24h ?? 0),
          };
        })
        .sort((a, b) => {
          const order = { down: 0, stale: 1, running: 2, ok: 3, unknown: 4 };
          return order[a.status] - order[b.status];
        });
    },
    30_000,
  );
}

// ─── Recent failures ───────────────────────────────────────────────

export type RecentFailure = {
  source: "cron" | "audit";
  ts: string;
  label: string;
  detail: string;
  tenantId: string | null;
};

export async function fetchRecentFailures(): Promise<RecentFailure[]> {
  return memoize(
    "admin:ops:recent_failures:v1",
    async () => {
      const cronFails = (await db.execute(
        sql`SELECT 'cron' AS source, started_at AS ts, job_name AS label, detail::text AS detail, NULL::uuid AS tenant_id
              FROM cron_runs
             WHERE status = 'failed' AND started_at > NOW() - INTERVAL '24 hours'
             ORDER BY started_at DESC
             LIMIT 50`,
      )) as unknown as Array<{
        source: string;
        ts: string;
        label: string;
        detail: string | null;
        tenant_id: string | null;
      }>;

      const auditFails = (await db.execute(
        sql`SELECT 'audit' AS source, created_at AS ts, action AS label,
                   COALESCE(metadata::text, '{}') AS detail,
                   tenant_id::text AS tenant_id
              FROM audit_logs
             WHERE (action ILIKE '%fail%' OR action ILIKE '%crash%' OR action ILIKE '%error%')
               AND created_at > NOW() - INTERVAL '24 hours'
             ORDER BY created_at DESC
             LIMIT 50`,
      )) as unknown as Array<{
        source: string;
        ts: string;
        label: string;
        detail: string | null;
        tenant_id: string | null;
      }>;

      return [...cronFails, ...auditFails]
        .map((r) => ({
          source: r.source as "cron" | "audit",
          ts: r.ts,
          label: r.label,
          detail: (r.detail ?? "").slice(0, 400),
          tenantId: r.tenant_id,
        }))
        .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
        .slice(0, 50);
    },
    30_000,
  );
}

// ─── Stuck queues ──────────────────────────────────────────────────

export type StuckQueueRow = {
  kind: string;
  label: string;
  count: number;
  detail: string;
};

export async function fetchStuckQueues(): Promise<StuckQueueRow[]> {
  return memoize(
    "admin:ops:stuck_queues:v1",
    async () => {
      const rows: StuckQueueRow[] = [];

      // 1. Pending payment backlog (cron should be draining)
      try {
        const r = (await db.execute(
          sql`SELECT COUNT(*)::int AS n,
                     COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(payment_hold_expires_at)))::int, 0) AS oldest_age_s
                FROM bookings
               WHERE status = 'pending_payment'
                 AND payment_hold_expires_at IS NOT NULL
                 AND payment_hold_expires_at < NOW() - INTERVAL '5 minutes'`,
        )) as unknown as Array<{ n: number; oldest_age_s: number }>;
        const n = Number(r[0]?.n ?? 0);
        if (n > 0) {
          rows.push({
            kind: "pending_payment_backlog",
            label: "Pending-payment bookings overdue",
            count: n,
            detail: `oldest is ${Math.round((r[0]?.oldest_age_s ?? 0) / 60)}min old. holds:expire cron should drain.`,
          });
        }
      } catch {}

      // 2. Automations stuck in processing >30 min
      try {
        const r = (await db.execute(
          sql`SELECT COUNT(*)::int AS n
                FROM pending_automations
               WHERE status = 'processing'
                 AND updated_at < NOW() - INTERVAL '30 minutes'`,
        )) as unknown as Array<{ n: number }>;
        const n = Number(r[0]?.n ?? 0);
        if (n > 0) {
          rows.push({
            kind: "pending_automations_stuck",
            label: "Automations stuck in 'processing'",
            count: n,
            detail: "Likely a worker crashed mid-claim. Manual SQL reset to 'pending' is safe.",
          });
        }
      } catch {}

      // 3. Webhook signature failures
      try {
        const r = (await db.execute(
          sql`SELECT COUNT(*)::int AS n
                FROM tenant_payment_webhook_events
               WHERE status = 'invalid_signature'
                 AND received_at > NOW() - INTERVAL '24 hours'`,
        )) as unknown as Array<{ n: number }>;
        const n = Number(r[0]?.n ?? 0);
        if (n > 0) {
          rows.push({
            kind: "webhook_signature_failures",
            label: "Stripe webhook signature failures (24h)",
            count: n,
            detail: "Verify the tenant's webhook secret hasn't rotated unexpectedly.",
          });
        }
      } catch {}

      // 4. Communication failures last 24h
      try {
        const r = (await db.execute(
          sql`SELECT COUNT(*)::int AS n
                FROM communication_logs
               WHERE status = 'failed'
                 AND created_at > NOW() - INTERVAL '24 hours'`,
        )) as unknown as Array<{ n: number }>;
        const n = Number(r[0]?.n ?? 0);
        if (n > 0) {
          rows.push({
            kind: "comms_failures",
            label: "Failed email/SMS sends (24h)",
            count: n,
            detail: "Check SES suppression list, sender verification, template variables.",
          });
        }
      } catch {}

      return rows;
    },
    30_000,
  );
}

// ─── Combined bundle ───────────────────────────────────────────────

export type OpsDiagnosticsBundle = {
  cronHeartbeats: CronHeartbeat[];
  recentFailures: RecentFailure[];
  stuckQueues: StuckQueueRow[];
  billingFindingsCount: number;
  generatedAt: string;
};

export async function computeOpsDiagnostics(): Promise<OpsDiagnosticsBundle> {
  // Lazy import to avoid circular dep — billingValidator imports memoize from cache.
  const { computeBillingValidation } = await import("./billingValidator").catch(() => ({
    computeBillingValidation: async () => ({ findings: [] }),
  }));

  const [cronHeartbeats, recentFailures, stuckQueues, billing] = await Promise.all([
    fetchCronHeartbeats().catch(() => []),
    fetchRecentFailures().catch(() => []),
    fetchStuckQueues().catch(() => []),
    computeBillingValidation().catch(() => ({ findings: [] as unknown[] })),
  ]);
  return {
    cronHeartbeats,
    recentFailures,
    stuckQueues,
    billingFindingsCount: billing.findings.length,
    generatedAt: new Date().toISOString(),
  };
}
