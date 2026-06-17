-- 0073_tenant_timezone.sql
-- P0 timezone architecture: add the canonical BUSINESS timezone.
--
-- Root cause of the "3 PM shows as 10 PM" bug: bookings are stored correctly
-- in UTC, but every display/notification surface formatted the instant in a
-- per-user `timezone` that silently defaults to 'UTC' and was never set for
-- many accounts. There was no business-level timezone at all.
--
-- This adds tenants.timezone (the canonical business tz) and backfills it from
-- each tenant's earliest admin's real (non-UTC) timezone, then backfills the
-- UTC-defaulted user accounts from their tenant's resolved timezone so the
-- existing viewer-tz display surfaces also render correctly.
--
-- Additive + idempotent. Apply via raw psql (drizzle journal is frozen).

BEGIN;

-- (1) Add the column (additive, non-null with a safe default).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS timezone varchar(64) NOT NULL DEFAULT 'UTC';

-- (2) Backfill each tenant's timezone from its earliest admin's real tz.
UPDATE tenants t
SET timezone = sub.tz
FROM (
  SELECT DISTINCT ON (u.tenant_id) u.tenant_id, u.timezone AS tz
  FROM users u
  WHERE u.role = 'admin'
    AND u.timezone IS NOT NULL
    AND u.timezone <> 'UTC'
  ORDER BY u.tenant_id, u.created_at ASC
) sub
WHERE t.id = sub.tenant_id
  AND t.timezone = 'UTC';

-- (3) Backfill UTC-defaulted users from their tenant's resolved timezone, so
--     viewer-tz display surfaces (web dashboard + mobile) render correctly.
UPDATE users u
SET timezone = t.timezone
FROM tenants t
WHERE u.tenant_id = t.id
  AND (u.timezone IS NULL OR u.timezone = 'UTC')
  AND t.timezone <> 'UTC';

COMMIT;

-- Report what got resolved.
SELECT
  (SELECT count(*) FROM tenants WHERE timezone <> 'UTC') AS tenants_non_utc,
  (SELECT count(*) FROM tenants WHERE timezone = 'UTC')  AS tenants_still_utc,
  (SELECT count(*) FROM users   WHERE timezone <> 'UTC') AS users_non_utc,
  (SELECT count(*) FROM users   WHERE timezone = 'UTC')  AS users_still_utc;
