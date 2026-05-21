-- Phase 15C — Cloudflare Edge TLS integration columns
--
-- Adds the Cloudflare-side tracking that wasn't possible until the
-- edge integration landed. All ALTERs are additive — no destructive
-- changes. Existing rows continue to work; new fields stay NULL until
-- the verify pipeline picks them up.
--
-- Fields:
--   cf_hostname_id      — Cloudflare Custom Hostname UUID (set after
--                         the edge provisions the cert pipeline)
--   verification_errors — Most recent CF or DNS error string, for the
--                         operator UI. NULL when healthy.
--   activated_at        — Wall-clock when ssl_status first hit "active".
--                         Useful for SLA + analytics.

ALTER TABLE tenant_domains
  ADD COLUMN IF NOT EXISTS cf_hostname_id varchar(64),
  ADD COLUMN IF NOT EXISTS verification_errors text,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Lookup by cf_hostname_id is used by the background sync worker.
CREATE INDEX IF NOT EXISTS tenant_domains_cf_hostname_id_idx
  ON tenant_domains (cf_hostname_id)
  WHERE cf_hostname_id IS NOT NULL;
