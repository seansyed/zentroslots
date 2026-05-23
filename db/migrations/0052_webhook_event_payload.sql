-- Wave H Phase 3 — webhook event payload retention for forensics/replay.
--
-- Strictly additive. Three new nullable columns on the existing
-- tenant_payment_webhook_events table. Pre-Phase-3 rows (none in prod
-- today; the table was created empty in 0050) simply carry NULL.
--
-- WHAT we keep:
--   • raw_payload       — the PARSED event body the provider sent. JSONB
--                         so we can search it later (e.g. "find every
--                         event referencing capture id X"). NOT the raw
--                         bytes — those go through JSON.parse first AND
--                         through the adapter's redactSecrets() to scrub
--                         any token-shaped substring before storage.
--   • signature_headers — the lowercase-keyed map of provider headers
--                         we received. Useful for re-verifying a signature
--                         offline ("did this event REALLY come from
--                         PayPal?") and for debugging cert_url issues.
--                         We store ONLY the provider-prefixed headers
--                         (stripe-*, paypal-*), never cookies / auth /
--                         X-Real-IP etc.
--   • processing_duration_ms — INTEGER, ms taken from receiver entry to
--                              200 response. Surfaces slow PayPal verify
--                              calls in the dashboard health card.
--
-- WHAT we DELIBERATELY DO NOT keep:
--   • The raw HTTP body bytes (we already have the parsed JSON; bytes
--     would only matter for one specific PayPal replay-attack scenario
--     that the verify endpoint already protects against).
--   • Cookies / Authorization / X-Forwarded-For headers from the request.
--   • Any decrypted credential, ever.
--
-- PII note: raw_payload may contain customer email, name, billing
-- country (Stripe). It NEVER contains PANs (Stripe/PayPal don't expose
-- them). Retention is governed by the existing lib/governance policy
-- (tenant_governance_settings.retention_days_*). Phase 5 dashboard
-- will surface "Forensic webhook log" with the same RBAC as billing
-- transactions.
--
-- Rollback: DROP COLUMN on the three new columns. Pre-rollback events
-- still queryable on the existing (provider_id, external_event_id) key.

ALTER TABLE tenant_payment_webhook_events
  ADD COLUMN IF NOT EXISTS raw_payload             JSONB,
  ADD COLUMN IF NOT EXISTS signature_headers       JSONB,
  ADD COLUMN IF NOT EXISTS processing_duration_ms  INTEGER;

-- No new indexes: forensic queries are operator-driven (rare, by event_id
-- or booking_id which already have indexes from 0050). raw_payload search
-- would justify a GIN index later if usage patterns demand it; not now.
