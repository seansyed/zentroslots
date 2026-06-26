-- 0077_business_line_foundation.sql
-- ZentroMeet Business Line (telephony) MVP — DATA FOUNDATION ONLY.
--
-- This is increment 1 of the Business Line feature: it lays down the additive
-- data layer (tables + indexes) and NOTHING else. No application code reads or
-- writes these tables yet; no Telnyx integration, no webhook routes, no UI, no
-- billing. The feature stays completely dark until later increments.
--
-- MVP scope encoded here:
--   • ONE platform-provisioned business phone number per tenant.
--   • A per-tenant forwarding number + enable/disable flag.
--   • Inbound call logs (status + duration).
--   • A raw Telnyx event table with an idempotency key.
--   • Monthly usage counters (for a hard-cap / graceful-disable, NOT overage
--     billing — pricing is a later increment).
--
-- Explicitly OUT of scope (no columns/tables for any of it): WebRTC/softphone,
-- call recording, AI summaries, SMS, dynamic per-meeting numbers,
-- IVR/queues/extensions, and "we call both parties" bridges.
--
-- PURELY ADDITIVE + IDEMPOTENT + NON-DESTRUCTIVE:
--   • Only CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--   • No ALTER/DROP of any existing table, no backfill, no data writes.
--   • Safe to re-apply. No existing feature is affected (nothing references
--     these tables yet).
--   • Apply via raw psql in filename order (the drizzle journal is frozen):
--       for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
--   • NOT executed against production in this increment.

BEGIN;

