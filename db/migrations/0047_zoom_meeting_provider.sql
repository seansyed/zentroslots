-- Wave D — Zoom as a side-car meeting provider.
--
-- Why a migration is needed (unlike Wave C's Microsoft addition):
--   Google Meet and Microsoft Teams live INSIDE the calendar event:
--   creating a Google Calendar event with `conferenceData` returns the
--   Meet link; creating a Microsoft event with `isOnlineMeeting: true`
--   returns the Teams link. One API call, one resource, one id.
--
--   Zoom is different. The Zoom meeting is a SEPARATE resource from
--   the calendar event. A booking can have:
--     • a Google Calendar event (for the staff's calendar) +
--     • a Zoom meeting (for the conferencing URL)
--   and the orchestrator must track BOTH ids so reschedule + cancel
--   can update/delete each side independently.
--
-- These two columns capture the side-car meeting state. For existing
-- Google Meet / Teams bookings they stay null (the calendar event id
-- in external_event_id already does the job). For new Zoom bookings:
--     • meeting_provider          = "zoom"
--     • meeting_provider_event_id = Zoom's meeting id
--     • meet_link                 = Zoom join URL (existing column)
--
-- Additive + nullable. Pre-Wave-D bookings behave identically.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS meeting_provider          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS meeting_provider_event_id VARCHAR(255);

-- Partial index: speeds up the orchestrator's reschedule + cancel
-- lookups for bookings that have a side-car meeting (skip the index
-- entries for the vast majority of rows which won't).
CREATE INDEX IF NOT EXISTS bookings_meeting_provider_idx
  ON bookings (meeting_provider, meeting_provider_event_id)
  WHERE meeting_provider IS NOT NULL;
