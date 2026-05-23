/**
 * Operational Hardening Wave — payment-vault metrics aggregator.
 *
 * Single source of truth for the counts surfaced on:
 *   • /api/health (global, cross-tenant rollup — no tenant data leaked)
 *   • /api/tenant/payment-ops/summary (per-tenant breakdown, admin-only)
 *
 * Every query here MUST be lightweight (COUNT with simple WHERE clauses,
 * no joins on giant tables). Safe under load — /api/health is hit by
 * uptime checkers many times per minute.
 */

import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  tenantPaymentProviders,
  tenantPaymentWebhookEvents,
} from "@/db/schema";

/** Global rollup — cross-tenant counts only. NEVER includes tenant ids,
 *  provider ids, or any identifying detail. Safe to return from the
 *  public /api/health endpoint. */
export interface GlobalPaymentVaultMetrics {
  /** Total enabled providers across all tenants. */
  providersTotal: number;
  /** Providers with status='invalid'. */
  providersInvalid: number;
  /** Providers with webhook_status='failing'. */
  providersWebhookFailing: number;
  /** Providers whose last_verified_at is older than 7 days. */
  providersStaleVerify7d: number;
  /** Bookings in 'pending_payment' past their hold expiry — cron should
   *  have cancelled these. Non-zero indicates the cron is failing. */
  pendingPaymentBacklog: number;
  /** Webhook signature failures recorded in the last 24h. */
  webhookFailures24h: number;
  /** Events flagged as orphan (no booking match) in the last 24h. */
  orphans24h: number;
  /** Most recent verified webhook event across all tenants (ISO string). */
  lastWebhookEventAt: string | null;
}

/** Per-tenant breakdown for the admin ops dashboard. Adds provider-level
 *  detail that the public health endpoint must NOT expose. */
export interface TenantPaymentVaultMetrics extends GlobalPaymentVaultMetrics {
  /** Per-(provider, mode) row showing operational state. */
  providers: Array<{
    id: string;
    provider: string;
    mode: string;
    accountLabel: string;
    status: string;
    enabled: boolean;
    isDefault: boolean;
    webhookStatus: string;
    lastVerifiedAt: string | null;
    lastPaymentEventAt: string | null;
    lastWebhookVerifiedAt: string | null;
    lastWebhookErrorAt: string | null;
  }>;
  /** Bookings stuck in pending_payment in this tenant. */
  pendingActive: number;
}

// ─── Global (for /api/health) ──────────────────────────────────────────

/**
 * Soft-fails on individual sub-query errors. Returns a metrics object
 * with zero-values for any failing query rather than throwing — the
 * health endpoint must never 500 on a slow optional aggregate.
 */
