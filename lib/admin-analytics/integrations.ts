/**
 * SA-3 Section B — Provider integration health matrix.
 *
 * Five providers × 8 metrics per provider. All values from real DB
 * queries; providers without data return zero counts (NOT mocked).
 *
 *   • Google Calendar    — users.google_*
 *   • Microsoft Calendar — users.microsoft_*  (if columns exist;
 *                          otherwise gracefully returns zeros)
 *   • Zoom               — currently no DB columns; placeholder
 *                          provider that returns all-zero with a
 *                          status of 'not_configured' so the UI
 *                          can show "Connect Zoom" instead of
 *                          fake metrics
 *   • Stripe             — payment_connections + billing_transactions
 *   • AWS SES            — email_suppressions + communication_logs
 *                          + smtp_transport health
 *
 * Each row carries per-provider drilldown data: the list of tenant
 * ids with broken connections, used by the UI's tenant-drilldown modal.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

export type ProviderKey = "google" | "microsoft" | "zoom" | "stripe" | "ses";

export type IntegrationProvider = {
  key: ProviderKey;
  label: string;
  status: "healthy" | "degraded" | "critical" | "not_configured";
  connectedTenants: number;
  activeTokens: number;
  expiredTokens: number;
  refreshFailures: number;
  webhookFailures: number;
  syncQueueSize: number;
  apiErrorRate: number | null;
  avgSyncLatencyMs: number | null;
  /** Tenant ids affected by current failures — used by the
   *  drilldown modal. Bounded to 20 to keep payloads small. */
  affectedTenantIds: string[];
  /** Human-readable status detail for the matrix row. */
  detail: string;
  error?: string;
};

export type IntegrationsMatrix = {
  providers: IntegrationProvider[];
  generatedAt: string;
  computedInMs: number;
};

async function safe(producer: () => Promise<IntegrationProvider>, fallback: IntegrationProvider): Promise<IntegrationProvider> {
  try {
    return await producer();
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    try {
      console.error(JSON.stringify({ evt: "integrations_provider_fail", reason }));
    } catch {}
    return { ...fallback, error: reason };
  }
}

function pickStatus(failures: number, expired: number): IntegrationProvider["status"] {
  if (failures > 5 || expired > 5) return "critical";
  if (failures > 0 || expired > 0) return "degraded";
  return "healthy";
}

// ─── Provider builders ─────────────────────────────────────────────