-- ─── tenant_phone_numbers ───────────────────────────────────────────
-- The business DID assigned to a tenant (platform-provisioned under
-- ZentroMeet's own Telnyx account). MVP allows exactly ONE *active* number
-- per tenant (enforced by a partial unique index below). A phone number
-- belongs to exactly one tenant (globally unique).
CREATE TABLE IF NOT EXISTS tenant_phone_numbers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Telnyx resource correlation (the number id + the voice connection /
  -- TeXML application it is bound to). Nullable while provisioning.
  telnyx_number_id     varchar(120),
  telnyx_connection_id varchar(120),
  phone_number         varchar(40) NOT NULL,           -- E.164, e.g. +14155552671
  -- 'provisioning' | 'active' | 'suspended' | 'released'
  status               varchar(20) NOT NULL DEFAULT 'provisioning',
  capabilities         jsonb,                          -- voice/sms flags snapshot from Telnyx
  metadata             jsonb,
  provisioned_at       timestamptz,
  released_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- A DID maps to exactly one tenant row.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_phone_numbers_phone_unique
  ON tenant_phone_numbers (phone_number);
-- MVP invariant: at most ONE active number per tenant. Partial unique index
-- lets a tenant keep historical 'released'/'suspended' rows without collision.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_phone_numbers_one_active_per_tenant
  ON tenant_phone_numbers (tenant_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS tenant_phone_numbers_tenant_idx
  ON tenant_phone_numbers (tenant_id);
CREATE INDEX IF NOT EXISTS tenant_phone_numbers_status_idx
  ON tenant_phone_numbers (status);

-- ─── tenant_phone_settings ──────────────────────────────────────────
-- The user-editable forwarding configuration. Exactly one row per tenant
-- (unique). forwarding_number is where inbound calls bridge to. The
-- included/cap minute fields are data-model defaults for the recommended
-- add-on package ($19/mo, 150–200 US/CA minutes, hard cap / graceful disable);
-- NO billing logic is implemented in this increment.
CREATE TABLE IF NOT EXISTS tenant_phone_settings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT true,
  forwarding_number    varchar(40),                    -- E.164 target for bridging
  -- Future use: forward to a specific staff member's phone. NULLABLE and
  -- unused in MVP (the users table has no phone column yet); MVP forwards via
  -- forwarding_number directly. ON DELETE SET NULL so deleting a staff user
  -- never breaks a tenant's line.
  forwarding_staff_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  included_minutes     integer NOT NULL DEFAULT 200,   -- package default
  monthly_minute_cap   integer NOT NULL DEFAULT 200,   -- hard cap (graceful disable)
  metadata             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_phone_settings_tenant_unique
  ON tenant_phone_settings (tenant_id);

-- ─── phone_call_logs ────────────────────────────────────────────────
-- One row per call. MVP records inbound calls only; `direction` future-proofs
-- outbound. Also serves as the per-call usage record (billable_seconds feeds
-- the monthly rollup). telnyx_call_session_id is the idempotent correlation
-- key for status-callback upserts.
CREATE TABLE IF NOT EXISTS phone_call_logs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The business number that was called. SET NULL if the number row is later
  -- released/deleted — we keep the historical call log.
  phone_number_id        uuid REFERENCES tenant_phone_numbers(id) ON DELETE SET NULL,
  direction              varchar(10) NOT NULL DEFAULT 'inbound',  -- 'inbound' (MVP)
  from_number            varchar(40),                  -- caller (E.164)
  to_number              varchar(40),                  -- the business number called
  forwarded_to_number    varchar(40),                  -- where we bridged, if any
  -- 'ringing' | 'answered' | 'completed' | 'missed' | 'failed' | 'rejected' | 'no_forwarding'
  status                 varchar(20) NOT NULL DEFAULT 'ringing',
  started_at             timestamptz,
  answered_at            timestamptz,
  ended_at               timestamptz,
  duration_seconds       integer,                      -- wall-clock leg duration
  billable_seconds       integer,                      -- rounded billing basis
  cost_estimate_cents    integer,                      -- placeholder estimate (no real billing)
  hangup_cause           varchar(60),
  telnyx_call_session_id varchar(255),
  telnyx_call_control_id varchar(255),
  telnyx_call_leg_id     varchar(255),
  metadata               jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- Idempotent upsert key. Partial (WHERE NOT NULL) so multiple rows that have
-- not yet been correlated to a Telnyx session don't collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS phone_call_logs_session_unique
  ON phone_call_logs (telnyx_call_session_id)
  WHERE telnyx_call_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_call_logs_tenant_started_idx
  ON phone_call_logs (tenant_id, started_at);
CREATE INDEX IF NOT EXISTS phone_call_logs_status_idx
  ON phone_call_logs (status);

-- ─── phone_call_events ──────────────────────────────────────────────
-- Raw Telnyx webhook events: forensic audit + idempotency. tenant_id is
-- NULLABLE because a malformed/unknown event may not resolve to a tenant.
-- telnyx_event_id is UNIQUE — Telnyx retries are deduped here (mirrors
-- tenant_payment_webhook_events).
CREATE TABLE IF NOT EXISTS phone_call_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid REFERENCES tenants(id) ON DELETE CASCADE,
  call_log_id            uuid REFERENCES phone_call_logs(id) ON DELETE SET NULL,
  telnyx_event_id        varchar(255) NOT NULL,
  event_type             varchar(60) NOT NULL,         -- 'call.initiated' | 'call.answered' | 'call.hangup' | ...
  signature_verified     boolean NOT NULL DEFAULT false,
  payload                jsonb,                        -- raw event, redacted of secrets
  signature_headers      jsonb,                        -- telnyx-signature-ed25519 / telnyx-timestamp
  processing_duration_ms integer,
  received_at            timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: dedup Telnyx retries on the event id.
CREATE UNIQUE INDEX IF NOT EXISTS phone_call_events_event_unique
  ON phone_call_events (telnyx_event_id);
CREATE INDEX IF NOT EXISTS phone_call_events_tenant_received_idx
  ON phone_call_events (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS phone_call_events_call_idx
  ON phone_call_events (call_log_id);

-- ─── phone_usage_monthly ────────────────────────────────────────────
-- Per-(tenant, month) rolled-up counters for cost control and the dashboard
-- "minutes used this month" display + hard-cap enforcement (later increment).
-- period is 'YYYY-MM'. One row per tenant per month (unique).
CREATE TABLE IF NOT EXISTS phone_usage_monthly (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period               varchar(7) NOT NULL,            -- 'YYYY-MM'
  inbound_calls        integer NOT NULL DEFAULT 0,
  answered_calls       integer NOT NULL DEFAULT 0,
  missed_calls         integer NOT NULL DEFAULT 0,
  billable_seconds     integer NOT NULL DEFAULT 0,
  included_minutes     integer,                        -- entitlement snapshot for the month
  estimated_cost_cents integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS phone_usage_monthly_tenant_period_unique
  ON phone_usage_monthly (tenant_id, period);

COMMIT;
