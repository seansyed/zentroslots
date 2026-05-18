-- 0020 — Staff routing (round robin, least-busy, priority, weighted).
--
-- Strictly additive. Two tables. Without any rows in
-- staff_assignment_rules, the booking POST falls through to the
-- existing inline pickRoundRobinStaff() — byte-identical behavior for
-- tenants that haven't configured routing.
--
-- Mode is a varchar (not enum) so adding a mode in the future is a
-- one-line addition to the TypeScript RoutingMode union, no migration
-- required. The lib's closed union is the runtime gatekeeper.
--
-- Scope of a rule:
--   1. Service-specific  (service_id set, location_id null)
--   2. Location-specific (service_id null, location_id set)  ← schema
--      ready; enforcement deferred until staff_location pivot exists
--   3. Tenant default    (both null)
-- The orchestrator picks the MOST SPECIFIC matching rule; a tenant
-- default is the catch-all.
BEGIN;

CREATE TABLE IF NOT EXISTS staff_assignment_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id               uuid REFERENCES services(id) ON DELETE CASCADE,
  -- Schema-ready for future location-pinned pools. Today the routing
  -- engine ignores it (any-staff-who-delivers-this-service fallback).
  location_id              uuid REFERENCES locations(id) ON DELETE SET NULL,
  -- 'manual' | 'round_robin' | 'least_busy' | 'priority' | 'weighted'
  mode                     varchar(20) NOT NULL DEFAULT 'manual',
  enabled                  boolean NOT NULL DEFAULT true,
  -- Ordered array of staff user ids. Used by mode='priority'; ignored
  -- elsewhere. Each id must be a current member of the tenant — the
  -- API validates on write.
  priority_order           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Object {staffId: percent} where percents are 0..100 and ideally
  -- sum to 100. Used by mode='weighted'; ignored elsewhere.
  weighted_distribution    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_assignment_rules_tenant_idx
  ON staff_assignment_rules(tenant_id);
CREATE INDEX IF NOT EXISTS staff_assignment_rules_service_idx
  ON staff_assignment_rules(service_id);
CREATE INDEX IF NOT EXISTS staff_assignment_rules_location_idx
  ON staff_assignment_rules(location_id);
-- At most one rule per (tenant, scope). NULL behaves as a value in
-- partial unique indexes when expressed via COALESCE — easiest is to
-- create three partial uniques for the three scope buckets.
CREATE UNIQUE INDEX IF NOT EXISTS staff_assignment_rules_service_unique
  ON staff_assignment_rules(tenant_id, service_id)
  WHERE service_id IS NOT NULL AND location_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS staff_assignment_rules_location_unique
  ON staff_assignment_rules(tenant_id, location_id)
  WHERE service_id IS NULL AND location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS staff_assignment_rules_default_unique
  ON staff_assignment_rules(tenant_id)
  WHERE service_id IS NULL AND location_id IS NULL;

CREATE TABLE IF NOT EXISTS staff_assignment_stats (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_assignments        integer NOT NULL DEFAULT 0,
  last_assigned_at         timestamptz,
  -- Rolling counters. day_window_start / week_window_start anchor the
  -- "today" / "this week" buckets. The recorder resets the counter
  -- when the window has rolled over (avoids a separate cron).
  assignments_today        integer NOT NULL DEFAULT 0,
  assignments_this_week    integer NOT NULL DEFAULT 0,
  day_window_start         timestamptz,
  week_window_start        timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_assignment_stats_staff_unique
  ON staff_assignment_stats(tenant_id, staff_id);
CREATE INDEX IF NOT EXISTS staff_assignment_stats_tenant_idx
  ON staff_assignment_stats(tenant_id);

COMMIT;
