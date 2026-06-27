-- 0079_business_phone_staff_identity.sql
-- ZentroMeet Business Phone — PER-STAFF phone identity (P1.1).
--
-- Increment P1.1 of the proper Phone module. P1.0's outbound bridge rings the
-- tenant's single forwarding number; for a real multi-user Phone app each staff
-- member needs their OWN bridge phone (the number ZentroMeet rings first before
-- dialing the customer). This migration adds ONE additive table for that staff
-- identity. The tenant forwarding number stays as a fallback (P1.0/pilot
-- compatibility) — nothing here changes or removes it.
--
-- Still engine-only: no UI, no WebRTC, no SMS/recording/voicemail/IVR. The
-- staff's personal number is NEVER presented as caller ID — the customer leg
-- always shows the tenant business number (see lib/business-line-bridge.ts).
--
-- PURELY ADDITIVE + IDEMPOTENT + NON-DESTRUCTIVE:
--   • Only CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--   • No ALTER/DROP of any existing table, no backfill, no data writes.
--   • Safe to re-apply. No existing feature is affected.
--   • Apply via raw psql in filename order (the drizzle journal is frozen):
--       for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
--   • NOT executed against production in this increment.

BEGIN;

-- ─── tenant_phone_users ─────────────────────────────────────────────
-- A staff member's Business Phone identity within a tenant. Optional and
-- tenant-scoped: a user may have at most one row per tenant (unique). MVP uses
-- bridge_phone_number as leg-1 (the phone we ring first); can_receive_calls is
-- reserved for a later inbound/softphone phase and unused in P1.1.
CREATE TABLE IF NOT EXISTS tenant_phone_users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  -- E.164 staff phone we ring first before bridging to the customer. NULLABLE:
  -- a row can exist (access granted) before the staff sets their number.
  bridge_phone_number  varchar(40),
  -- Master per-staff switch for Business Phone participation.
  enabled              boolean NOT NULL DEFAULT true,
  -- Outbound permission (admin-controlled). A disabled staff cannot place calls
  -- even if a number is set.
  can_place_calls      boolean NOT NULL DEFAULT true,
  -- Reserved for a later inbound/softphone phase. Unused in P1.1.
  can_receive_calls    boolean NOT NULL DEFAULT false,
  metadata             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- At most one Business Phone identity per (tenant, user).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_phone_users_tenant_user_unique
  ON tenant_phone_users (tenant_id, user_id);
-- Reverse lookup (a user across tenants is rare, but keep admin listing cheap).
CREATE INDEX IF NOT EXISTS tenant_phone_users_user_idx
  ON tenant_phone_users (user_id);

COMMIT;
