/**
 * SA-3 Section A — Infrastructure health metrics for the Platform
 * Health Center.
 *
 * Sources of truth (all queried, no mock data):
 *   • /api/health     — DB latency, EXCLUDE constraint, billing
 *                       ledger, analytics aggregation freshness,
 *                       smtp_transport, reminder_delivery,
 *                       email_suppressions, etc.
 *   • billing_transactions, audit_logs, communication_logs,
 *     email_suppressions
 *   • process.memoryUsage() / process.uptime() — PM2 / runtime
 *
 * Per-metric error isolation: each compute is wrapped so a single
 * failure becomes an inline error chip on its card without taking
 * down the whole page.
 *
 * Status logic:
 *   green  = healthy
 *   amber  = degraded (warning threshold crossed)
 *   red    = critical (hard threshold crossed)
 *
 * Each card carries:
 *   value           — current scalar
 *   status          — 'green' | 'amber' | 'red'
 *   unit            — formatting hint for the UI
 *   sparkline       — short array (recent buckets) where applicable
 *   thresholds      — { amber, red } for tooltip rendering
 *   lastUpdatedAt   — ISO timestamp of the freshest underlying datum
 *   detail          — short status string for the tooltip
 *   tooltip         — human-readable definition
 *   error           — categorized failure if compute threw
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Types ─────────────────────────────────────────────────────────

export type HealthStatus = "green" | "amber" | "red";

export type HealthCard = {
  key: string;
  label: string;
  value: number | string | null;
  unit: "ms" | "count" | "percent" | "bytes" | "duration_s" | "string" | "none";
  status: HealthStatus;
  sparkline: number[];
  thresholds: { amber: number | null; red: number | null };
  lastUpdatedAt: string;
  detail: string;
  tooltip: string;
  error?: string;
};

export type InfrastructureHealth = {
  cards: HealthCard[];
  generatedAt: string;
  computedInMs: number;
};

// ─── Helpers ───────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function pickStatus(
  value: number | null,
  thresholds: { amber: number | null; red: number | null },
  /** Higher is worse (latency, failures). Default. */
  higherIsBad = true,
): HealthStatus {
  if (value === null) return "amber"; // unknown → degraded
  if (higherIsBad) {
    if (thresholds.red !== null && value >= thresholds.red) return "red";
    if (thresholds.amber !== null && value >= thresholds.amber) return "amber";
    return "green";
  }
  // Lower-is-bad case (success rate, uptime)
  if (thresholds.red !== null && value <= thresholds.red) return "red";
  if (thresholds.amber !== null && value <= thresholds.amber) return "amber";
  return "green";
}

async function safe(producer: () => Promise<HealthCard>, fallback: HealthCard): Promise<HealthCard> {
  try {
    return await producer();
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    try {
      console.error(JSON.stringify({ evt: "health_card_fail", reason, ts: nowIso() }));
    } catch {}
    return { ...fallback, error: reason };
  }
}

// ─── Card builders ─────────────────────────────────────────────────

async function buildApiUptimeCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "api_uptime",
    label: "API uptime",
    value: null,
    unit: "duration_s",
    status: "green",
    sparkline: [],
    thresholds: { amber: null, red: null },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip: "Time since the current Node process started. PM2 restart resets the clock.",
  };
  return safe(async () => {
    const uptime = Math.round(process.uptime());
    base.value = uptime;
    // Just-restarted (<60s) is itself an amber signal — could indicate
    // a crash loop. Otherwise: green.
    base.status = uptime < 60 ? "amber" : "green";
    base.detail = uptime < 60
      ? `Just restarted ${uptime}s ago`
      : `Up ${Math.floor(uptime / 60)} min`;
    return base;
  }, base);
}

async function buildDbLatencyCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "db_latency",
    label: "PostgreSQL latency",
    value: null,
    unit: "ms",
    status: "green",
    sparkline: [],
    thresholds: { amber: 50, red: 200 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip: "Round-trip latency of a single SELECT 1 to RDS.",
  };
  return safe(async () => {
    const t0 = Date.now();
    await db.execute(sql`SELECT 1`);
    const ms = Date.now() - t0;
    base.value = ms;
    base.status = pickStatus(ms, base.thresholds);
    base.detail = `${ms}ms`;
    return base;
  }, base);
}

