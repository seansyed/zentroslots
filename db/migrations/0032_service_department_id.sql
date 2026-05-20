-- Migration 0032 — Service ↔ Department primary ownership.
--
-- Adds a direct `department_id` column to the `services` table.
-- This formalizes the previously transitive (via staff.departmentId)
-- service-to-department relationship as a first-class operational
-- ownership signal.
--
-- Safety properties:
--   • NULLable on purpose. Every existing service starts unassigned
--     ("Department not assigned" empty state already handled in UI).
--     No backfill required.
--   • ON DELETE SET NULL — deleting a department doesn't cascade into
--     the service catalog. Services just transition back to
--     "unassigned" and the operator can re-route them.
--   • Index on department_id for the inevitable per-department
--     service-count + service-list lookups (Departments page).
--   • Tenant isolation is preserved end-to-end. API writes will
--     validate that the chosen department_id belongs to the caller's
--     tenant before accepting the assignment.
--
-- The existing transitive service↔department relationship (a service
-- is "in" a department if a staff member assigned to it is in that
-- department) is preserved at the read layer as a secondary signal.
-- The direct column is the primary signal going forward.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS services_department_idx ON services(department_id);
