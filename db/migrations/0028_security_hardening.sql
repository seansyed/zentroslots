-- 0028 — Enterprise security + identity hardening. STRICTLY ADDITIVE.
--
-- Adds:
--   * password_reset_tokens — short-lived one-time tokens (bcrypt-hashed)
--   * session_audit_events  — per-user login/logout/revoke/failure log
--   * revoked_session_jtis  — denylist of revoked JWT ids
--   * users.session_min_iat — bulk-revoke marker (bump = invalidate all)
--   * users.permissions_extra — jsonb overrides for granular flags
--   * users.last_login_at / _ip / _user_agent — heuristic bookkeeping
--
-- No existing column is altered. No existing row is rewritten. Existing
-- sessions remain valid (their JWTs lack a jti and are uniquely
-- unrevokable per-session — but stay valid until natural 7d expiry).
-- "Revoke all" works for them via session_min_iat being bumped above
-- their iat. This is documented graceful-degradation.

BEGIN;

-- ─── password_reset_tokens ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- bcrypt hash of the raw token; the raw token is only delivered
  -- inside the one outbound email and never persisted in the clear.
  token_hash       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  -- One-time use enforced via this column: a token may be consumed
  -- AT MOST ONCE; replay attempts after this is set are rejected.
  consumed_at      timestamptz,
  requested_ip     varchar(45),
  consumed_ip      varchar(45),
  consumed_user_agent text
);
CREATE INDEX IF NOT EXISTS prt_user_idx       ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS prt_tenant_idx     ON password_reset_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS prt_expires_idx    ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS prt_outstanding_idx
  ON password_reset_tokens(user_id, expires_at)
  WHERE consumed_at IS NULL;

-- ─── session_audit_events ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Nullable: failed logins for unknown emails record a tenant best-
  -- guess (or the null path), but the user_id is unknown by definition.
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  -- Closed enum maintained at the app layer (lib/security/sessionEvents.ts).
  -- Values today: login | logout | login_failed | password_reset_requested
  --             | password_reset_completed | session_revoked
  --             | sessions_revoked_all | device_changed | suspicious_login
  event_type      varchar(40) NOT NULL,
  -- The JWT 'jti' of the session that triggered the event when known.
  -- NULL for events fired by legacy tokens issued before 0028.
  session_jti     varchar(64),
  ip_address      varchar(45),
  user_agent      text,
  device_label    varchar(120),
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sae_user_idx       ON session_audit_events(user_id);
CREATE INDEX IF NOT EXISTS sae_tenant_idx     ON session_audit_events(tenant_id);
CREATE INDEX IF NOT EXISTS sae_event_idx      ON session_audit_events(event_type);
CREATE INDEX IF NOT EXISTS sae_created_idx    ON session_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS sae_tenant_created_idx
  ON session_audit_events(tenant_id, created_at DESC);

-- ─── revoked_session_jtis ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revoked_session_jtis (
  jti               varchar(64) PRIMARY KEY,
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE,
  revoked_at        timestamptz NOT NULL DEFAULT now(),
  -- Original token expiry — once past, the row can be pruned by cron.
  token_expires_at  timestamptz NOT NULL,
  reason            varchar(40)
);
CREATE INDEX IF NOT EXISTS revoked_user_idx     ON revoked_session_jtis(user_id);
CREATE INDEX IF NOT EXISTS revoked_expires_idx  ON revoked_session_jtis(token_expires_at);

-- ─── users: additive columns ────────────────────────────────────────
-- Bulk session invalidation marker. Tokens whose iat is BEFORE this
-- timestamp are rejected by verifySessionFresh(). Null = no bulk
-- revocation has ever happened (most users).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_min_iat timestamptz;

-- Per-user overrides for granular permission flags. Role defaults
-- still live in lib/security/permissions.ts; this column is for
-- per-user opt-outs / opt-ins (e.g. give one staff member
-- canViewAuditLogs without promoting them to admin).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permissions_extra jsonb NOT NULL DEFAULT '{}';

-- Last-login bookkeeping for the suspicious-activity heuristic.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at         timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_ip         varchar(45),
  ADD COLUMN IF NOT EXISTS last_login_user_agent text;

COMMIT;