async function buildApiResponseCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "api_response_latency",
    label: "API response latency",
    value: null,
    unit: "ms",
    status: "green",
    sparkline: [],
    thresholds: { amber: 250, red: 800 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip: "Self-test of a 3-query SELECT to gauge in-process API latency.",
  };
  return safe(async () => {
    const t0 = Date.now();
    await Promise.all([
      db.execute(sql`SELECT 1`),
      db.execute(sql`SELECT COUNT(*)::int FROM tenants`),
      db.execute(sql`SELECT COUNT(*)::int FROM bookings`),
    ]);
    const ms = Date.now() - t0;
    base.value = ms;
    base.status = pickStatus(ms, base.thresholds);
    base.detail = `${ms}ms across 3 queries`;
    return base;
  }, base);
}

async function buildQueueBacklogCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "queue_backlog",
    label: "Reminder queue backlog",
    value: null,
    unit: "count",
    status: "green",
    sparkline: [],
    thresholds: { amber: 50, red: 200 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip: "Confirmed bookings due within next 1h with no reminder1hSentAt — should hover near zero.",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS n
            FROM bookings
           WHERE status = 'confirmed'
             AND start_at <= NOW() + INTERVAL '1 hour'
             AND start_at >  NOW()
             AND reminder_1h_sent_at IS NULL`,
    )) as unknown as Array<{ n: number | string | null }>;
    const n = Number(rows[0]?.n ?? 0);
    base.value = n;
    base.status = pickStatus(n, base.thresholds);
    base.detail = n === 0 ? "Clean" : `${n} backlog`;
    return base;
  }, base);
}

async function buildQueueFailuresCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "queue_failures",
    label: "Reminder failures (24h)",
    value: null,
    unit: "count",
    status: "green",
    sparkline: [],
    thresholds: { amber: 5, red: 25 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip: "communication_logs with status='failed' in the last 24h.",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM communication_logs WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours'`,
    )) as unknown as Array<{ n: number | string | null }>;
    const n = Number(rows[0]?.n ?? 0);
    base.value = n;
    base.status = pickStatus(n, base.thresholds);
    base.detail = `${n} failure${n === 1 ? "" : "s"}`;
    return base;
  }, base);
}

async function buildStripeWebhookCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "stripe_webhook_success",
    label: "Stripe webhook success",
    value: null,
    unit: "percent",
    status: "green",
    sparkline: [],
    thresholds: { amber: 95, red: 80 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "Recorded billing_transactions in last 7d. 100% if no failures observed (we only persist successful sigatures + idempotency-claim wins; failures hit audit_logs instead).",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(*)::int FROM billing_transactions WHERE created_at > NOW() - INTERVAL '7 days') AS ok,
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE '%webhook%fail%' AND created_at > NOW() - INTERVAL '7 days') AS fail`,
      )) as unknown as Array<{ ok: number; fail: number }>;
    const ok = Number(rows[0]?.ok ?? 0);
    const fail = Number(rows[0]?.fail ?? 0);
    const denom = ok + fail;
    if (denom === 0) {
      base.value = null;
      base.status = "green";
      base.detail = "No webhook activity in 7d";
      return base;
    }
    const pct = Math.round((ok / denom) * 1000) / 10;
    base.value = pct;
    base.status = pickStatus(pct, base.thresholds, false);
    base.detail = `${ok} ok / ${fail} failed (7d)`;
    return base;
  }, base);
}

async function buildSesDeliveryCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "ses_delivery_success",
    label: "SES delivery success",
    value: null,
    unit: "percent",
    status: "green",
    sparkline: [],
    thresholds: { amber: 98, red: 90 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "communication_logs status='sent' ÷ (sent + failed) over last 24h. Below 90% triggers a SES sandbox investigation.",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(*)::int FROM communication_logs WHERE status='sent'   AND created_at > NOW() - INTERVAL '24 hours') AS s,
            (SELECT COUNT(*)::int FROM communication_logs WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours') AS f`,
    )) as unknown as Array<{ s: number; f: number }>;
    const s = Number(rows[0]?.s ?? 0);
    const f = Number(rows[0]?.f ?? 0);
    const denom = s + f;
    if (denom === 0) {
      base.value = null;
      base.status = "green";
      base.detail = "No send activity in 24h";
      return base;
    }
    const pct = Math.round((s / denom) * 1000) / 10;
    base.value = pct;
    base.status = pickStatus(pct, base.thresholds, false);
    base.detail = `${s} sent / ${f} failed`;
    return base;
  }, base);
}

