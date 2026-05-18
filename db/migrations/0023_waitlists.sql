-- 0023 — Waitlists + slot-release automation.
--
-- Strictly additive. Two tables. Tenants who never accept a waitlist
-- join continue with byte-identical booking flow (rule #12) — the new
-- orchestrators are only invoked when a row exists for the released
-- slot's (tenant, service).
--
-- waitlists           — one row per (customer, service) queue entry.
--                       Status transitions: waiting → notified → claimed
--                       OR waiting → expired OR waiting → cancelled.
-- waitlist_notifications — record of every promotion attempt. The
--                       UNIQUE partial index gates against parallel
--                       promotions for the same waitlist row: at most
--                       ONE 'sent' notification per waitlist may be
--                       outstanding (rule: never notify multiple
--                       customers for the same slot simultaneously).
BEGIN;

CREATE TABLE IF NOT EXISTS waitlists (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id              uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  location_id             uuid,
  customer_email          varchar(255) NOT NULL,
  customer_name           varchar(120) NOT NULL,
  customer_phone          varchar(40),
  -- Optional "YYYY-MM-DD". When set, matching prefers this date.
  preferred_date          varchar(10),
  -- 'morning' | 'afternoon' | 'evening' | 'any'. Matching uses local
  -- staff TZ to bucket slot start times against these windows.
  preferred_time_range    varchar(16) NOT NULL DEFAULT 'any',
  -- 'waiting' | 'notified' | 'claimed' | 'expired' | 'cancelled'
  status                  varchar(20) NOT NULL DEFAULT 'waiting',
  -- Higher = more important. Defaults to 0 (FIFO within priority).
  priority                integer NOT NULL DEFAULT 0,
  -- Lifecycle timestamps.
  expires_at              timestamptz,  -- last claim window expiration (mirrors latest notification)
  claimed_at              timestamptz,
  -- Booking that ultimately came from this waitlist entry (on claim).
  claimed_booking_id      uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waitlists_tenant_idx
  ON waitlists(tenant_id);
CREATE INDEX IF NOT EXISTS waitlists_service_idx
  ON waitlists(service_id);
CREATE INDEX IF NOT EXISTS waitlists_status_idx
  ON waitlists(status);
-- Matching scan: find ACTIVE 'waiting' entries for a service. The
-- FIFO order (created_at ASC) is satisfied by a composite index.
CREATE INDEX IF NOT EXISTS waitlists_matching_idx
  ON waitlists(tenant_id, service_id, status, priority DESC, created_at ASC)
  WHERE status = 'waiting';
-- Idempotent customer joins: a single (tenant, service, email) can
-- only have ONE active queue entry at a time. Re-joins land on the
-- existing row.
CREATE UNIQUE INDEX IF NOT EXISTS waitlists_active_customer_unique
  ON waitlists(tenant_id, service_id, lower(customer_email))
  WHERE status IN ('waiting', 'notified');

CREATE TABLE IF NOT EXISTS waitlist_notifications (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waitlist_id             uuid NOT NULL REFERENCES waitlists(id) ON DELETE CASCADE,
  -- If a booking was cancelled/rescheduled and that's how the slot
  -- opened, we keep the originating booking for the audit trail.
  booking_id              uuid,
  -- 'slot_available' | 'reservation_expiring' | 'reservation_claimed'
  notification_type       varchar(30) NOT NULL,
  -- 'sent' | 'expired' | 'claimed' | 'failed'
  status                  varchar(20) NOT NULL DEFAULT 'sent',
  -- The slot being held — denormalized so we don't lose the offer
  -- if the originating booking gets re-confirmed somehow.
  staff_user_id           uuid,
  slot_start_at           timestamptz,
  slot_end_at             timestamptz,
  expires_at              timestamptz NOT NULL,
  responded_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waitlist_notifications_tenant_idx
  ON waitlist_notifications(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS waitlist_notifications_waitlist_idx
  ON waitlist_notifications(waitlist_id);
CREATE INDEX IF NOT EXISTS waitlist_notifications_expiry_idx
  ON waitlist_notifications(expires_at) WHERE status = 'sent';
-- Critical fairness guard: at most ONE active (status='sent', not yet
-- expired/claimed) notification per waitlist row. Prevents the
-- orchestrator + cron from creating parallel offers to the same
-- customer.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_notifications_unique_active
  ON waitlist_notifications(waitlist_id)
  WHERE status = 'sent';

COMMIT;
