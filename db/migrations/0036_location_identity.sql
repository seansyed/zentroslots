-- Migration 0036 — Location identity enrichment.
--
-- Adds the operational identity fields the Locations workspace needs
-- to render as a premium delivery-hub surface (Phase 15A). Purely
-- additive — existing rows default to a sensible operational state
-- (`physical`) so every location alive today continues to behave
-- byte-identical to before.
--
-- New columns:
--   logo_url      — content-addressed path to an uploaded location
--                   logo (e.g. /uploads/locations/<id>-<hash>.png).
--                   Served by nginx directly from /var/www/.../public/
--                   uploads/locations/ (existing alias from the
--                   avatars phase covers this path).
--   location_type — physical | virtual | hybrid. NOT a DB enum on
--                   purpose — kept as varchar so adding a new type
--                   later is a one-line Zod change without a
--                   migration.
--   notes         — admin-only operational metadata. NEVER surfaced
--                   on public booking pages; the API select for
--                   public surfaces explicitly omits this column.
--
-- Tenant isolation: every API write path verifies the tenantId on
-- the location row before mutating (see /api/locations/[id]).
-- Schema column does not enforce isolation; the API does.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS location_type varchar(20) NOT NULL DEFAULT 'physical',
  ADD COLUMN IF NOT EXISTS notes text;
