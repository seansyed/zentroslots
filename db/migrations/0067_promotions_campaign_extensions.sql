-- Promotions, Coupons & Growth Campaign Intelligence Wave.
--
-- Extends the existing `promotions` table with campaign-grade
-- columns. ALL additions are NULLABLE — existing promo rows
-- continue to work unmodified; the API + UI can opt into the new
-- columns as features ship.
--
-- We do NOT widen the `kind` enum at the DB level (it's already a
-- varchar(20) so new values like 'free_month' / 'seat_expansion' /
-- 'referral' / 'winback' / 'seasonal' insert as-is). The zod
-- validator in the API route is the source of truth for accepted
-- kinds.

-- ─── Lifecycle status (explicit, alongside derived `active`) ──────
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active';

-- Backfill: existing rows get 'active' if active=true and not expired,
-- 'expired' otherwise. The default above lands 'active' on any rows
-- newly inserted by older code that doesn't set status.
UPDATE promotions
   SET status = CASE
     WHEN active = false THEN 'archived'
     WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 'expired'
     WHEN starts_at IS NOT NULL AND starts_at > NOW() THEN 'scheduled'
     ELSE 'active'
   END
 WHERE status = 'active'; -- only touch defaulted rows; explicit values preserved

-- ─── Stripe campaign mapping ──────────────────────────────────────
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS stripe_coupon_id varchar(120),
  ADD COLUMN IF NOT EXISTS stripe_promotion_code_id varchar(120);

-- ─── Multi-plan targeting ─────────────────────────────────────────
-- jsonb array of plan slugs. NULL or empty array = applies to all.
-- The existing single-plan `applies_to_plan` column is preserved
-- for back-compat; the API will write to BOTH (applies_to_plan
-- mirrors target_plans[0]) until callers migrate.
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS target_plans jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ─── Campaign metadata ────────────────────────────────────────────
-- Free-form jsonb for campaign hypothesis, attribution channel,
-- referral source, internal notes. Never includes PII.
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ─── Audit trail ──────────────────────────────────────────────────
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

-- ─── Indexes for the campaign center queries ─────────────────────
CREATE INDEX IF NOT EXISTS promotions_status_idx ON promotions(status);
CREATE INDEX IF NOT EXISTS promotions_created_at_desc_idx ON promotions(created_at DESC);

SELECT 1 AS promotions_campaign_extensions_applied;
