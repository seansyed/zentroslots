-- 0074_backfill_user_tz.sql
-- P0 timezone follow-up: backfill users whose tenant now has a real business
-- timezone but whose own profile is still the UTC default.
--
-- Why this is needed: 0073 backfilled users from tenant tz at migration time,
-- but a tenant whose timezone was set LATER (e.g. via the new settings UI or a
-- manual correction) did NOT cascade to its users. Those users then drive
-- slot generation in UTC (the operator books "4:30 PM" which is actually
-- 16:30 UTC = 9:30 AM in the business tz). This re-runs the cascade.
--
-- Idempotent + additive. Apply via raw psql.

BEGIN;

UPDATE users u
SET timezone = t.timezone
FROM tenants t
WHERE u.tenant_id = t.id
  AND (u.timezone IS NULL OR u.timezone = 'UTC')
  AND t.timezone <> 'UTC';

COMMIT;

SELECT
  (SELECT count(*) FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.timezone = 'UTC' AND t.timezone <> 'UTC') AS users_still_mismatched,
  (SELECT count(*) FROM users WHERE timezone <> 'UTC') AS users_non_utc;
