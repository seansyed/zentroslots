-- Migration 0054: internal_notes on bookings
--
-- Adds a single nullable text column for admin/staff-only annotations
-- attached to a booking. Customer-visible `notes` already exists; this
-- is the operational counterpart that customer-facing emails + the
-- public booking confirmation page MUST NOT surface.
--
-- Introduced by the internal-appointment-creation MVP (Phase 17H).
-- The public booking flow does not write to this column; only the new
-- admin endpoint `/api/tenant/appointments` POST sets it. Reading is
-- gated to authenticated dashboard surfaces.
--
-- Additive only. Default NULL preserves all existing booking rows
-- byte-identically. No backfill required.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS internal_notes text;

COMMENT ON COLUMN bookings.internal_notes IS
  'Admin/staff-only annotation. Surfaced in dashboard surfaces; never sent to customer-facing emails or public pages. Set by /api/tenant/appointments POST.';
