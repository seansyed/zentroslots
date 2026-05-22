-- Phase 5 of billing enforcement — Downgrade enforcement orchestrator.
--
-- Two additions:
--   1. `tenant_enforcement_overrides` — operator-controlled per-(tenant,
--      capability) policy override. Default policy is GRANDFATHERED per
--      capability (set in lib/billing/enforcement/policies.ts). Operators
--      can override per tenant to SOFT (default + warn) or HARD (pause /
--      disable). Includes optional `expires_at` for time-bounded grace
--      periods and `granted_by` for support audit trail.
--
--   2. Enforcement-pause columns on `booking_series` — the worked
--      example feature for the RECURRING handler. Three columns added:
--        - enforcement_paused_at: when the orchestrator paused the row
--        - enforcement_paused_reason: a closed-set string identifying
--          WHY ("downgrade_to_free", "billing_suspension", etc.)
--        - enforcement_event_id: idempotency key — usually a Stripe
--          event_id. Re-running the orchestrator with the same
--          event_id is a no-op.
--
-- Why this design:
--   - Three columns instead of a separate `enforcement_state` table
--     keeps the per-row "is this paused?" check in the natural read
--     path. The cron's existing `WHERE status='active'` extends to
--     `AND enforcement_paused_at IS NULL` — one extra predicate, no
--     join.
--   - `enforcement_paused_at IS NOT NULL` is the canonical "paused"
--     marker. Reactivation clears it. The series's user-facing
--     `status` column stays untouched ('active' / 'paused' / 'cancelled'
--     remain user-set values). Enforcement and user-pause are two
--     separate axes.
--
-- This migration only adds columns to `booking_series` because that's
-- the worked example feature for the first cut of the orchestrator.
-- Other premium features (automation_rules, routing_rules, etc.)
-- get the same columns added in follow-up migrations as their
-- handlers ship.
--
-- All ALTERs are additive. Existing rows continue to work; new columns
-- stay NULL until the orchestrator paints them.

CREATE TABLE IF NOT EXISTS tenant_enforcement_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- A capability name from lib/billing/capabilities.ts Capability union
  -- (recurring_series, automation_rules, etc.). Validated at write time
  -- in TypeScript; stored as varchar for forward compatibility.
  capability      varchar(60) NOT NULL,
  -- Enforcement mode: 'soft' | 'grandfathered' | 'hard'. See
  -- lib/billing/enforcement/types.ts for the closed union.
  mode            varchar(20) NOT NULL,
  -- Optional time-bounded grace period. NULL = no expiry.
  expires_at      timestamptz,
  -- Who granted the override (admin user id or support label) for the
  -- audit trail. NULL when set via direct SQL.
  granted_by      varchar(120),
  -- Free-text reason ("courtesy grace period", "support escalation
  -- 1234", "beta access for routing v2").
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One override per (tenant, capability) at a time. Re-assigning replaces.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_enforcement_overrides_unique
  ON tenant_enforcement_overrides(tenant_id, capability);

CREATE INDEX IF NOT EXISTS tenant_enforcement_overrides_tenant_idx
  ON tenant_enforcement_overrides(tenant_id);

-- Add enforcement-state columns to booking_series. All NULL by default —
-- existing series unaffected.
ALTER TABLE booking_series
  ADD COLUMN IF NOT EXISTS enforcement_paused_at     timestamptz,
  ADD COLUMN IF NOT EXISTS enforcement_paused_reason varchar(60),
  ADD COLUMN IF NOT EXISTS enforcement_event_id      varchar(120);

-- Partial index for the cron's hot path: "find paused series for THIS
-- event_id" — the executor uses this to detect "already paused by me,
-- skip" without scanning the whole table.
CREATE INDEX IF NOT EXISTS booking_series_enforcement_event_idx
  ON booking_series(enforcement_event_id)
  WHERE enforcement_event_id IS NOT NULL;
