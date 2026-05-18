-- 0017 — Centralized communication engine.
--
-- Strictly additive. Three tables wire together as:
--   automation_rules  --(template_id)-->  communication_templates
--   communication_logs records every send attempt (idempotency live at DB level)
--
-- Backward compat: no rows seeded. Engine falls back to baked-in
-- system templates (lib/email.ts renderers) when no row exists for a
-- tenant. Existing tenants see zero behavior change until they
-- explicitly customize a template.
BEGIN;

CREATE TABLE IF NOT EXISTS communication_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = tenant-wide default. Non-null = service-level override.
  service_id      uuid REFERENCES services(id) ON DELETE CASCADE,
  -- Canonical scheduling kinds: 'booking_confirmation', 'booking_cancelled',
  -- 'booking_rescheduled', 'reminder_24h', 'reminder_1h'. Plain text so
  -- new kinds don't require a migration (engine maps eventType->kind).
  template_type   varchar(60) NOT NULL,
  -- 'email' for now; SMS reserved.
  channel         varchar(20) NOT NULL DEFAULT 'email',
  subject         varchar(500),
  html_content    text,
  text_content    text,
  enabled         boolean NOT NULL DEFAULT true,
  -- Marks rows seeded by us (none today; reserved for future seed flow).
  system_default  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comm_templates_tenant_idx ON communication_templates(tenant_id);
-- A tenant gets at most one tenant-wide template per (type, channel).
CREATE UNIQUE INDEX IF NOT EXISTS comm_templates_tenant_type_unique
  ON communication_templates(tenant_id, template_type, channel)
  WHERE service_id IS NULL;
-- And at most one service-level override per (service, type, channel).
CREATE UNIQUE INDEX IF NOT EXISTS comm_templates_service_type_unique
  ON communication_templates(tenant_id, service_id, template_type, channel)
  WHERE service_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE CASCADE,
  -- Canonical event names: 'appointment.created', 'appointment.cancelled',
  -- 'appointment.rescheduled', 'appointment.reminder_24h', etc.
  trigger_event   varchar(60) NOT NULL,
  -- 0 only honored today; delay-based scheduling requires a queue
  -- (deliberately out of scope per task rules). Column reserved.
  delay_minutes   integer NOT NULL DEFAULT 0,
  channel         varchar(20) NOT NULL DEFAULT 'email',
  template_id     uuid REFERENCES communication_templates(id) ON DELETE SET NULL,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_rules_tenant_idx ON automation_rules(tenant_id);
CREATE INDEX IF NOT EXISTS automation_rules_trigger_idx
  ON automation_rules(tenant_id, trigger_event);

CREATE TABLE IF NOT EXISTS communication_logs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Not an FK: we want logs to survive booking soft-deletes / status
  -- changes. Cancelled bookings still have a delivery history.
  booking_id          uuid,
  customer_id         uuid,
  template_id         uuid,
  channel             varchar(20) NOT NULL,
  event_type          varchar(60) NOT NULL,
  -- 'sent' | 'failed' | 'skipped' | 'suppressed'
  -- (queued/delivered reserved for future provider webhook integration)
  status              varchar(20) NOT NULL,
  provider            varchar(40),
  provider_message_id varchar(255),
  failure_reason      text,
  skipped_reason      varchar(60),
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comm_logs_tenant_idx ON communication_logs(tenant_id);
CREATE INDEX IF NOT EXISTS comm_logs_booking_idx ON communication_logs(booking_id);
CREATE INDEX IF NOT EXISTS comm_logs_event_idx ON communication_logs(tenant_id, event_type);
CREATE INDEX IF NOT EXISTS comm_logs_status_idx ON communication_logs(status);
-- DB-level idempotency: at most ONE successful row per
-- (tenant, booking, event, channel). Partial unique index so failed/
-- skipped rows can coexist for the same event (retries + reasons).
-- Engine catches the 23505 to short-circuit duplicate attempts.
CREATE UNIQUE INDEX IF NOT EXISTS comm_logs_unique_success
  ON communication_logs(tenant_id, booking_id, event_type, channel)
  WHERE status = 'sent' AND booking_id IS NOT NULL;

COMMIT;