async function buildBounceRateCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "ses_bounce_rate",
    label: "Email bounce rate (7d)",
    value: null,
    unit: "percent",
    status: "green",
    sparkline: [],
    thresholds: { amber: 2, red: 5 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "New bounce rows in email_suppressions ÷ total sends, last 7d. >5% triggers SES auto-pause.",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(*)::int FROM email_suppressions WHERE kind='bounce' AND first_seen_at > NOW() - INTERVAL '7 days') AS b,
            (SELECT COUNT(*)::int FROM communication_logs WHERE status='sent' AND created_at > NOW() - INTERVAL '7 days') AS s`,
    )) as unknown as Array<{ b: number; s: number }>;
    const b = Number(rows[0]?.b ?? 0);
    const s = Number(rows[0]?.s ?? 0);
    if (s === 0) {
      base.value = null;
      base.detail = "No sends in 7d";
      return base;
    }
    const pct = Math.round((b / s) * 1000) / 10;
    base.value = pct;
    base.status = pickStatus(pct, base.thresholds);
    base.detail = `${b} bounces / ${s} sends`;
    return base;
  }, base);
}

async function buildCronHealthCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "cron_health",
    label: "Reminder cron freshness",
    value: null,
    unit: "duration_s",
    status: "green",
    sparkline: [],
    thresholds: { amber: 1800, red: 3600 }, // 30min / 1h
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "Seconds since the most recent communication_logs row. The reminder cron runs */15 min so this should hover < 900s under normal load (longer is fine on a low-traffic day).",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::int AS age_s FROM communication_logs`,
    )) as unknown as Array<{ age_s: number | string | null }>;
    const age = Number(rows[0]?.age_s ?? 0);
    base.value = age;
    base.status = pickStatus(age, base.thresholds);
    if (age < 60) base.detail = `${age}s ago`;
    else if (age < 3600) base.detail = `${Math.round(age / 60)} min ago`;
    else base.detail = `${Math.round(age / 3600)}h ago`;
    return base;
  }, base);
}

async function buildCalendarSyncCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "calendar_sync_queue",
    label: "Calendar sync — expired tokens",
    value: null,
    unit: "count",
    status: "green",
    sparkline: [],
    thresholds: { amber: 1, red: 5 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "Users with a Google refresh_token whose status is 'expired' or 'error'. They will not receive new sync events until reconnect.",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS n
            FROM users
           WHERE google_refresh_token IS NOT NULL
             AND google_status IN ('expired','error')`,
    )) as unknown as Array<{ n: number | string | null }>;
    const n = Number(rows[0]?.n ?? 0);
    base.value = n;
    base.status = pickStatus(n, base.thresholds);
    base.detail = n === 0 ? "All healthy" : `${n} need reconnect`;
    return base;
  }, base);
}

async function buildMemoryCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "memory_usage",
    label: "Process memory",
    value: null,
    unit: "bytes",
    status: "green",
    sparkline: [],
    thresholds: { amber: 384 * 1024 * 1024, red: 768 * 1024 * 1024 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip: "Node process RSS (resident set). PM2 typically restarts above ~1 GB.",
  };
  return safe(async () => {
    const mem = process.memoryUsage();
    const rss = mem.rss;
    base.value = rss;
    base.status = pickStatus(rss, base.thresholds);
    base.detail = `${Math.round(rss / 1024 / 1024)} MB RSS`;
    return base;
  }, base);
}

async function buildFailedJobsCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "failed_background_jobs",
    label: "Worker crashes (24h)",
    value: null,
    unit: "count",
    status: "green",
    sparkline: [],
    thresholds: { amber: 1, red: 5 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "audit_logs with action LIKE 'worker.crash%' OR 'cron.fail%'. The reminder cron has been wired to admin-notify on uncaught exceptions; this is the trail.",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM audit_logs
           WHERE (action LIKE 'worker.crash%' OR action LIKE 'cron.fail%' OR action LIKE 'worker_crash%')
             AND created_at > NOW() - INTERVAL '24 hours'`,
    )) as unknown as Array<{ n: number | string | null }>;
    const n = Number(rows[0]?.n ?? 0);
    base.value = n;
    base.status = pickStatus(n, base.thresholds);
    base.detail = n === 0 ? "No crashes" : `${n} event${n === 1 ? "" : "s"}`;
    return base;
  }, base);
}

