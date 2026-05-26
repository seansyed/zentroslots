-- Stabilization Wave — cron_runs table.
--
-- Records every cron tick (start + end) so the operator diagnostics
-- panel + /api/health can answer "when did X last run, and did it
-- succeed?" without depending on log scraping.
--
-- Each row is upserted on the natural key (job_name, started_at)
-- so a re-running cron writes one row per execution. The retention
-- script keeps 30 days; older rows are pruned by the same retention
-- pass that handles snapshots.
--
-- Indexes:
--   - PRIMARY KEY (id)              random uuid
--   - (job_name, started_at DESC)   "last run for job X" lookup
--   - (status, started_at DESC)     "find all failed runs in window"

CREATE TABLE IF NOT EXISTS cron_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name      varchar(80) NOT NULL,            -- e.g. 'holds:expire'
  started_at    timestamptz NOT NULL DEFAULT NOW(),
  finished_at   timestamptz,
  duration_ms   integer,                         -- finished_at - started_at
  status        varchar(20) NOT NULL DEFAULT 'running',  -- running|ok|failed
  -- Free-form structured detail: candidates/processed/failed counts,
  -- error message on failure, etc. Never includes secrets or
  -- tenant-identifying data beyond ids.
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  host          varchar(120),                    -- hostname for multi-worker visibility
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cron_runs_job_started_idx
  ON cron_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS cron_runs_status_started_idx
  ON cron_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS cron_runs_started_desc_idx
  ON cron_runs(started_at DESC);

-- Stabilization Wave audit finding (P6) — bookings lacks a composite
-- (tenant_id, start_at) index. The existing bookings_tenant_idx and
-- bookings_staff_start_idx serve their narrow lookups but the most
-- common cross-tenant admin query ("all bookings in tenant X within
-- date range Y") falls through to a full scan + filter. Add the
-- composite to make tenant-scoped time-range scans index-only.
CREATE INDEX IF NOT EXISTS bookings_tenant_start_idx
  ON bookings(tenant_id, start_at);

SELECT 1 AS stab_cron_runs_migration_applied;
