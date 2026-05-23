-- Migration 0055: calendar_events table
--
-- Stores operational events that block a staff member's calendar but
-- are NOT customer-facing bookings:
--   • blocked_time     — lunch, PTO, focus, tax-season blocking
--   • internal_meeting — team standups, internal reviews
--
-- Why a separate table (vs extending bookings):
--   • bookings has serviceId NOT NULL, clientName NOT NULL,
--     clientEmail NOT NULL — none apply here. Loosening those is
--     non-additive at the type-system level.
--   • bookings carries payment + intake + automation hooks that
--     should NEVER fire for these event types. Keeping them on a
--     separate table makes "skip" semantics unambiguous.
--   • Public booking POST + slot lifecycle + EXCLUDE constraint
--     remain byte-identical — zero regression risk.
--
-- The availability engine reads BOTH bookings AND calendar_events to
-- compute the staff's internal busy set. External calendar sync
-- (when sync_external=true) pushes calendar_events to Google/Outlook
-- via the same adapters used by bookings.

CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Event type discriminator. Closed enum at the application layer
  -- (varchar so adding new types — focus block, travel, etc. —
  -- doesn't require a Postgres enum migration).
  event_type varchar(20) NOT NULL,
  title varchar(255) NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  -- Primary owner of the block. For blocked_time this IS the staff
  -- whose calendar is blocked. For internal_meeting it's the
  -- organizer; other attendees live in attendee_user_ids.
  staff_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- jsonb array of user ids. For internal_meeting these participate
  -- in the busy-time calculation alongside staff_user_id. Empty
  -- array for blocked_time (the staff_user_id is the only blocked
  -- party).
  attendee_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Free-form description shown on the calendar tooltip / drawer.
  notes text,
  -- Admin/staff-only annotation. Never surfaced on customer-facing
  -- emails (these events never produce customer emails anyway, but
  -- the field exists for symmetry with bookings.internal_notes).
  internal_notes text,
  -- Free-form location string. For internal meetings; null otherwise.
  location text,
  -- Optional video conference creation. When set + sync_external
  -- and the organizer has a connected calendar, the adapter spawns
  -- a Teams/Meet/Zoom link on the external event.
  video_provider varchar(20),
  meet_link text,
  external_event_id varchar(255),
  external_event_provider varchar(20),
  -- Toggle: whether to push to the organizer's connected external
  -- calendar. Default true so the block actually shows up on the
  -- staff's Outlook/Google calendar (which is the whole point for
  -- most blocked time scenarios).
  sync_external boolean NOT NULL DEFAULT true,
  -- Provenance for audit trail. Nullable + ON DELETE SET NULL mirrors
  -- the bookings/notifications pattern: when the original creator is
  -- removed from the workspace, the event itself survives (it may
  -- still belong to an active staff member via staff_user_id) but the
  -- creator reference is cleared rather than blocking the user
  -- deletion.
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_events_tenant_idx
  ON calendar_events(tenant_id);
CREATE INDEX IF NOT EXISTS calendar_events_staff_window_idx
  ON calendar_events(staff_user_id, start_at);
CREATE INDEX IF NOT EXISTS calendar_events_tenant_window_idx
  ON calendar_events(tenant_id, start_at, end_at);

-- Per-staff overlap constraint mirroring bookings_no_overlap. A
-- single staff member can't have two overlapping blocks/meetings
-- under their own organizer slot. Cross-staff overlaps (internal
-- meeting has attendees who are also blocked elsewhere) are NOT
-- prevented by this constraint — the application layer's
-- availability engine handles those soft conflicts at modal time.
ALTER TABLE calendar_events
  ADD CONSTRAINT calendar_events_no_overlap
  EXCLUDE USING gist (
    staff_user_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  );

COMMENT ON TABLE calendar_events IS
  'Operational scheduling events that block staff availability but are not customer-facing bookings (blocked_time, internal_meeting). Sibling to bookings; never carries customer/payment/intake fields. Migration 0055.';
