-- ZentroMeet Production Launch Cleanup
-- Generated: 2026-05-27
-- Backup: /home/ubuntu/db-backups/prelaunch-cleanup-20260527T004146.sql.gz
-- Preserves: super admin sean@parafort.com + zentromeet tenant + plans + cron_runs

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- =============================================================================
-- Identity sanity check — abort entire transaction if super admin missing
-- =============================================================================
DO $$
DECLARE
  v_sa_user   uuid := '4e8cf7f1-8be8-4d3e-9c2d-3c0cc8fbc67b'::uuid;
  v_sa_tenant uuid := 'fbaab21b-17c5-4a31-acb4-7432920d53ea'::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_sa_user AND email = 'sean@parafort.com') THEN
    RAISE EXCEPTION 'ABORT: super admin user (sean@parafort.com) not found at id %', v_sa_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_sa_tenant AND slug = 'zentromeet') THEN
    RAISE EXCEPTION 'ABORT: super admin tenant (zentromeet) not found at id %', v_sa_tenant;
  END IF;
END
$$;

-- =============================================================================
-- BEFORE snapshot
-- =============================================================================
CREATE TEMP TABLE _before AS
SELECT 'tenants'                       AS t, count(*)::bigint AS n FROM tenants
UNION ALL SELECT 'users',                       count(*) FROM users
UNION ALL SELECT 'bookings',                    count(*) FROM bookings
UNION ALL SELECT 'customers',                   count(*) FROM customers
UNION ALL SELECT 'services',                    count(*) FROM services
UNION ALL SELECT 'service_staff',               count(*) FROM service_staff
UNION ALL SELECT 'availability',                count(*) FROM availability
UNION ALL SELECT 'availability_overrides',      count(*) FROM availability_overrides
UNION ALL SELECT 'departments',                 count(*) FROM departments
UNION ALL SELECT 'locations',                   count(*) FROM locations
UNION ALL SELECT 'tasks',                       count(*) FROM tasks
UNION ALL SELECT 'notifications',               count(*) FROM notifications
UNION ALL SELECT 'communication_logs',          count(*) FROM communication_logs
UNION ALL SELECT 'communication_templates',     count(*) FROM communication_templates
UNION ALL SELECT 'audit_logs',                  count(*) FROM audit_logs
UNION ALL SELECT 'billing_transactions',        count(*) FROM billing_transactions
UNION ALL SELECT 'calendar_connections',        count(*) FROM calendar_connections
UNION ALL SELECT 'calendar_events',             count(*) FROM calendar_events
UNION ALL SELECT 'calendar_sync_logs',          count(*) FROM calendar_sync_logs
UNION ALL SELECT 'tenant_health_snapshots',     count(*) FROM tenant_health_snapshots
UNION ALL SELECT 'tenant_feature_settings',     count(*) FROM tenant_feature_settings
UNION ALL SELECT 'tenant_governance_settings',  count(*) FROM tenant_governance_settings
UNION ALL SELECT 'tenant_enforcement_overrides',count(*) FROM tenant_enforcement_overrides
UNION ALL SELECT 'tenant_payment_providers',    count(*) FROM tenant_payment_providers
UNION ALL SELECT 'tenant_sms_providers',        count(*) FROM tenant_sms_providers
UNION ALL SELECT 'tenant_domains',              count(*) FROM tenant_domains
UNION ALL SELECT 'tenant_payment_webhook_events',count(*) FROM tenant_payment_webhook_events
UNION ALL SELECT 'analytics_daily_snapshots',   count(*) FROM analytics_daily_snapshots
UNION ALL SELECT 'analytics_snapshots_hourly',  count(*) FROM analytics_snapshots_hourly
UNION ALL SELECT 'analytics_snapshots_daily',   count(*) FROM analytics_snapshots_daily
UNION ALL SELECT 'financial_snapshots',         count(*) FROM financial_snapshots
UNION ALL SELECT 'announcements',               count(*) FROM announcements
UNION ALL SELECT 'promotions',                  count(*) FROM promotions
UNION ALL SELECT 'email_suppressions',          count(*) FROM email_suppressions
UNION ALL SELECT 'processed_stripe_events',     count(*) FROM processed_stripe_events
UNION ALL SELECT 'automation_rules',            count(*) FROM automation_rules
UNION ALL SELECT 'followup_automation_rules',   count(*) FROM followup_automation_rules
UNION ALL SELECT 'pending_automations',         count(*) FROM pending_automations
UNION ALL SELECT 'booking_rules',               count(*) FROM booking_rules
UNION ALL SELECT 'booking_series',              count(*) FROM booking_series
UNION ALL SELECT 'booking_occurrences',         count(*) FROM booking_occurrences
UNION ALL SELECT 'group_sessions',              count(*) FROM group_sessions
UNION ALL SELECT 'waitlists',                   count(*) FROM waitlists
UNION ALL SELECT 'waitlist_notifications',      count(*) FROM waitlist_notifications
UNION ALL SELECT 'intake_forms',                count(*) FROM intake_forms
UNION ALL SELECT 'intake_field_responses',      count(*) FROM intake_field_responses
UNION ALL SELECT 'external_calendar_feeds',     count(*) FROM external_calendar_feeds
UNION ALL SELECT 'external_feed_events',        count(*) FROM external_feed_events
UNION ALL SELECT 'staff_assignment_rules',      count(*) FROM staff_assignment_rules
UNION ALL SELECT 'staff_assignment_stats',      count(*) FROM staff_assignment_stats
UNION ALL SELECT 'staff_location_assignments',  count(*) FROM staff_location_assignments
UNION ALL SELECT 'staff_calendar_feed_tokens',  count(*) FROM staff_calendar_feed_tokens
UNION ALL SELECT 'review_request_rules',        count(*) FROM review_request_rules
UNION ALL SELECT 'scheduled_reports',           count(*) FROM scheduled_reports
UNION ALL SELECT 'webhook_channels',            count(*) FROM webhook_channels
UNION ALL SELECT 'session_audit_events',        count(*) FROM session_audit_events
UNION ALL SELECT 'password_reset_tokens',       count(*) FROM password_reset_tokens
UNION ALL SELECT 'export_audit_events',         count(*) FROM export_audit_events
UNION ALL SELECT 'revoked_session_jtis',        count(*) FROM revoked_session_jtis
UNION ALL SELECT 'freebusy_cache',              count(*) FROM freebusy_cache
UNION ALL SELECT 'embed_events',                count(*) FROM embed_events
UNION ALL SELECT 'help_events',                 count(*) FROM help_events
UNION ALL SELECT 'onboarding_events',           count(*) FROM onboarding_events
UNION ALL SELECT 'onboarding_intel_state',      count(*) FROM onboarding_intel_state
UNION ALL SELECT 'sync_drift_events',           count(*) FROM sync_drift_events
UNION ALL SELECT '*plans (preserved)',          count(*) FROM plans
UNION ALL SELECT '*cron_runs (preserved)',      count(*) FROM cron_runs;

