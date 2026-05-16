-- 0008_notifications_and_tasks.sql
-- Notifications + Tasks (operational collaboration layer).
-- Additive only. EXCLUDE constraint untouched.

BEGIN;

-- 1. notifications -------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  kind         varchar(60)  NOT NULL,
  title        varchar(200) NOT NULL,
  body         text,
  link         text,
  read_at      timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_time_idx
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_tenant_idx
  ON notifications (tenant_id);

-- 2. tasks ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title               varchar(200) NOT NULL,
  description         text,
  status              varchar(20) NOT NULL DEFAULT 'open',
  due_at              timestamptz,
  assigned_user_id    uuid REFERENCES users(id)     ON DELETE SET NULL,
  related_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  related_booking_id  uuid REFERENCES bookings(id)  ON DELETE SET NULL,
  created_by_user_id  uuid REFERENCES users(id)     ON DELETE SET NULL,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_tenant_status_idx ON tasks (tenant_id, status);
CREATE INDEX IF NOT EXISTS tasks_assigned_idx     ON tasks (assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_customer_idx     ON tasks (related_customer_id) WHERE related_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_booking_idx      ON tasks (related_booking_id)  WHERE related_booking_id IS NOT NULL;

-- 3. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;
