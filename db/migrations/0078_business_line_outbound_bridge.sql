-- 0078_business_line_outbound_bridge.sql
-- ZentroMeet Business Phone — OUTBOUND BRIDGE correlation columns (P1.0).
--
-- Increment P1.0 of the proper Phone module (hybrid path, Phase 1 = bridge):
-- staff taps "Call", ZentroMeet calls the staff's phone, then dials the
-- customer presenting the tenant's business number as caller ID, and bridges
-- the two legs. This migration only adds the additive columns the outbound
-- call log needs to attribute a bridged call (who placed it, which customer,
-- why, and the parent leg for two-leg correlation). NOTHING here forwards or
-- places a call; the engine stays dark/pilot-only behind the existing flag.
--
-- PURELY ADDITIVE + IDEMPOTENT + NON-DESTRUCTIVE:
--   • Only ALTER TABLE ... ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--   • No DROP, no type change, no backfill, no data writes.
--   • Safe to re-apply. Existing inbound forwarding rows are unaffected (the new
--     columns are nullable and default NULL).
--   • Apply via raw psql in filename order (the drizzle journal is frozen):
--       for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
--   • NOT executed against production in this increment.

BEGIN;

-- ─── phone_call_logs: outbound-bridge attribution ───────────────────
-- All nullable; only outbound bridge calls populate them. Inbound rows keep
-- NULL. FKs are SET NULL on delete so historical call logs survive deleting a
-- staff user / customer / parent leg.
ALTER TABLE phone_call_logs
  ADD COLUMN IF NOT EXISTS placed_by_user_id  uuid REFERENCES users(id)           ON DELETE SET NULL;
ALTER TABLE phone_call_logs
  ADD COLUMN IF NOT EXISTS customer_id        uuid REFERENCES customers(id)       ON DELETE SET NULL;
-- 'new_call' | 'callback_missed' | 'customer_call' (free-form, validated in app)
ALTER TABLE phone_call_logs
  ADD COLUMN IF NOT EXISTS call_purpose       varchar(40);
-- Self-reference: the customer leg can point back at the staff leg (or vice
-- versa) so a bridged call's two legs correlate. Nullable; single-leg / inbound
-- rows leave it NULL.
ALTER TABLE phone_call_logs
  ADD COLUMN IF NOT EXISTS parent_call_log_id uuid REFERENCES phone_call_logs(id) ON DELETE SET NULL;

-- Sparse lookups (only outbound bridge rows set these) → partial indexes.
CREATE INDEX IF NOT EXISTS phone_call_logs_customer_idx
  ON phone_call_logs (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS phone_call_logs_parent_idx
  ON phone_call_logs (parent_call_log_id) WHERE parent_call_log_id IS NOT NULL;

COMMIT;
