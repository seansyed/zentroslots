-- 0027 — Scheduled executive reports.
--
-- Strictly additive. One row per (tenant, period_type, period_start).
-- Body is a jsonb snapshot of the KPI summary computed at generation
-- time — so admins can scroll back to "May's report" without recomputing
-- (analytics data may have shifted in the meantime).
--
-- The cron worker UPSERTs by (tenant_id, period_type, period_start) so
-- re-running the worker for the same period overwrites with the latest
-- numbers. Email delivery is deferred — for now the report body is
-- visible via GET /api/tenant/scheduled-reports.
BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'daily' | 'weekly' | 'monthly'
  period_type     varchar(20) NOT NULL,
  -- The start of the period this report covers (UTC date).
  period_start    date NOT NULL,
  -- Inclusive end of the period.
  period_end      date NOT NULL,
  -- KPI body — see lib/analytics/scheduledReports.ts for the closed shape.
  body            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Latency captured at generation time — feeds /api/health metrics.
  generation_ms   integer,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_reports_tenant_idx
  ON scheduled_reports(tenant_id);
CREATE INDEX IF NOT EXISTS scheduled_reports_period_idx
  ON scheduled_reports(tenant_id, period_type, period_start);

-- Idempotent regeneration: one row per (tenant, type, start).
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_reports_unique
  ON scheduled_reports(tenant_id, period_type, period_start);

COMMIT;
