-- Wave C — Microsoft Outlook + Teams as a first-class provider.
--
-- No schema change is required for the new provider:
--   • calendar_connections.provider is varchar(20) — accepts "microsoft"
--     alongside the existing "google" values with zero migration cost.
--   • calendar_sync_logs.provider is varchar(20) — same.
--   • The encryption envelope, retry counters, reconnect-email dedupe
--     and all Wave A health columns work identically for any provider.
--
-- What this migration DOES do:
--   1. Add a partial index that speeds up the new orchestrator's
--      `pickConnectionForWrite` lookups (which key on (userId, provider,
--      status='active')). Without this, every booking write does a
--      sequential scan across calendar_connections — fine today, slow
--      once we have thousands of staff.
--
--   2. Acts as a documentation breadcrumb so a fresh-clone DB inspector
--      can see WHEN Microsoft support landed. The migration's mere
--      existence is the audit trail.
--
-- No data backfill, no constraint changes, no enum changes — additive
-- and safe to re-run (IF NOT EXISTS gates everything).

CREATE INDEX IF NOT EXISTS calendar_connections_user_provider_active_idx
  ON calendar_connections (user_id, provider)
  WHERE status = 'active';

-- Sync-log queries filter by (tenant, provider, kind, created_at) for
-- the per-provider health surface on the dashboard. The existing
-- tenant_idx covers (tenantId, createdAt); adding provider into the
-- mix as a second index lets the planner pick whichever wins.
CREATE INDEX IF NOT EXISTS calendar_sync_logs_tenant_provider_idx
  ON calendar_sync_logs (tenant_id, provider, created_at DESC);
