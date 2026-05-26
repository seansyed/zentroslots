-- Announcements, Messaging & Customer Communications Wave.
--
-- Extends the existing `announcements` table with campaign-grade
-- columns. ALL additions are NULLABLE / have safe defaults — every
-- existing row continues to work unmodified and the existing
-- /api/admin/announcements POST contract is honored (additive fields
-- ignored when not provided).
--
-- The base columns (title, body, severity, audience, link_*, expires_at,
-- active, published_at, created_at) are preserved.

-- ─── Lifecycle status (alongside derived `active`) ────────────────
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active';

-- Backfill: classify existing rows. Default 'active' for active rows,
-- 'expired' / 'scheduled' / 'archived' based on dates + active flag.
UPDATE announcements
   SET status = CASE
     WHEN active = false THEN 'archived'
     WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 'expired'
     WHEN published_at > NOW() THEN 'scheduled'
     ELSE 'active'
   END
 WHERE status = 'active'; -- only touch defaulted rows

-- ─── Announcement kind (operational classification) ───────────────
-- 'general' (default) — generic platform announcement
-- 'maintenance'      — scheduled maintenance window
-- 'release'          — product release notes
-- 'engagement'       — feature awareness / activation nudge
-- 'operational'      — degraded-service or incident notice
-- 'onboarding_nudge' — push user back into onboarding flow
-- 'upgrade_nudge'    — plan upgrade CTA
-- 'winback'          — re-engagement after dormancy
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS kind varchar(30) NOT NULL DEFAULT 'general';

-- ─── Multi-channel delivery ───────────────────────────────────────
-- jsonb array of enabled channels:
--   'in_app'        — in-app notification dropdown / dashboard banner
--   'modal'         — full-screen modal on first dashboard visit
--   'email'         — broadcast email via SES
--   'banner'        — top-of-page sticky banner
-- Empty array defaults to in_app + dashboard banner.
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS channels jsonb NOT NULL DEFAULT '["in_app"]'::jsonb;

-- ─── Multi-dimensional audience targeting ─────────────────────────
-- jsonb object with optional fields:
--   plans:           ["pro","team"]
--   subscriptionStatuses: ["active","trialing"]
--   onboardingStates: ["completed","incomplete"]
--   minBookings30d:  10
--   inactiveDays:    30  (tenants with no activity in N days)
-- Empty object means "all tenants" (default).
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS audience_rules jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ─── Scheduling ───────────────────────────────────────────────────
-- Optional explicit scheduled-start. NULL → publish immediately
-- (published_at is set to NOW() at insert time). When set in the
-- future and status='scheduled', the in-app reader filters out
-- announcements where scheduled_at > NOW().
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

-- ─── Engagement counters (real, never inferred) ───────────────────
-- Incremented by the in-app reader / banner / email tracker. Default 0.
-- UI displays raw counts when present and "—" when both delivery
-- and view counts are 0 (avoid the "0% engagement" illusion of
-- failure when the announcement just hasn't been delivered yet).
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS delivery_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dismiss_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0;

-- ─── Audit trail ──────────────────────────────────────────────────
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

-- ─── Free-form metadata ───────────────────────────────────────────
-- Campaign attribution, hypothesis, A/B test arm, etc. Never PII.
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ─── Indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS announcements_status_idx ON announcements(status);
CREATE INDEX IF NOT EXISTS announcements_kind_idx ON announcements(kind);
CREATE INDEX IF NOT EXISTS announcements_expires_idx ON announcements(expires_at);
CREATE INDEX IF NOT EXISTS announcements_created_at_desc_idx ON announcements(created_at DESC);

SELECT 1 AS announcements_communications_extensions_applied;
