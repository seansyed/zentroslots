-- Migration 0057: staff_calendar_feed_tokens
--
-- Per-staff secrets backing Apple Calendar webcal:// subscription
-- feeds (Phase ICAL-2).
--
-- Why a dedicated table (vs reusing booking JWTs):
--   • Booking JWTs are short-lived (30d), tied to a single booking,
--     and inherently NOT revocable — the signing key is the only
--     auth surface. A subscription feed is the OPPOSITE:
--       - Long-lived (months/years)
--       - Tied to a person, not a single object
--       - MUST be individually revocable + rotatable (the leaked-URL
--         scenario is real — Apple Calendar URLs end up in iCloud
--         backups, screenshots, AirDrops between devices)
--   • A row-per-token model lets us record last_accessed_at for the
--     audit trail (when did this device last poll?), revoke without
--     rotating the JWT secret (which would invalidate every booking
--     link in flight), and per-token rate-limit by id.
--
-- Why SHA-256 hash (vs bcrypt like password_reset_tokens):
--   • password_reset_tokens looks the row up by (user_id, expires_at)
--     and THEN bcrypt-compares — the user clicks a link in their
--     email that carries their identity context. Cheap salted hash
--     is the right call.
--   • This endpoint has ONLY the token in the URL — no user context.
--     We MUST be able to find the row by token content, which
--     requires a DETERMINISTIC hash. SHA-256 (256 bits of preimage
--     resistance) over a 256-bit random secret is industry standard
--     for this shape (GitHub PATs, Stripe webhooks, Sentry DSNs).
--   • Tokens never leave server memory in plaintext after creation
--     — they're shown to the user ONCE on generate/rotate and
--     hashed at rest forever after.
--
-- Lifecycle:
--   • CREATE — one active token per (tenant_id, user_id). Rotation
--     is delete-and-insert in a single transaction.
--   • ROTATE — same as CREATE; the prior row is marked revoked_at
--     (preserved for the audit trail) and a new row inserted with
--     a fresh hash.
--   • REVOKE — sets revoked_at; the row stays for audit but
--     verifyFeedToken refuses to match it.
--
-- Cascade: ON DELETE CASCADE on both tenant + user. Tearing down a
-- workspace or removing a staff member instantly burns all their
-- subscription feeds.

CREATE TABLE IF NOT EXISTS staff_calendar_feed_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the 256-bit random secret. Unique because every
  -- random draw is independent; collision probability is 2^-128.
  token_hash varchar(64) NOT NULL,
  -- Audit trail. Touched on every successful fetch — admins can see
  -- "the iPhone last polled 14 minutes ago, the desktop hasn't
  -- polled in 6 months" and decide whether to revoke.
  last_accessed_at timestamptz,
  -- Audit IP of the most recent poll. Useful for "is this still my
  -- device?" forensics when a user reports calendar weirdness.
  -- Stored as varchar(45) to fit IPv6.
  last_accessed_ip varchar(45),
  -- Soft delete. Revoked tokens stay for audit but never verify.
  revoked_at timestamptz,
  -- Reason for revocation (admin note: 'rotated' | 'user_revoke' |
  -- 'admin_revoke' | 'staff_offboarded'). Free-form short string;
  -- enforced as enum at application layer.
  revoked_reason varchar(40),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookup by hash is the hot path (every feed poll hits this index).
-- Unique because no two random tokens should collide; the constraint
-- also doubles as a defense against accidental duplicate inserts.
CREATE UNIQUE INDEX IF NOT EXISTS staff_calendar_feed_tokens_hash_unique
  ON staff_calendar_feed_tokens(token_hash);

-- "Does this user have an active token?" lookup. Partial index keeps
-- it tight — revoked tokens stay in the table for audit but never
-- match this predicate.
CREATE INDEX IF NOT EXISTS staff_calendar_feed_tokens_active_idx
  ON staff_calendar_feed_tokens(tenant_id, user_id)
  WHERE revoked_at IS NULL;

-- Tenant-scoped scan for governance reports + cascading admin
-- dashboards.
CREATE INDEX IF NOT EXISTS staff_calendar_feed_tokens_tenant_idx
  ON staff_calendar_feed_tokens(tenant_id, created_at DESC);

COMMENT ON TABLE staff_calendar_feed_tokens IS
  'Per-staff secrets backing Apple Calendar webcal:// subscription feeds. SHA-256-hashed at rest; never reversible. One active token per user; rotation soft-revokes the prior row for audit. Phase ICAL-2 (Migration 0057).';
