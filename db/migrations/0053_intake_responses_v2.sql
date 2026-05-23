-- Wave I — Custom Intake Fields & Dynamic Booking Forms.
--
-- Strictly additive. Three changes:
--   1. NEW table intake_field_responses — normalized per-field response
--      storage. Bookings continue to write `intake_responses` jsonb for
--      backward compat (admin drawer / existing readers); the new table
--      enables queryability/exportability/CRM workflows.
--   2. intake_forms gains `description` text + `submission_count` int.
--   3. NO changes to bookings.intake_responses (kept as the legacy
--      mirror; can be deprecated in a later wave once all consumers
--      read from the normalized table).
--
-- Rollback: DROP TABLE intake_field_responses; ALTER TABLE intake_forms
-- DROP COLUMN description, submission_count. Existing booking flow is
-- entirely unaffected — the new table is empty pre-deploy and the
-- existing booking POST writes to the jsonb column as before.

-- ─── Normalized responses ──────────────────────────────────────────────
-- One row per (booking, field). UNIQUE (booking_id, field_key) prevents
-- duplicate writes for the same field on the same booking — the
-- persistResponses helper relies on this for atomic save semantics.
--
-- Why store field_label + field_type as snapshots?
--   A tenant may rename or delete a form field months after a booking
--   was submitted. The booking's historical record must remain accurate
--   even when the live form definition diverges. Snapshotting label +
--   type at submit time gives audit-grade fidelity. (Same pattern as
--   billing line items: label captures the value at transaction time.)
--
-- Why 3 value columns (text, number, json)?
--   • value_text  — short_text, long_text, email, phone, url, select,
--                   radio, date (ISO string), boolean (as 'true'/'false'),
--                   consent (as 'true' when accepted)
--   • value_number — number type (NUMERIC for precision)
--   • value_json  — multi_select (array), future complex types
--                   (file metadata, signature data, conditional payloads)
--   At read time, the field_type column tells the caller which value
--   column to read. SQL queries can also filter on the type-appropriate
--   column directly (e.g. `WHERE value_text = 'peanut'`).
CREATE TABLE IF NOT EXISTS intake_field_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- Nullable: a booking might submit responses for a form that's later
  -- deleted. We keep the response history (NULL'd FK via SET NULL)
  -- rather than CASCADE-deleting historical responses.
  intake_form_id  UUID REFERENCES intake_forms(id) ON DELETE SET NULL,

  -- Field identity at submit time. `field_key` is the schema-stable
  -- identifier; `field_label` + `field_type` are snapshots for audit.
  field_key       VARCHAR(60) NOT NULL,
  field_label     VARCHAR(200) NOT NULL,
  field_type      VARCHAR(30) NOT NULL,

  -- One of value_text / value_number / value_json is set, depending on
  -- field_type. NEVER all three. The persistResponses helper enforces
  -- this; the schema doesn't (a CHECK constraint would be defensible
  -- but adds maintenance overhead).
  value_text      TEXT,
  value_number    NUMERIC,
  value_json      JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One response per (booking, field). The persistResponses helper
  -- uses ON CONFLICT DO UPDATE for atomic upsert when a booking is
  -- re-confirmed (Phase 3 paid path can retry the post-confirmation
  -- hook on webhook replay).
  UNIQUE (booking_id, field_key)
);

CREATE INDEX IF NOT EXISTS intake_field_responses_tenant_idx
  ON intake_field_responses (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_field_responses_booking_idx
  ON intake_field_responses (booking_id);
-- Field-level queryability across all bookings in a tenant:
-- "find every booking where 'allergies' was answered"
CREATE INDEX IF NOT EXISTS intake_field_responses_field_idx
  ON intake_field_responses (tenant_id, field_key);

-- ─── Soft additions to intake_forms ───────────────────────────────────
-- Pre-existing rows default cleanly. No backfill needed.
ALTER TABLE intake_forms
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS submission_count  INTEGER NOT NULL DEFAULT 0;