export async function getGlobalPaymentVaultMetrics(): Promise<GlobalPaymentVaultMetrics> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  const z = (fn: () => Promise<number>) =>
    fn().catch(() => 0);
  const safeDate = (fn: () => Promise<string | null>) =>
    fn().catch<string | null>(() => null);

  const [
    providersTotal,
    providersInvalid,
    providersWebhookFailing,
    providersStaleVerify7d,
    pendingPaymentBacklog,
    webhookFailures24h,
    orphans24h,
    lastWebhookEventAt,
  ] = await Promise.all([
    z(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(eq(tenantPaymentProviders.enabled, true));
      return r[0]?.c ?? 0;
    }),
    z(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.enabled, true),
            eq(tenantPaymentProviders.status, "invalid"),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    z(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.enabled, true),
            eq(tenantPaymentProviders.webhookStatus, "failing"),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    z(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.enabled, true),
            eq(tenantPaymentProviders.status, "verified"),
            lt(tenantPaymentProviders.lastVerifiedAt, sevenDaysAgo),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    z(async () => {
      // "Backlog" = pending_payment bookings whose hold expired more
      // than 5 minutes ago. Cron runs every 5 min so anything older is
      // a real signal that cron is failing.
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.status, "pending_payment"),
            isNotNull(bookings.paymentHoldExpiresAt),
            lt(bookings.paymentHoldExpiresAt, fiveMinAgo),
            // Only count Wave H bookings — legacy backlogs have their
            // own existing health signal.
            isNotNull(bookings.paymentProviderId),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    z(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentWebhookEvents)
        .where(
          and(
            eq(tenantPaymentWebhookEvents.status, "invalid_signature"),
            gte(tenantPaymentWebhookEvents.receivedAt, twentyFourHoursAgo),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    z(async () => {
      // Orphan-class events: status in (unhandled, replay) with no
      // booking_id resolved. "replay" without a booking_id is just an
      // unhandled event type; the real orphan signal is unhandled-no-
      // booking. We count both for visibility.
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentWebhookEvents)
        .where(
          and(
            isNull(tenantPaymentWebhookEvents.bookingId),
            eq(tenantPaymentWebhookEvents.status, "unhandled"),
            gte(tenantPaymentWebhookEvents.receivedAt, twentyFourHoursAgo),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeDate(async () => {
      const r = await db
        .select({ at: sql<string>`MAX(received_at)::text` })
        .from(tenantPaymentWebhookEvents)
        .where(eq(tenantPaymentWebhookEvents.status, "processed"));
      return r[0]?.at ?? null;
    }),
  ]);

  return {
    providersTotal,
    providersInvalid,
    providersWebhookFailing,
    providersStaleVerify7d,
    pendingPaymentBacklog,
    webhookFailures24h,
    orphans24h,
    lastWebhookEventAt,
  };
}

/** Derives the boolean ok flag from a metrics snapshot. Only escalates
 *  on true operational issues — stale-verify and orphan counters are
 *  surfaced but don't toggle ok=false. */
export function paymentVaultHealthOk(m: GlobalPaymentVaultMetrics): boolean {
  return (
    m.providersInvalid === 0 &&
    m.providersWebhookFailing === 0 &&
    m.pendingPaymentBacklog === 0
  );
}

// ─── Per-tenant (for admin ops dashboard) ───────────────────────────────

export async function getTenantPaymentVaultMetrics(
  tenantId: string,
): Promise<TenantPaymentVaultMetrics> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  const safeNum = <T extends number>(fn: () => Promise<T>) =>
    fn().catch(() => 0 as T);

  const providersPromise = db
    .select({
      id: tenantPaymentProviders.id,
      provider: tenantPaymentProviders.provider,
      mode: tenantPaymentProviders.mode,
      accountLabel: tenantPaymentProviders.accountLabel,
      status: tenantPaymentProviders.status,
      enabled: tenantPaymentProviders.enabled,
      isDefault: tenantPaymentProviders.isDefault,
      webhookStatus: tenantPaymentProviders.webhookStatus,
      lastVerifiedAt: tenantPaymentProviders.lastVerifiedAt,
      lastPaymentEventAt: tenantPaymentProviders.lastPaymentEventAt,
      lastWebhookVerifiedAt: tenantPaymentProviders.lastWebhookVerifiedAt,
      lastWebhookErrorAt: tenantPaymentProviders.lastWebhookErrorAt,
    })
    .from(tenantPaymentProviders)
    .where(eq(tenantPaymentProviders.tenantId, tenantId));

  const [
    providers,
    providersTotal,
    providersInvalid,
    providersWebhookFailing,
    providersStaleVerify7d,
    pendingPaymentBacklog,
    pendingActive,
    webhookFailures24h,
    orphans24h,
    lastWebhookEventAt,
  ] = await Promise.all([
    providersPromise,
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.tenantId, tenantId),
            eq(tenantPaymentProviders.enabled, true),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.tenantId, tenantId),
            eq(tenantPaymentProviders.enabled, true),
            eq(tenantPaymentProviders.status, "invalid"),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.tenantId, tenantId),
            eq(tenantPaymentProviders.enabled, true),
            eq(tenantPaymentProviders.webhookStatus, "failing"),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentProviders)
        .where(
          and(
            eq(tenantPaymentProviders.tenantId, tenantId),
            eq(tenantPaymentProviders.enabled, true),
            eq(tenantPaymentProviders.status, "verified"),
            lt(tenantPaymentProviders.lastVerifiedAt, sevenDaysAgo),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            eq(bookings.status, "pending_payment"),
            isNotNull(bookings.paymentHoldExpiresAt),
            lt(bookings.paymentHoldExpiresAt, fiveMinAgo),
            isNotNull(bookings.paymentProviderId),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, tenantId),
            eq(bookings.status, "pending_payment"),
            isNotNull(bookings.paymentProviderId),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentWebhookEvents)
        .where(
          and(
            eq(tenantPaymentWebhookEvents.tenantId, tenantId),
            eq(tenantPaymentWebhookEvents.status, "invalid_signature"),
            gte(tenantPaymentWebhookEvents.receivedAt, twentyFourHoursAgo),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    safeNum(async () => {
      const r = await db
        .select({ c: sql<number>`COUNT(*)::int` })
        .from(tenantPaymentWebhookEvents)
        .where(
          and(
            eq(tenantPaymentWebhookEvents.tenantId, tenantId),
            isNull(tenantPaymentWebhookEvents.bookingId),
            eq(tenantPaymentWebhookEvents.status, "unhandled"),
            gte(tenantPaymentWebhookEvents.receivedAt, twentyFourHoursAgo),
          ),
        );
      return r[0]?.c ?? 0;
    }),
    (async () => {
      try {
        const r = await db
          .select({ at: sql<string>`MAX(received_at)::text` })
          .from(tenantPaymentWebhookEvents)
          .where(
            and(
              eq(tenantPaymentWebhookEvents.tenantId, tenantId),
              eq(tenantPaymentWebhookEvents.status, "processed"),
            ),
          );
        return r[0]?.at ?? null;
      } catch {
        return null;
      }
    })(),
  ]);

  return {
    providers: providers.map((p) => ({
      id: p.id,
      provider: p.provider,
      mode: p.mode,
      accountLabel: p.accountLabel ?? "",
      status: p.status,
      enabled: p.enabled,
      isDefault: p.isDefault,
      webhookStatus: p.webhookStatus,
      lastVerifiedAt: p.lastVerifiedAt?.toISOString() ?? null,
      lastPaymentEventAt: p.lastPaymentEventAt?.toISOString() ?? null,
      lastWebhookVerifiedAt: p.lastWebhookVerifiedAt?.toISOString() ?? null,
      lastWebhookErrorAt: p.lastWebhookErrorAt?.toISOString() ?? null,
    })),
    providersTotal,
    providersInvalid,
    providersWebhookFailing,
    providersStaleVerify7d,
    pendingPaymentBacklog,
    pendingActive,
    webhookFailures24h,
    orphans24h,
    lastWebhookEventAt,
  };
}