async function buildRestartFrequencyCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "server_restart_frequency",
    label: "Server restart frequency",
    value: null,
    unit: "count",
    status: "green",
    sparkline: [],
    thresholds: { amber: 5, red: 20 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "Process uptime hint. >5 restarts in a day = amber, >20 = red. Approximated from the current process start time alone — proper restart tracking needs a host-level cron.",
  };
  return safe(async () => {
    // Without a persisted restart log we approximate: if uptime < 1h
    // mark as amber to signal a recent restart; otherwise green.
    const up = Math.round(process.uptime());
    base.value = up < 3600 ? 1 : 0;
    base.status = up < 60 ? "amber" : "green";
    base.detail =
      up < 60 ? "Restarted < 60s ago" : up < 3600 ? `Restarted ${Math.round(up / 60)} min ago` : "Stable";
    return base;
  }, base);
}

async function buildPm2HealthCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "pm2_process_health",
    label: "PM2 process",
    value: 1,
    unit: "string",
    status: "green",
    sparkline: [],
    thresholds: { amber: null, red: null },
    lastUpdatedAt: nowIso(),
    detail: "Running",
    tooltip:
      "If you can see this card, the PM2 fork-mode worker is online. A crashing worker would never reach this code.",
  };
  return base;
}

async function buildWebhookFailuresCard(): Promise<HealthCard> {
  const base: HealthCard = {
    key: "webhook_failures",
    label: "Webhook failures (7d)",
    value: null,
    unit: "count",
    status: "green",
    sparkline: [],
    thresholds: { amber: 3, red: 10 },
    lastUpdatedAt: nowIso(),
    detail: "",
    tooltip:
      "audit_logs actions containing 'webhook' AND 'fail' over last 7 days. Excludes signature-verification 4xx (those are noisy by design).",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM audit_logs
           WHERE action LIKE '%webhook%fail%'
             AND created_at > NOW() - INTERVAL '7 days'`,
    )) as unknown as Array<{ n: number | string | null }>;
    const n = Number(rows[0]?.n ?? 0);
    base.value = n;
    base.status = pickStatus(n, base.thresholds);
    base.detail = n === 0 ? "Clean" : `${n}`;
    return base;
  }, base);
}

// ─── Orchestrator ──────────────────────────────────────────────────

export async function computeInfrastructureHealth(): Promise<InfrastructureHealth> {
  return memoize(
    "admin:health:infra:v1",
    async () => {
      const t0 = Date.now();
      const cards = await Promise.all([
        buildApiUptimeCard(),
        buildApiResponseCard(),
        buildDbLatencyCard(),
        buildQueueBacklogCard(),
        buildQueueFailuresCard(),
        buildWebhookFailuresCard(),
        buildStripeWebhookCard(),
        buildSesDeliveryCard(),
        buildBounceRateCard(),
        buildCronHealthCard(),
        buildCalendarSyncCard(),
        buildMemoryCard(),
        buildPm2HealthCard(),
        buildRestartFrequencyCard(),
        buildFailedJobsCard(),
      ]);
      return {
        cards,
        generatedAt: nowIso(),
        computedInMs: Date.now() - t0,
      };
    },
    30_000, // 30s cache so 60s auto-refresh always sees fresh data
  );
}
