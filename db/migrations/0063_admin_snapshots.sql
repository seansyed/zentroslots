-- SA-10 — Super-admin analytics snapshot infrastructure.
--
-- Four tables aggregating expensive cross-tenant analytics into
-- pre-computed rows that the super-admin dashboard can read in
-- O(1) instead of re-scanning the source tables every page load.
--
-- Cron worker: scripts/aggregate-admin-snapshots.ts
--   - daily   (recommended cadence: every 60min)
--   - hourly  (recommended cadence: every 10min)
--   - tenant  (recommended cadence: every 30min)
--   - finance (recommended cadence: every 15min)
--
-- Retention policy:
--   - analytics_snapshots_daily   : 730 days (~2 years for trend rollups)
--   - analytics_snapshots_hourly  : 90 days  (drop after quarter)
--   - tenant_health_snapshots     : 365 days
--   - financial_snapshots         : 730 days
--
-- All four tables are upsert-friendly via the natural keys
-- (snapshot_date, snapshot_hour, tenant_id) — the aggregator
-- runs DELETE+INSERT for the current period each tick.

-- ─── analytics_snapshots_daily ───────────────────────────────────
-- One row per calendar day. Holds the headline KPIs we want to
-- chart across weeks/months/years without re-scanning bookings.

CREATE TABLE IF NOT EXISTS analytics_snapshots_daily (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date        date NOT NULL,
  total_tenants        integer NOT NULL DEFAULT 0,
  active_tenants       integer NOT NULL DEFAULT 0,
  paying_tenants       integer NOT NULL DEFAULT 0,
  new_tenants          integer NOT NULL DEFAULT 0,
  churned_tenants      integer NOT NULL DEFAULT 0,
  total_bookings       integer NOT NULL DEFAULT 0,
  bookings_completed   integer NOT NULL DEFAULT 0,
  bookings_no_show     integer NOT NULL DEFAULT 0,
  total_users          integer NOT NULL DEFAULT 0,
  new_users            integer NOT NULL DEFAULT 0,
  active_users_dau     integer NOT NULL DEFAULT 0,
  /* Revenue */
  mrr_cents            bigint NOT NULL DEFAULT 0,
  arr_cents            bigint NOT NULL DEFAULT 0,
  gross_revenue_cents  bigint NOT NULL DEFAULT 0,
  refunds_cents        bigint NOT NULL DEFAULT 0,
  failed_charges       integer NOT NULL DEFAULT 0,
  /* Communications */
  emails_sent          integer NOT NULL DEFAULT 0,
  emails_failed        integer NOT NULL DEFAULT 0,
  sms_sent             integer NOT NULL DEFAULT 0,
  /* Security */
  failed_logins        integer NOT NULL DEFAULT 0,
  admin_actions        integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_snapshots_daily_date_unique
  ON analytics_snapshots_daily(snapshot_date);
CREATE INDEX IF NOT EXISTS analytics_snapshots_daily_date_desc_idx
  ON analytics_snapshots_daily(snapshot_date DESC);

-- ─── analytics_snapshots_hourly ──────────────────────────────────
-- Hourly grain for the last 90 days. Drives the intraday charts
-- on /admin/activity and the system-health dashboard.

CREATE TABLE IF NOT EXISTS analytics_snapshots_hourly (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_hour        timestamptz NOT NULL,  -- truncated to hour
  bookings             integer NOT NULL DEFAULT 0,
  signups              integer NOT NULL DEFAULT 0,
  logins               integer NOT NULL DEFAULT 0,
  failed_logins        integer NOT NULL DEFAULT 0,
  emails_sent          integer NOT NULL DEFAULT 0,
  emails_failed        integer NOT NULL DEFAULT 0,
  webhook_events       integer NOT NULL DEFAULT 0,
  webhook_failures     integer NOT NULL DEFAULT 0,
  errors_total         integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_snapshots_hourly_hour_unique
  ON analytics_snapshots_hourly(snapshot_hour);
CREATE INDEX IF NOT EXISTS analytics_snapshots_hourly_hour_desc_idx
  ON analytics_snapshots_hourly(snapshot_hour DESC);

-- ─── tenant_health_snapshots ─────────────────────────────────────
-- Per-tenant rollup so the Tenant Intelligence Grid (SA-4) can sort
-- by health/risk without re-running the scoring functions on every
-- page load.

CREATE TABLE IF NOT EXISTS tenant_health_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date        date NOT NULL,
  health_score         integer NOT NULL,            -- 0..100
  risk_level           varchar(20) NOT NULL,        -- low|medium|high|critical
  mrr_cents            bigint NOT NULL DEFAULT 0,
  bookings_30d         integer NOT NULL DEFAULT 0,
  bookings_growth_pct  numeric(8,2),
  failed_logins_7d     integer NOT NULL DEFAULT 0,
  failed_charges_30d   integer NOT NULL DEFAULT 0,
  last_activity_at     timestamptz,
  notes                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_health_snapshots_tenant_date_unique
  ON tenant_health_snapshots(tenant_id, snapshot_date);
CREATE INDEX IF NOT EXISTS tenant_health_snapshots_risk_idx
  ON tenant_health_snapshots(risk_level, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS tenant_health_snapshots_date_desc_idx
  ON tenant_health_snapshots(snapshot_date DESC);

-- ─── financial_snapshots ─────────────────────────────────────────
-- Daily financial roll-up — separate from analytics_snapshots_daily
-- so we can keep finer-grained breakdowns (per plan, per gateway)
-- without bloating the headline daily row. Drives /admin/finance
-- when running in snapshot-backed mode.

CREATE TABLE IF NOT EXISTS financial_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date               date NOT NULL,
  plan                        varchar(40) NOT NULL,        -- 'free' | 'pro' | 'business' | etc.
  active_subscriptions        integer NOT NULL DEFAULT 0,
  new_subscriptions           integer NOT NULL DEFAULT 0,
  cancelled_subscriptions     integer NOT NULL DEFAULT 0,
  mrr_cents                   bigint NOT NULL DEFAULT 0,
  gross_revenue_cents         bigint NOT NULL DEFAULT 0,
  refunds_cents               bigint NOT NULL DEFAULT 0,
  net_revenue_cents           bigint NOT NULL DEFAULT 0,
  failed_charges              integer NOT NULL DEFAULT 0,
  dunning_active              integer NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_snapshots_date_plan_unique
  ON financial_snapshots(snapshot_date, plan);
CREATE INDEX IF NOT EXISTS financial_snapshots_date_desc_idx
  ON financial_snapshots(snapshot_date DESC);

-- ─── Retention helpers ───────────────────────────────────────────
-- The retention deletes are applied by scripts/aggregate-admin-snapshots.ts
-- after each successful aggregation pass. These are NOT
-- pg_partman partitioned tables — at our volumes the simple delete
-- is fast enough and avoids the operational surface area of
-- partitioning. Revisit if rows-per-table > 5M.

-- Verify migration is fully applied (no-op SELECT; the migration
-- runner picks up the file by path, not by this marker).
SELECT 1 AS sa10_snapshots_migration_applied;