async function buildGoogle(): Promise<IntegrationProvider> {
  const base: IntegrationProvider = {
    key: "google",
    label: "Google Calendar",
    status: "healthy",
    connectedTenants: 0,
    activeTokens: 0,
    expiredTokens: 0,
    refreshFailures: 0,
    webhookFailures: 0,
    syncQueueSize: 0,
    apiErrorRate: null,
    avgSyncLatencyMs: null,
    affectedTenantIds: [],
    detail: "",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(DISTINCT u.tenant_id)::int FROM users u WHERE u.google_refresh_token IS NOT NULL) AS connected_tenants,
            (SELECT COUNT(*)::int FROM users WHERE google_refresh_token IS NOT NULL AND (google_status IS NULL OR google_status NOT IN ('expired','error'))) AS active_tokens,
            (SELECT COUNT(*)::int FROM users WHERE google_refresh_token IS NOT NULL AND google_status IN ('expired','error')) AS expired_tokens,
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'google%refresh%fail%' AND created_at > NOW() - INTERVAL '7 days') AS refresh_failures,
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'google%webhook%fail%' AND created_at > NOW() - INTERVAL '7 days') AS webhook_failures`,
    )) as unknown as Array<{
      connected_tenants: number;
      active_tokens: number;
      expired_tokens: number;
      refresh_failures: number;
      webhook_failures: number;
    }>;
    const r = rows[0];
    base.connectedTenants = Number(r?.connected_tenants ?? 0);
    base.activeTokens = Number(r?.active_tokens ?? 0);
    base.expiredTokens = Number(r?.expired_tokens ?? 0);
    base.refreshFailures = Number(r?.refresh_failures ?? 0);
    base.webhookFailures = Number(r?.webhook_failures ?? 0);
    // Affected tenant ids (top 20 with expired Google)
    const affected = (await db.execute(
      sql`SELECT DISTINCT u.tenant_id::text AS id
            FROM users u
           WHERE u.google_refresh_token IS NOT NULL
             AND u.google_status IN ('expired','error')
           LIMIT 20`,
    )) as unknown as Array<{ id: string }>;
    base.affectedTenantIds = affected.map((x) => x.id);
    base.status = pickStatus(base.refreshFailures + base.webhookFailures, base.expiredTokens);
    base.detail =
      base.connectedTenants === 0
        ? "Not yet connected by any tenant"
        : base.status === "healthy"
        ? `${base.activeTokens} active`
        : `${base.expiredTokens} expired token${base.expiredTokens === 1 ? "" : "s"}`;
    return base;
  }, base);
}

async function buildMicrosoft(): Promise<IntegrationProvider> {
  const base: IntegrationProvider = {
    key: "microsoft",
    label: "Microsoft Calendar",
    status: "healthy",
    connectedTenants: 0,
    activeTokens: 0,
    expiredTokens: 0,
    refreshFailures: 0,
    webhookFailures: 0,
    syncQueueSize: 0,
    apiErrorRate: null,
    avgSyncLatencyMs: null,
    affectedTenantIds: [],
    detail: "",
  };
  return safe(async () => {
    // Use calendar_connections table (provider='microsoft') if it
    // exists in this codebase — it was created in earlier phases.
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(DISTINCT tenant_id)::int FROM calendar_connections WHERE provider='microsoft') AS connected_tenants,
            (SELECT COUNT(*)::int FROM calendar_connections WHERE provider='microsoft' AND (status IS NULL OR status NOT IN ('needs_reconnect','expired','error'))) AS active_tokens,
            (SELECT COUNT(*)::int FROM calendar_connections WHERE provider='microsoft' AND status IN ('needs_reconnect','expired','error')) AS expired_tokens,
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'microsoft%refresh%fail%' AND created_at > NOW() - INTERVAL '7 days') AS refresh_failures,
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'microsoft%webhook%fail%' AND created_at > NOW() - INTERVAL '7 days') AS webhook_failures`,
    )) as unknown as Array<{
      connected_tenants: number;
      active_tokens: number;
      expired_tokens: number;
      refresh_failures: number;
      webhook_failures: number;
    }>;
    const r = rows[0];
    base.connectedTenants = Number(r?.connected_tenants ?? 0);
    base.activeTokens = Number(r?.active_tokens ?? 0);
    base.expiredTokens = Number(r?.expired_tokens ?? 0);
    base.refreshFailures = Number(r?.refresh_failures ?? 0);
    base.webhookFailures = Number(r?.webhook_failures ?? 0);
    const affected = (await db.execute(
      sql`SELECT DISTINCT tenant_id::text AS id
            FROM calendar_connections
           WHERE provider='microsoft'
             AND status IN ('needs_reconnect','expired','error')
           LIMIT 20`,
    )) as unknown as Array<{ id: string }>;
    base.affectedTenantIds = affected.map((x) => x.id);
    base.status = pickStatus(base.refreshFailures + base.webhookFailures, base.expiredTokens);
    base.detail =
      base.connectedTenants === 0
        ? "Not yet connected by any tenant"
        : base.status === "healthy"
        ? `${base.activeTokens} active`
        : `${base.expiredTokens} expired connection${base.expiredTokens === 1 ? "" : "s"}`;
    return base;
  }, base);
}

async function buildZoom(): Promise<IntegrationProvider> {
  // Zoom integration is documented as roadmap; we surface it as
  // 'not_configured' so the UI shows "Configure Zoom" instead of
  // fake zero metrics that look like everything is healthy.
  return {
    key: "zoom",
    label: "Zoom",
    status: "not_configured",
    connectedTenants: 0,
    activeTokens: 0,
    expiredTokens: 0,
    refreshFailures: 0,
    webhookFailures: 0,
    syncQueueSize: 0,
    apiErrorRate: null,
    avgSyncLatencyMs: null,
    affectedTenantIds: [],
    detail: "Provider not yet wired into platform",
  };
}

