-- Phase 1C — Push Delivery Infrastructure (2026-05-27).
--
-- Two tables, both additive + safe to re-apply (IF NOT EXISTS).
--
--   push_tokens     — one row per (user, device). UPSERT on conflict.
--   push_deliveries — outbox queue + delivery audit log.
--
-- No existing table is touched.

-- ─── push_tokens ────────────────────────────────────────────────────
-- One row per (user_id, expo_token). Phone users sign in on multiple
-- devices, so user_id is NOT unique by itself — we key by
-- (user_id, expo_token).
CREATE TABLE IF NOT EXISTS push_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expo_token    varchar(200) NOT NULL,
  platform      varchar(10),   -- 'ios' | 'android' | 'web'
  device_label  varchar(120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz   -- last successful delivery
);

CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_user_token_uniq
  ON push_tokens (user_id, expo_token);

-- Tenant-scoped lookups when the sender worker enumerates devices
-- for a booking event.
CREATE INDEX IF NOT EXISTS push_tokens_tenant_idx
  ON push_tokens (tenant_id);

-- Sender worker uses `WHERE expo_token = …` lookups to invalidate a
-- token after a permanent Expo failure (DeviceNotRegistered).
CREATE INDEX IF NOT EXISTS push_tokens_token_idx
  ON push_tokens (expo_token);

-- ─── push_deliveries ────────────────────────────────────────────────
-- Outbox + audit log. Enqueued from booking lifecycle endpoints,
-- consumed by scripts/run-push-deliveries.ts every minute.
--
-- Status state machine:
--   pending → sent      (Expo accepted; receipt fetched async — out of
--                        scope for 1C, ok marker is enough)
--   pending → failed    (4xx / DeviceNotRegistered → token invalidated)
--   pending → expired   (giveup after N retries)
CREATE TABLE IF NOT EXISTS push_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Denormalized for delivery — token may rotate while delivery is
  -- pending; we capture the snapshot at enqueue time.
  expo_token    varchar(200) NOT NULL,
  event_type    varchar(40) NOT NULL,  -- booking_created | booking_reminder | booking_cancelled | booking_rescheduled
  booking_id    uuid REFERENCES bookings(id) ON DELETE SET NULL,
  title         varchar(200) NOT NULL,
  body          varchar(500) NOT NULL,
  data_payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        varchar(20) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error    text,
  expo_receipt_id varchar(80),  -- captured if Expo returns one
  created_at    timestamptz NOT NULL DEFAULT now(),
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  finalized_at  timestamptz
);

-- Worker picks rows up by (status, next_retry_at) for the polling loop.
CREATE INDEX IF NOT EXISTS push_deliveries_pending_idx
  ON push_deliveries (status, next_retry_at)
  WHERE status = 'pending';

-- Tenant audit + per-booking lookups for debug.
CREATE INDEX IF NOT EXISTS push_deliveries_tenant_idx
  ON push_deliveries (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS push_deliveries_booking_idx
  ON push_deliveries (booking_id);
