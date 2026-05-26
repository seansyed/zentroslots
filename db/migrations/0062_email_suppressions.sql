-- Phase: SES deliverability hardening — email_suppressions table.
--
-- Records addresses that have bounced (permanent failure) or filed
-- complaints (spam button) so the email transport can skip future
-- sends. Populated by /api/webhooks/ses (SNS → bounce/complaint
-- notifications). Honoring suppression is required to preserve our
-- SES sender reputation — repeated sends to bouncing addresses
-- degrade deliverability for ALL tenants on this account.
--
-- Schema choices:
--   - email_lower: canonical lowercase email is the primary lookup
--     key. Case-insensitive match guards against "Foo@Bar.com" vs
--     "foo@bar.com" being treated as different addresses.
--   - kind: 'bounce' | 'complaint' | 'manual'. 'manual' lets ops
--     suppress an address out-of-band (CSV import, admin UI later).
--   - bounce_subtype: SES bounce sub-types ('Permanent', 'Transient',
--     'Undetermined'). Only 'Permanent' should suppress; the webhook
--     handler enforces this. Transient bounces (mailbox full,
--     greylisted) should NOT enter this table — the engine should
--     retry later.
--   - first_seen_at / last_seen_at: SES sometimes sends multiple
--     events for the same address; we update last_seen_at on each
--     event so we know when the most recent signal arrived.
--   - event_count: how many SNS notifications we've received for
--     this address. Useful for dashboards + spike detection.
--   - source: free-form attribution string ('ses-sns', 'manual:<userId>',
--     'csv-import-2026-05-26') so audits can reconstruct WHY an
--     address was suppressed.

CREATE TABLE IF NOT EXISTS email_suppressions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_lower     varchar(320) NOT NULL,
  kind            varchar(20)  NOT NULL,   -- 'bounce' | 'complaint' | 'manual'
  bounce_subtype  varchar(40),             -- 'Permanent' | 'Transient' | 'Undetermined' | NULL
  source          varchar(120) NOT NULL DEFAULT 'ses-sns',
  reason          text,                    -- diagnostic string from SES (last bounce SMTP code, etc)
  first_seen_at   timestamptz  NOT NULL DEFAULT NOW(),
  last_seen_at    timestamptz  NOT NULL DEFAULT NOW(),
  event_count     integer      NOT NULL DEFAULT 1,
  -- Optional metadata blob for the raw SNS event (small subset, no PII
  -- beyond email + diagnostic). Useful for ops to inspect.
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb
);

-- Unique by (email_lower, kind). A single address can have one row
-- per kind (e.g. 'bounce' AND 'complaint' for an address that did
-- both — rare but possible). We UPSERT on this constraint to
-- accumulate event_count + refresh last_seen_at.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppressions_email_kind
  ON email_suppressions (email_lower, kind);

-- Fast lookup of "is this email suppressed at all (any kind)?". The
-- sendEmail() pre-check uses this index.
CREATE INDEX IF NOT EXISTS idx_email_suppressions_email
  ON email_suppressions (email_lower);

-- Operational queries: how many bounces/complaints today?
CREATE INDEX IF NOT EXISTS idx_email_suppressions_kind_time
  ON email_suppressions (kind, last_seen_at);