-- =============================================================================
-- Step 1: clear RESTRICT-bound tables globally (the FKs that won't CASCADE)
-- =============================================================================
DELETE FROM bookings;
DELETE FROM availability;
DELETE FROM availability_overrides;
DELETE FROM service_staff;
DELETE FROM services;

-- =============================================================================
-- Step 2: delete all non-super-admin users
-- =============================================================================
DELETE FROM users WHERE id <> '4e8cf7f1-8be8-4d3e-9c2d-3c0cc8fbc67b';

-- =============================================================================
-- Step 3: delete all non-super-admin tenants (CASCADE clears child rows)
-- =============================================================================
DELETE FROM tenants WHERE id <> 'fbaab21b-17c5-4a31-acb4-7432920d53ea';

-- =============================================================================
-- Step 4: scrub remaining data inside the super-admin tenant
-- (keep only the super admin user + the tenant shell)
-- =============================================================================
DELETE FROM customers              WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM departments            WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM locations              WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tasks                  WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM notifications          WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM calendar_connections   WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM calendar_events        WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM calendar_sync_logs     WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM communication_logs     WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM communication_templates WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM automation_rules       WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM followup_automation_rules WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM pending_automations    WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM booking_rules          WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM staff_assignment_rules WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM staff_assignment_stats WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM staff_location_assignments WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM staff_calendar_feed_tokens WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM external_feed_events   WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM external_calendar_feeds WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM intake_field_responses WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM intake_forms           WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM waitlist_notifications WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM waitlists              WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM group_sessions         WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM booking_occurrences    WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM booking_series         WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM billing_transactions   WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_health_snapshots WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM analytics_daily_snapshots WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_payment_webhook_events WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_payment_providers WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_sms_providers   WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_domains         WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_feature_settings WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_governance_settings WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM tenant_enforcement_overrides WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM webhook_channels       WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM review_request_rules   WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';
DELETE FROM scheduled_reports      WHERE tenant_id = 'fbaab21b-17c5-4a31-acb4-7432920d53ea';

-- Global wipes — anything tenant-scoped or user-scoped (CASCADE already covered most)
DELETE FROM sync_drift_events;
DELETE FROM embed_events;
DELETE FROM help_events;
DELETE FROM onboarding_events;
DELETE FROM onboarding_intel_state;
DELETE FROM freebusy_cache;
DELETE FROM session_audit_events;
DELETE FROM password_reset_tokens;
DELETE FROM export_audit_events;
DELETE FROM revoked_session_jtis;
DELETE FROM audit_logs;

-- =============================================================================
-- Step 5: clear platform-wide test/synthetic data (no tenant_id)
-- =============================================================================
DELETE FROM announcements;             -- seeded examples (Phase #325)
DELETE FROM promotions;                -- test promotions
DELETE FROM email_suppressions;        -- synthetic bounces
DELETE FROM processed_stripe_events;   -- synthetic webhook idempotency
DELETE FROM analytics_snapshots_hourly;
DELETE FROM analytics_snapshots_daily;
DELETE FROM financial_snapshots;

-- PRESERVED INTENTIONALLY:
--   plans               (plan definitions / pricing config)
--   cron_runs           (infra telemetry — operational integrity)
--   All schema, all migrations, all enum types, all FKs

-- =============================================================================
-- AFTER snapshot
-- =============================================================================
CREATE TEMP TABLE _after AS
SELECT 'tenants'                       AS t, count(*)::bigint AS n FROM tenants
UNION ALL SELECT 'users',                       count(*) FROM users
UNION ALL SELECT 'bookings',                    count(*) FROM bookings
UNION ALL SELECT 'customers',                   count(*) FROM customers
UNION ALL SELECT 'services',                    count(*) FROM services
UNION ALL SELECT 'service_staff',               count(*) FROM service_staff
UNION ALL SELECT 'availability',                count(*) FROM availability
UNION ALL SELECT 'availability_overrides',      count(*) FROM availability_overrides
UNION ALL SELECT 'departments',                 count(*) FROM departments
UNION ALL SELECT 'locations',                   count(*) FROM locations
UNION ALL SELECT 'tasks',                       count(*) FROM tasks
UNION ALL SELECT 'notifications',               count(*) FROM notifications
UNION ALL SELECT 'communication_logs',          count(*) FROM communication_logs
UNION ALL SELECT 'communication_templates',     count(*) FROM communication_templates
UNION ALL SELECT 'audit_logs',                  count(*) FROM audit_logs
UNION ALL SELECT 'billing_transactions',        count(*) FROM billing_transactions
UNION ALL SELECT 'calendar_connections',        count(*) FROM calendar_connections
UNION ALL SELECT 'calendar_events',             count(*) FROM calendar_events
UNION ALL SELECT 'calendar_sync_logs',          count(*) FROM calendar_sync_logs
UNION ALL SELECT 'tenant_health_snapshots',     count(*) FROM tenant_health_snapshots
UNION ALL SELECT 'tenant_feature_settings',     count(*) FROM tenant_feature_settings
UNION ALL SELECT 'tenant_governance_settings',  count(*) FROM tenant_governance_settings
UNION ALL SELECT 'tenant_enforcement_overrides',count(*) FROM tenant_enforcement_overrides
UNION ALL SELECT 'tenant_payment_providers',    count(*) FROM tenant_payment_providers
UNION ALL SELECT 'tenant_sms_providers',        count(*) FROM tenant_sms_providers
UNION ALL SELECT 'tenant_domains',              count(*) FROM tenant_domains
UNION ALL SELECT 'tenant_payment_webhook_events',count(*) FROM tenant_payment_webhook_events
UNION ALL SELECT 'analytics_daily_snapshots',   count(*) FROM analytics_daily_snapshots
UNION ALL SELECT 'analytics_snapshots_hourly',  count(*) FROM analytics_snapshots_hourly
UNION ALL SELECT 'analytics_snapshots_daily',   count(*) FROM analytics_snapshots_daily
UNION ALL SELECT 'financial_snapshots',         count(*) FROM financial_snapshots
UNION ALL SELECT 'announcements',               count(*) FROM announcements
UNION ALL SELECT 'promotions',                  count(*) FROM promotions
UNION ALL SELECT 'email_suppressions',          count(*) FROM email_suppressions
UNION ALL SELECT 'processed_stripe_events',     count(*) FROM processed_stripe_events
UNION ALL SELECT 'automation_rules',            count(*) FROM automation_rules
UNION ALL SELECT 'followup_automation_rules',   count(*) FROM followup_automation_rules
UNION ALL SELECT 'pending_automations',         count(*) FROM pending_automations
UNION ALL SELECT 'booking_rules',               count(*) FROM booking_rules
UNION ALL SELECT 'booking_series',              count(*) FROM booking_series
UNION ALL SELECT 'booking_occurrences',         count(*) FROM booking_occurrences
UNION ALL SELECT 'group_sessions',              count(*) FROM group_sessions
UNION ALL SELECT 'waitlists',                   count(*) FROM waitlists
UNION ALL SELECT 'waitlist_notifications',      count(*) FROM waitlist_notifications
UNION ALL SELECT 'intake_forms',                count(*) FROM intake_forms
UNION ALL SELECT 'intake_field_responses',      count(*) FROM intake_field_responses
UNION ALL SELECT 'external_calendar_feeds',     count(*) FROM external_calendar_feeds
UNION ALL SELECT 'external_feed_events',        count(*) FROM external_feed_events
UNION ALL SELECT 'staff_assignment_rules',      count(*) FROM staff_assignment_rules
UNION ALL SELECT 'staff_assignment_stats',      count(*) FROM staff_assignment_stats
UNION ALL SELECT 'staff_location_assignments',  count(*) FROM staff_location_assignments
UNION ALL SELECT 'staff_calendar_feed_tokens',  count(*) FROM staff_calendar_feed_tokens
UNION ALL SELECT 'review_request_rules',        count(*) FROM review_request_rules
UNION ALL SELECT 'scheduled_reports',           count(*) FROM scheduled_reports
UNION ALL SELECT 'webhook_channels',            count(*) FROM webhook_channels
UNION ALL SELECT 'session_audit_events',        count(*) FROM session_audit_events
UNION ALL SELECT 'password_reset_tokens',       count(*) FROM password_reset_tokens
UNION ALL SELECT 'export_audit_events',         count(*) FROM export_audit_events
UNION ALL SELECT 'revoked_session_jtis',        count(*) FROM revoked_session_jtis
UNION ALL SELECT 'freebusy_cache',              count(*) FROM freebusy_cache
UNION ALL SELECT 'embed_events',                count(*) FROM embed_events
UNION ALL SELECT 'help_events',                 count(*) FROM help_events
UNION ALL SELECT 'onboarding_events',           count(*) FROM onboarding_events
UNION ALL SELECT 'onboarding_intel_state',      count(*) FROM onboarding_intel_state
UNION ALL SELECT 'sync_drift_events',           count(*) FROM sync_drift_events
UNION ALL SELECT '*plans (preserved)',          count(*) FROM plans
UNION ALL SELECT '*cron_runs (preserved)',      count(*) FROM cron_runs;

-- =============================================================================
-- Reports
-- =============================================================================
\echo
\echo '====================== DELETION REPORT ======================'
SELECT b.t AS table_name, b.n AS before_count, a.n AS after_count, (b.n - a.n) AS deleted
FROM _before b JOIN _after a USING (t)
WHERE b.n <> a.n OR b.t LIKE '*%'
ORDER BY (b.n - a.n) DESC, b.t;

\echo
\echo '====================== PRESERVED IDENTITY ======================'
SELECT 'super admin user' AS what, id, email, role, name FROM users WHERE id='4e8cf7f1-8be8-4d3e-9c2d-3c0cc8fbc67b';
SELECT 'remaining tenant' AS what, id, slug, name, current_plan FROM tenants;
SELECT 'plan rows preserved' AS what, slug, name, price_monthly_cents FROM plans ORDER BY price_monthly_cents NULLS FIRST;

COMMIT;