async function buildStripe(): Promise<IntegrationProvider> {
  const base: IntegrationProvider = {
    key: "stripe",
    label: "Stripe",
    status: "healthy",
    connectedTenants: 0,
    activeTokens: 0,
    expiredTokens: 0,
    refreshFailures: 0,
    webhookFailures: 0,
    syncQueueSize: 0,
    apiErrorRate: null,
    avgSyncLatencyMs: null,
    affectedTenantIds: [],
    detail: "",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(DISTINCT t.id)::int FROM tenants t WHERE t.stripe_customer_id IS NOT NULL) AS connected,
            (SELECT COUNT(*)::int FROM tenants WHERE subscription_status IN ('active','trialing','past_due')) AS active_subs,
            (SELECT COUNT(*)::int FROM tenants WHERE subscription_status = 'past_due') AS past_due,
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'stripe%webhook%fail%' AND created_at > NOW() - INTERVAL '7 days') AS webhook_failures,
            (SELECT COUNT(*)::int FROM billing_transactions WHERE created_at > NOW() - INTERVAL '7 days') AS events_7d`,
    )) as unknown as Array<{
      connected: number;
      active_subs: number;
      past_due: number;
      webhook_failures: number;
      events_7d: number;
    }>;
    const r = rows[0];
    base.connectedTenants = Number(r?.connected ?? 0);
    base.activeTokens = Number(r?.active_subs ?? 0);
    base.expiredTokens = Number(r?.past_due ?? 0); // past_due = subscription needs attention
    base.webhookFailures = Number(r?.webhook_failures ?? 0);
    const events = Number(r?.events_7d ?? 0);
    base.apiErrorRate =
      events > 0 ? Math.round((base.webhookFailures / (events + base.webhookFailures)) * 1000) / 10 : null;
    const affected = (await db.execute(
      sql`SELECT id::text AS id FROM tenants WHERE subscription_status='past_due' LIMIT 20`,
    )) as unknown as Array<{ id: string }>;
    base.affectedTenantIds = affected.map((x) => x.id);
    base.status = pickStatus(base.webhookFailures, base.expiredTokens);
    base.detail = `${events} event${events === 1 ? "" : "s"} (7d) · ${base.activeTokens} active subs`;
    return base;
  }, base);
}

async function buildSes(): Promise<IntegrationProvider> {
  const base: IntegrationProvider = {
    key: "ses",
    label: "AWS SES",
    status: "healthy",
    connectedTenants: 0,
    activeTokens: 0,
    expiredTokens: 0,
    refreshFailures: 0,
    webhookFailures: 0,
    syncQueueSize: 0,
    apiErrorRate: null,
    avgSyncLatencyMs: null,
    affectedTenantIds: [],
    detail: "",
  };
  return safe(async () => {
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(*)::int FROM communication_logs WHERE status='sent'   AND created_at > NOW() - INTERVAL '24 hours') AS sent_24h,
            (SELECT COUNT(*)::int FROM communication_logs WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours') AS failed_24h,
            (SELECT COUNT(*)::int FROM email_suppressions WHERE kind='bounce'    AND last_seen_at > NOW() - INTERVAL '24 hours') AS bounces_24h,
            (SELECT COUNT(*)::int FROM email_suppressions WHERE kind='complaint' AND last_seen_at > NOW() - INTERVAL '24 hours') AS complaints_24h,
            (SELECT COUNT(*)::int FROM email_suppressions)                                  AS suppressions_total`,
    )) as unknown as Array<{
      sent_24h: number;
      failed_24h: number;
      bounces_24h: number;
      complaints_24h: number;
      suppressions_total: number;
    }>;
    const r = rows[0];
    const sent = Number(r?.sent_24h ?? 0);
    const failed = Number(r?.failed_24h ?? 0);
    const bounces = Number(r?.bounces_24h ?? 0);
    const complaints = Number(r?.complaints_24h ?? 0);
    const denom = sent + failed;
    base.connectedTenants = 1; // SES is a single platform-level provider
    base.activeTokens = sent;
    base.refreshFailures = bounces + complaints;
    base.webhookFailures = 0; // SNS endpoint authenticated; no failures observable here
    base.expiredTokens = Number(r?.suppressions_total ?? 0);
    base.apiErrorRate = denom > 0 ? Math.round((failed / denom) * 1000) / 10 : null;
    base.status = pickStatus(complaints, bounces);
    base.detail =
      denom === 0
        ? "No email activity in 24h"
        : `${sent} sent · ${failed} failed · ${bounces}B/${complaints}C suppressed`;
    return base;
  }, base);
}

// ─── Orchestrator ──────────────────────────────────────────────────

export async function computeIntegrationsMatrix(): Promise<IntegrationsMatrix> {
  return memoize(
    "admin:integrations:v1",
    async () => {
      const t0 = Date.now();
      const providers = await Promise.all([
        buildGoogle(),
        buildMicrosoft(),
        buildZoom(),
        buildStripe(),
        buildSes(),
      ]);
      return {
        providers,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    30_000,
  );
}
