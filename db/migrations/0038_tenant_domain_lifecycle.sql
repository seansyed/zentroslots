-- Phase 15A — Enterprise Custom Domain Infrastructure
--
-- Extends the existing `tenant_domains` table with the full lifecycle
-- columns the verification + routing engine needs. Additive ALTERs
-- only — no destructive changes. Existing rows are backfilled so the
-- table is immediately consistent after the migration runs.
--
-- New surface:
--   normalized_host  — lowercased + trailing-dot-stripped form used for
--                      O(1) hostname lookups from middleware. Unique.
--   status           — pending | verified | failed
--   ssl_status       — pending | active  | failed
--   last_checked_at  — wall-clock for the most recent DNS check
--   updated_at       — bumped on every status / ssl_status change

ALTER TABLE tenant_domains
  ADD COLUMN IF NOT EXISTS normalized_host varchar(253),
  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ssl_status varchar(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill normalized_host + status from existing data. The previous
-- API populated `host` lowercased already; this re-normalizes defensively
-- and strips any trailing dot.
UPDATE tenant_domains
SET normalized_host = lower(regexp_replace(host, '\.$', ''))
WHERE normalized_host IS NULL;

UPDATE tenant_domains
SET status = 'verified'
WHERE verified_at IS NOT NULL
  AND status = 'pending';

ALTER TABLE tenant_domains
  ALTER COLUMN normalized_host SET NOT NULL;

-- Hostname must be globally unique across tenants — two tenants can't
-- both claim the same external hostname. This is the gatekeeper.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_normalized_host_unique
  ON tenant_domains (normalized_host);

-- Index used by middleware for hostname → tenant resolution.
CREATE INDEX IF NOT EXISTS tenant_domains_status_idx
  ON tenant_domains (status);
