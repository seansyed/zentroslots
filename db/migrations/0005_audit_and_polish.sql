-- 0005_audit_and_polish.sql
-- Audit log table + a couple of read-path indexes.
-- Additive only. EXCLUDE constraint untouched.

BEGIN;

-- 1. audit_logs ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label     varchar(120),
  action          varchar(80) NOT NULL,
  entity_type     varchar(40),
  entity_id       uuid,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address      varchar(45),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_time_idx
  ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx
  ON audit_logs (action);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
  ON audit_logs (entity_type, entity_id);

-- 2. Hot-path coverage indexes (best-effort; CREATE INDEX IF NOT EXISTS) -

CREATE INDEX IF NOT EXISTS bookings_tenant_created_idx
  ON bookings (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bookings_tenant_status_start_idx
  ON bookings (tenant_id, status, start_at DESC);

-- 3. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;
