-- 0022 — Review requests + follow-up automations + pending queue.
--
-- Strictly additive. Without rows in either rule table, the booking
-- status flow (mark completed / no_show) is byte-identical to before
-- this feature shipped (rule #12). The orchestrators are only invoked
-- when a matching enabled rule exists.
--
-- Three tables:
--   review_request_rules     — per-service config for "send a review
--                              request" automation
--   followup_automation_rules — generic post-event follow-ups, can be
--                               attached to a custom template
--   pending_automations       — cron-scanned delayed-send queue.
--                               Rows are enqueued by booking status
--                               flips and drained by scripts/run-
--                               automations.ts (sibling to send-
--                               reminders cron).
--
-- Idempotency for actual delivery is enforced at communication_logs
-- (existing partial unique index on tenant/booking/event/channel where
-- status='sent'). The pending queue's status field tracks lifecycle
-- only — it's not the source of truth for "did we send".
BEGIN;

CREATE TABLE IF NOT EXISTS review_request_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id          uuid REFERENCES services(id) ON DELETE CASCADE,
  enabled             boolean NOT NULL DEFAULT true,
  delay_minutes       integer NOT NULL DEFAULT 60,
  -- 'google' | 'yelp' | 'facebook' | 'custom'
  review_platform     varchar(20) NOT NULL DEFAULT 'google',
  review_url          text,
  suppress_if_cancelled boolean NOT NULL DEFAULT true,
  suppress_if_no_show   boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_request_rules_tenant_idx
  ON review_request_rules(tenant_id);
CREATE INDEX IF NOT EXISTS review_request_rules_service_idx
  ON review_request_rules(service_id);
-- One rule per scope bucket per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS review_request_rules_service_unique
  ON review_request_rules(tenant_id, service_id)
  WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS review_request_rules_default_unique
  ON review_request_rules(tenant_id)
  WHERE service_id IS NULL;

CREATE TABLE IF NOT EXISTS followup_automation_rules (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id                  uuid REFERENCES services(id) ON DELETE CASCADE,
  enabled                     boolean NOT NULL DEFAULT true,
  -- 'appointment.completed' | 'appointment.cancelled'
  -- | 'appointment.no_show' | 'appointment.followup_due'
  trigger_event               varchar(60) NOT NULL,
  delay_minutes               integer NOT NULL DEFAULT 0,
  -- Optional pointer to a customized template — if NULL, the engine
  -- falls back to the system 'followup' template starter.
  template_id                 uuid REFERENCES communication_templates(id) ON DELETE SET NULL,
  -- Conditional execution flags. Evaluated at queue-drain time, NOT at
  -- enqueue time, so a "first time" condition stays accurate even if
  -- the customer books their second appointment between flip and send.
  only_first_time_customers   boolean NOT NULL DEFAULT false,
  only_completed_bookings     boolean NOT NULL DEFAULT false,
  require_successful_payment  boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followup_automation_rules_tenant_idx
  ON followup_automation_rules(tenant_id);
CREATE INDEX IF NOT EXISTS followup_automation_rules_service_idx
  ON followup_automation_rules(service_id);
CREATE INDEX IF NOT EXISTS followup_automation_rules_event_idx
  ON followup_automation_rules(tenant_id, trigger_event);
-- One rule per (scope, event) bucket. Multiple followups for the same
-- event but different services are allowed; the orchestrator picks
-- the most specific.
CREATE UNIQUE INDEX IF NOT EXISTS followup_rules_service_event_unique
  ON followup_automation_rules(tenant_id, service_id, trigger_event)
  WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS followup_rules_default_event_unique
  ON followup_automation_rules(tenant_id, trigger_event)
  WHERE service_id IS NULL;

CREATE TABLE IF NOT EXISTS pending_automations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Not an FK — log survives booking soft-deletes.
  booking_id          uuid NOT NULL,
  -- Which AutomationEvent (string mirrors the closed TS union).
  event_type          varchar(60) NOT NULL,
  -- 'review_request' | 'followup' — points at which rule produced this
  -- row, so the worker knows which rule to re-evaluate at drain time.
  rule_kind           varchar(20) NOT NULL,
  rule_id             uuid,
  due_at              timestamptz NOT NULL,
  -- 'pending' | 'processing' | 'done' | 'skipped' | 'failed'
  status              varchar(20) NOT NULL DEFAULT 'pending',
  -- Worker writes a short reason when it skips or fails.
  reason              varchar(60),
  attempts            integer NOT NULL DEFAULT 0,
  last_attempt_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_automations_due_idx
  ON pending_automations(due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pending_automations_tenant_idx
  ON pending_automations(tenant_id);
CREATE INDEX IF NOT EXISTS pending_automations_booking_idx
  ON pending_automations(booking_id);
-- Idempotent enqueue: never queue the same (booking, event_type) twice
-- when one is still pending. Cancelled / done / failed states can
-- coexist with a new pending row (for legitimate retries).
CREATE UNIQUE INDEX IF NOT EXISTS pending_automations_unique_pending
  ON pending_automations(booking_id, event_type)
  WHERE status IN ('pending', 'processing');

COMMIT;
