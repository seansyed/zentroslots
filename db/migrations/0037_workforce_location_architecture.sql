-- Migration 0037 — Enterprise workforce location architecture.
--
-- The pivot the routing engine has been waiting for. See the
-- comment in `staff_assignment_rules` (mig 0020) — it reads
-- "until staff_location pivot exists". This migration delivers it.
--
-- CORE INVARIANT (preserved end-to-end):
--   Workspace Hours → Staff Availability → Location Presence → Booking
--                          ^                       ^
--                          |                       |
--          stays STAFF-OWNED               NEW context layer added
--          (lib/availability.ts            here; never gates slot
--           unchanged)                     generation
--
-- This migration is PURELY ADDITIVE. Every default is byte-
-- identical to current behavior:
--   • Existing staff default to `delivery_mode='hybrid'`
--     (most permissive — accepts in-person + virtual bookings).
--   • Existing services default to allowing both modes.
--   • The pivot starts empty → nothing references it, no UX or
--     engine path changes until an admin assigns staff to
--     locations.
--   • `users.primary_location_id` is intentionally left in place
--     for backward compat. The pivot is the source of truth going
--     forward; the legacy column stays untouched for any code that
--     still reads it.

-- ── 1. Per-staff delivery mode ──────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS delivery_mode varchar(20) NOT NULL DEFAULT 'hybrid';

-- ── 2. System-protected locations (Virtual Hub) ─────────────────────
-- A "system" location is one created by the platform on demand
-- (e.g. the auto-spawned "Virtual Hub" when a staff member is set
-- to delivery_mode='virtual'). DELETE /api/locations/[id] refuses
-- to remove rows where is_system=true so the operational primitive
-- can't be accidentally deleted out from under bookings/staff.
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- ── 3. Per-service delivery compatibility ───────────────────────────
-- jsonb array of allowed delivery modes. Default to BOTH so every
-- existing service stays bookable in either mode — no enforcement
-- change at rollout. Future enforcement layer reads this when
-- filtering staff by their effective per-day location presence.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS delivery_modes jsonb NOT NULL DEFAULT '["virtual","in_person"]'::jsonb;

-- ── 4. Multi-location staff assignments ─────────────────────────────
-- The pivot. One row per (staff, location) pair within a tenant.
-- `days_of_week` is a jsonb array of stringified 0..6 (Sun..Sat)
-- matching how default_workspace_hours + availability already
-- represent days. Empty = "any day they work"; non-empty = day
-- restriction. Multiple rows with restricted days yield the
-- Mon→Downtown / Tue→Virtual / Wed→East pattern.
--
-- `is_primary` is enforced by the API to be at most one true per
-- (tenant, staff) — keeping the constraint in application code
-- avoids fragile partial-unique-index syntax and makes the rule
-- visible to anyone reading the route handler.
CREATE TABLE IF NOT EXISTS staff_location_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  days_of_week jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, staff_id, location_id)
);

CREATE INDEX IF NOT EXISTS staff_location_assignments_staff_idx
  ON staff_location_assignments (staff_id);
CREATE INDEX IF NOT EXISTS staff_location_assignments_location_idx
  ON staff_location_assignments (location_id);
CREATE INDEX IF NOT EXISTS staff_location_assignments_tenant_idx
  ON staff_location_assignments (tenant_id);
