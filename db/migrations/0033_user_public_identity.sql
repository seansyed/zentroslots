-- Migration 0033 — Public-facing workforce identity columns.
--
-- Adds two nullable identity columns to `users` so every schedulable
-- staff member can present a curated, customer-facing identity on
-- booking pages and service pages — distinct from the operational
-- record (login email, internal `name`, etc.).
--
--   public_display_name — how this person appears on customer-facing
--                         surfaces. Defaults to `name` when null.
--                         (e.g. internal name "Sean A. Syed" →
--                         public name "Sean Syed")
--   public_title        — professional title shown beneath the name
--                         on booking pages (e.g. "Founder & Tax
--                         Strategist"). Nullable; honest empty state
--                         when not set.
--
-- Safety properties:
--   • Both columns NULLable on purpose. Every existing user starts
--     without a curated public identity. Render paths fall back to
--     `name` (and omit the title) so behavior is unchanged for any
--     user who never edits their profile.
--   • No backfill required.
--   • No indexes needed — these columns are render-only, not query
--     predicates.
--   • Tenant isolation continues to be enforced at the API write
--     layer. PATCH /api/staff/[id] verifies the caller is admin or
--     manager in the same tenant (or the user editing themselves).
--
-- The existing `avatar_url`, `bio`, and `specialties` columns (added
-- in migration 0007) remain the authoritative storage for profile
-- image, public bio, and expertise. Migration 0033 is purely additive
-- on top of that v1 identity layer.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS public_display_name varchar(120),
  ADD COLUMN IF NOT EXISTS public_title varchar(120);
