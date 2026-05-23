-- Migration 0056: group_sessions table
--
-- One host + many customer attendees + one shared meeting link. Sibling
-- to bookings (1:1) and calendar_events (operational, no customer).
-- This is a CUSTOMER-FACING entity — the host serves a group of clients
-- in a single time block (webinar, onboarding session, tax workshop,
-- training call, office hours).
--
-- Why a separate table (vs extending bookings):
--   • bookings has clientName + clientEmail NOT NULL — the model is 1:1
--     by design. Group sessions are 1:N. Loosening those columns is a
--     non-additive break on every existing booking consumer (automation
--     engine, reschedule routes, .ics composer).
--   • bookings has serviceId NOT NULL; group sessions may not always
--     map to a service (an ad-hoc office hours session has no priced
--     service).
--   • Capacity + registration_deadline have no analog on bookings.
--
-- Why a separate table (vs extending calendar_events):
--   • calendar_events is OPERATIONAL — never customer-facing, never
--     surfaces in the public booking system, no service link, no
--     capacity. Group sessions are the inverse: they're EXPLICITLY
--     customer-facing once public registration ships.
--   • Discriminator drift: group_session would need columns that
--     blocked_time + internal_meeting never use (capacity, registration
--     deadline, service link).
--
-- For v1 (this migration): admin creates the session with capacity set;
-- attendees register via a future public flow. current_registrations
-- defaults to 0 and is updated as registrations arrive. The host's
-- calendar is blocked for the slot regardless of registration count.

CREATE TABLE IF NOT EXISTS group_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  -- Optional service linkage. Nullable because ad-hoc office hours
  -- sessions may not map to a priced service.
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  -- Primary host. v1 supports one host; future column
  -- co_host_user_ids jsonb can extend to multi-host without changing
  -- the primary slot semantics here.
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  -- 0 = unlimited (admin choice). Positive integer caps registrations.
  max_capacity integer NOT NULL DEFAULT 0,
  -- Cached count of confirmed registrations. Maintained by future
  -- registration flow; stays 0 in v1 (admin-create only).
  current_registrations integer NOT NULL DEFAULT 0,
  -- video provider (google_meet | teams | zoom | none). Same closed
  -- enum the appointments modal uses; varchar so new types can be
  -- added without a Postgres enum migration.
  video_provider varchar(20),
  meet_link text,
  location text,
  notes text,
  internal_notes text,
  -- Optional registration deadline. Public registration flow (future)
  -- rejects sign-ups after this. v1 stores it but doesn't enforce.
  registration_deadline timestamptz,
  external_event_id varchar(255),
  external_event_provider varchar(20),
  sync_external boolean NOT NULL DEFAULT true,
  -- Lifecycle state. scheduled = active and shown; cancelled = soft-
  -- deleted (preserved for audit + reporting).
  status varchar(20) NOT NULL DEFAULT 'scheduled',
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_sessions_tenant_idx
  ON group_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS group_sessions_host_window_idx
  ON group_sessions(host_user_id, start_at);
CREATE INDEX IF NOT EXISTS group_sessions_tenant_window_idx
  ON group_sessions(tenant_id, start_at, end_at);

-- Per-host overlap constraint mirroring bookings_no_overlap and
-- calendar_events_no_overlap. A single host cannot run two
-- overlapping group sessions. The WHERE clause keeps cancelled
-- sessions out of the index so they don't keep blocking the slot
-- after soft-cancel.
ALTER TABLE group_sessions
  ADD CONSTRAINT group_sessions_no_host_overlap
  EXCLUDE USING gist (
    host_user_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  )
  WHERE (status = 'scheduled');

COMMENT ON TABLE group_sessions IS
  'Customer-facing group events with one host + many attendees + one shared meeting link (webinars, onboarding, workshops, office hours). Sibling to bookings (1:1) and calendar_events (operational, non-customer). Migration 0056.';
