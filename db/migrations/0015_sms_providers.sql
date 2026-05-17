-- 0015 — Tenant-owned SMS provider connections (Twilio, Telnyx).
-- Strictly additive. One active provider per tenant; secrets stored
-- AES-256-GCM encrypted (envelope handled in lib/crypto.ts).
BEGIN;

CREATE TABLE IF NOT EXISTS tenant_sms_providers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'twilio' | 'telnyx'
  provider                 varchar(20) NOT NULL,
  -- Twilio: Account SID. Telnyx: profile/messaging-profile ID (optional, may be null).
  account_id               varchar(120),
  -- Encrypted envelope (v1:<iv>:<ct>:<tag>). Never exposed to client.
  auth_token_encrypted     text NOT NULL,
  -- E.164 sender ("+15551234567"), short code, or alphanumeric ID.
  sender_id                varchar(40) NOT NULL,
  -- Webhook signing secret for inbound delivery callbacks (future).
  webhook_secret_encrypted text,
  active                   boolean NOT NULL DEFAULT true,
  -- Volume tracking — incremented per successful send for usage reporting.
  total_sent               integer NOT NULL DEFAULT 0,
  total_failed             integer NOT NULL DEFAULT 0,
  last_send_at             timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_sms_providers_active_idx ON tenant_sms_providers(active);

COMMIT;
