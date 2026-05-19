-- 0029 — Enterprise compliance + data governance. STRICTLY ADDITIVE.
--
-- New tables:
--   * tenant_governance_settings — one row per tenant, all retention
--     fields nullable. NULL = disabled = preserve current behavior
--     (no automatic deletion). Operators must explicitly opt in.
--   * export_audit_events — append-only log of every CSV/data export
--     performed by a user. Used for compliance reporting and to
--     surface anomalous export volume.
--
-- No existing column/table altered. No existing row rewritten.
-- Default behavior of the platform UNCHANGED until a tenant edits
-- its governance settings.

BEGIN;

-- ─── tenant_governance_settings ─────────────────────────────────────
-- One row per tenant. All retention columns are NULLABLE — null means
-- "no automatic pruning" (current behavior). Password / login policy
-- columns have safe-default values that match what's already enforced
-- in code today (min 10 char password, 10 logins/min rate limit).
CREATE TABLE IF NOT EXISTS tenant_governance_settings (
  tenant_id                       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  -- Retention windows (days). NULL = retain forever. Hard floor for
  -- audit_logs + export_audit_events is enforced in code (lib/governance
  -- /retention.ts) to keep compliance-grade records.
  audit_retention_days            integer,
  session_event_retention_days    integer,
  reset_token_retention_days      integer,
  analytics_retention_days        integer,
  export_audit_retention_days     integer,

  -- Password policy. Defaults match the platform's existing minimums
  -- (lib/security/passwordReset enforces 10-char minimum already).
  password_min_length             integer NOT NULL DEFAULT 10,
  password_require_uppercase      boolean NOT NULL DEFAULT false,
  password_require_lowercase      boolean NOT NULL DEFAULT false,
  password_require_digit          boolean NOT NULL DEFAULT false,
  password_require_symbol         boolean NOT NULL DEFAULT false,
  -- 0 = disabled (don't force resets). Range: 0 or 30..365.
  password_max_age_days           integer NOT NULL DEFAULT 0,

  -- Session policy. 0 = use platform default (7 days). Range: 0 or 1..30.
  session_max_age_days            integer NOT NULL DEFAULT 0,
  -- "low" | "medium" | "high" — controls how aggressively
  -- evaluateLoginSuspicion flags. Today the heuristic is fixed at
  -- "medium"; this is a hook for future per-tenant tuning.
  suspicious_login_sensitivity    varchar(10) NOT NULL DEFAULT 'medium',

  -- Allow-list (optional). NULL = no restriction. JSONB array of CIDR
  -- strings. Enforcement is opt-in and lives in a future middleware;
  -- this column is the documented storage today.
  allowed_login_ips               jsonb,

  -- Export restrictions. When true, only users with canExportReports
  -- can hit export endpoints (already gated). Reserved for future
  -- per-role overrides ("managers can export but only daily").
  restrict_exports                boolean NOT NULL DEFAULT false,
  -- Cap export row count. NULL = no cap. Operators can prevent
  -- runaway extracts.
  max_export_rows                 integer,

  -- Automation approval — when true, automation rule changes require
  -- a second admin to approve. Reserved for future workflow; this
  -- column is the documented storage today.
  require_automation_approval     boolean NOT NULL DEFAULT false,

  updated_by_user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  -- Sanity ranges so a bad admin input can't lock the workspace out.
  CONSTRAINT tgs_min_length_range CHECK (password_min_length BETWEEN 8 AND 128),
  CONSTRAINT tgs_max_age_range    CHECK (password_max_age_days = 0 OR password_max_age_days BETWEEN 30 AND 365),
  CONSTRAINT tgs_session_age_range CHECK (session_max_age_days = 0 OR session_max_age_days BETWEEN 1 AND 30),
  CONSTRAINT tgs_sensitivity_enum CHECK (suspicious_login_sensitivity IN ('low','medium','high'))
);
CREATE INDEX IF NOT EXISTS tgs_updated_idx ON tenant_governance_settings(updated_at);

-- ─── export_audit_events ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS export_audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Closed enum at app layer: analytics | analytics_executive |
  -- bookings | scheduled_reports | other
  export_type     varchar(40) NOT NULL,
  exported_at     timestamptz NOT NULL DEFAULT now(),
  record_count    integer,
  file_size_bytes integer,
  -- Free-form filters dict (range, status, etc.). Sanitized to a
  -- bounded jsonb at the call site.
  filters_used    jsonb NOT NULL DEFAULT '{}',
  ip_address      varchar(45),
  user_agent      text
);
CREATE INDEX IF NOT EXISTS eae_tenant_idx        ON export_audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS eae_user_idx          ON export_audit_events(user_id);
CREATE INDEX IF NOT EXISTS eae_type_idx          ON export_audit_events(export_type);
CREATE INDEX IF NOT EXISTS eae_exported_idx      ON export_audit_events(exported_at);
CREATE INDEX IF NOT EXISTS eae_tenant_time_idx   ON export_audit_events(tenant_id, exported_at DESC);

COMMIT;
