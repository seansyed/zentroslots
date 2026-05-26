/**
 * SA-4 — Tenant intelligence data layer.
 *
 * Server-side paginated query producing one row per tenant with 18
 * computed columns. Designed to scale to 10k+ tenants by:
 *   • Single grouped SQL query (no N+1)
 *   • OFFSET/LIMIT pagination at the DB layer
 *   • Lateral subqueries for per-tenant counts (indexed columns only)
 *   • In-process LRU cache (60s) per (page, sort, filter) key
 *
 * NO mock data. Every column is computed from real DB columns or
 * derived via the deterministic scoring engines in tenant-scoring.ts.
 */

import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { memoize } from "./cache";
import {
  computeHealthScore,
  computeRisk,
  type RiskLevel,
} from "./tenant-scoring";

// ─── Public row shape ──────────────────────────────────────────────

export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEnd: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  /** Subscription paid/active/past_due/trialing/canceled */
  paymentStatus: string | null;
  /** MRR in cents (0 for free plan) */
  mrrCents: number;
  userCount: number;
  bookings30d: number;
  bookingsPrior30d: number;
  /** % growth, or null when prior period is zero. */
  bookingGrowthPct: number | null;
  googleConnected: boolean;
  googleExpired: boolean;
  microsoftConnected: boolean;
  microsoftExpired: boolean;
  zoomConnected: boolean;
  customDomain: string | null;
  /** Reminder success rate (last 30d, %). Null = no sends in window. */
  reminderSuccessPct: number | null;
  failedPayments30d: number;
  onboardingCompleted: boolean;
  /** Computed scores. */
  healthScore: number;
  riskLevel: RiskLevel;
  churnProbabilityPct: number;
  riskFactors: string[];
  /** Support tickets — placeholder column kept null because there
   *  is no tickets table in this codebase. UI displays "—". Never
   *  fabricated. */
  supportTickets: number | null;
  // ─── Tenant Intelligence luxury upgrade (2026-05-26) ───
  /** Tenant primary color (hex) for avatar / chip tinting. */
  primaryColor: string | null;
  /** Optional uploaded logo URL. Falls back to initials in the UI. */
  logoUrl: string | null;
  /** Archetype id from onboarding_progress jsonb (cpa, law, medspa,
   *  salon, consultant, agency, clinic, coach) — populated by the
   *  dev-seeding simulator. NULL for real tenants. */
  archetype: string | null;
  /** Last 14 days of daily booking counts, oldest first. Drives the
   *  per-row sparkline. Length is always 14 even on quiet days. */
  bookingSparkline14d: number[];
};

export type TenantIntelPage = {
  rows: TenantRow[];
  total: number;
  page: number;
  pageSize: number;
  computedInMs: number;
};

export type TenantIntelQuery = {
  search?: string;
  plan?: string;
  status?: string;
  risk?: RiskLevel;
  sort?: "mrr" | "growth" | "health" | "risk" | "created" | "lastActive" | "name";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

// ─── Aggregator ────────────────────────────────────────────────────

export async function fetchTenantIntelligence(query: TenantIntelQuery): Promise<TenantIntelPage> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 5), 100);
  const offset = (page - 1) * pageSize;
  const sort = query.sort ?? "mrr";
  const order = query.order ?? "desc";

  // Cache key includes every filter so we don't return stale subsets.
  const cacheKey = `admin:tenants:intel:${JSON.stringify({
    search: query.search ?? "",
    plan: query.plan ?? "",
    status: query.status ?? "",
    risk: query.risk ?? "",
    sort,
    order,
    page,
    pageSize,
  })}`;

  return memoize(
    cacheKey,
    async () => {
      const t0 = Date.now();

      // Compose WHERE clause.
      const filters: ReturnType<typeof eq>[] = [];
      if (query.search) {
        // Match name OR slug OR billingEmail.
        const term = `%${query.search}%`;
        const orClause = or(
          ilike(tenants.name, term),
          ilike(tenants.slug, term),
          ilike(tenants.billingEmail, term),
        );
        if (orClause) filters.push(orClause as unknown as ReturnType<typeof eq>);
      }
      if (query.plan) filters.push(eq(tenants.currentPlan, query.plan));
      if (query.status) filters.push(eq(tenants.subscriptionStatus, query.status));

      // Total count (separate query so the row query keeps OFFSET cheap).
      const totalRows = filters.length
        ? await db.select({ n: sql<number>`COUNT(*)::int` }).from(tenants).where(and(...filters))
        : await db.select({ n: sql<number>`COUNT(*)::int` }).from(tenants);
      const total = Number(totalRows[0]?.n ?? 0);

      // Main rows query. Use a single raw SELECT with LATERAL subqueries
      // so we can sort + paginate at the DB layer.
      const orderSql =
        sort === "mrr"
          ? sql`COALESCE(p.price_monthly_cents, 0)`
          : sort === "growth"
          ? sql`(SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days')`
          : sort === "lastActive"
          ? sql`(SELECT MAX(b.created_at) FROM bookings b WHERE b.tenant_id = t.id)`
          : sort === "created"
          ? sql`t.created_at`
          : sort === "name"
          ? sql`t.name`
          : sql`t.created_at`;
      const orderDir = order === "asc" ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;

      // Build the search filter inline (Drizzle's sql tag handles parameterization).
      // Note: ilike % wildcards are interpolated as a parameter, not raw string.
      const search = query.search ? `%${query.search}%` : null;
      const planFilter = query.plan ?? null;
      const statusFilter = query.status ?? null;

      // SCHEMA-SAFE QUERY (tenant-intel hardening, 2026-05-26):
      //   • Previous version referenced t.primary_domain which DOES
      //     NOT EXIST on the tenants table — the column lives on the
      //     tenant_domains side-table. That made the whole query throw
      //     ("column primary_domain does not exist") and the page
      //     collapsed to "No tenants match your filters."
      //   • Custom-domain lookup now goes through a LATERAL subquery
      //     against tenant_domains scoped to status='verified', so
      //     tenants with no domain still appear (returns NULL).
      //   • Every per-tenant subquery is independent — tenants never
      //     disappear because they have no bookings, no comms, no
      //     billing, no calendar. LEFT JOIN semantics preserved.
      //   • Archetype tag (when present in onboarding_progress jsonb,
      //     set by the simulation seeder) surfaces to the UI.
      const rows = (await db.execute(
        sql`SELECT
              t.id::text                     AS id,
              t.name                         AS name,
              t.slug                         AS slug,
              t.current_plan                 AS plan,
              t.subscription_status          AS subscription_status,
              t.trial_end                    AS trial_end,
              t.created_at                   AS created_at,
              t.onboarding_completed_at      AS onboarding_completed_at,
              t.primary_color                AS primary_color,
              t.logo_url                     AS logo_url,
              t.onboarding_progress->>'archetype' AS archetype,
              (SELECT host FROM tenant_domains td
                 WHERE td.tenant_id = t.id AND td.status = 'verified'
                 ORDER BY td.activated_at DESC NULLS LAST, td.id ASC
                 LIMIT 1) AS custom_domain,
              COALESCE(p.price_monthly_cents, 0)::int AS price_monthly_cents,
              (SELECT COUNT(*)::int FROM users u  WHERE u.tenant_id = t.id) AS user_count,
              (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') AS bookings_30d,
              (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days') AS bookings_prior_30d,
              (SELECT MAX(b.created_at) FROM bookings b WHERE b.tenant_id = t.id) AS last_active_at,
              (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.google_refresh_token IS NOT NULL AND (u.google_status IS NULL OR u.google_status NOT IN ('expired','error'))) > 0 AS google_connected,
              (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.google_refresh_token IS NOT NULL AND u.google_status IN ('expired','error')) > 0 AS google_expired,
              (SELECT COUNT(*)::int FROM calendar_connections cc WHERE cc.tenant_id = t.id AND cc.provider = 'microsoft' AND (cc.status IS NULL OR cc.status NOT IN ('needs_reconnect','expired','error'))) > 0 AS microsoft_connected,
              (SELECT COUNT(*)::int FROM calendar_connections cc WHERE cc.tenant_id = t.id AND cc.provider = 'microsoft' AND cc.status IN ('needs_reconnect','expired','error')) > 0 AS microsoft_expired,
              (SELECT COUNT(*)::int FROM communication_logs c WHERE c.tenant_id = t.id AND c.status='sent'   AND c.created_at >= NOW() - INTERVAL '30 days') AS reminders_sent_30d,
              (SELECT COUNT(*)::int FROM communication_logs c WHERE c.tenant_id = t.id AND c.status='failed' AND c.created_at >= NOW() - INTERVAL '30 days') AS reminders_failed_30d,
              (SELECT COUNT(*)::int FROM billing_transactions bt WHERE bt.tenant_id = t.id AND bt.status='failed' AND bt.created_at >= NOW() - INTERVAL '30 days') AS failed_payments_30d,
              -- Daily booking sparkline (last 14 days) for the row.
              -- Returned as a Postgres int[] in chronological order
              -- (oldest first). LEFT-aligned date_series LEFT JOIN
              -- bookings makes zero-days appear as 0 instead of gaps.
              ARRAY(
                SELECT COALESCE(daily.n, 0)::int
                  FROM generate_series(0, 13) AS gs(d)
                  LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int AS n
                      FROM bookings b
                     WHERE b.tenant_id = t.id
                       AND b.created_at::date = (CURRENT_DATE - (13 - gs.d))
                  ) daily ON TRUE
                  ORDER BY gs.d
              ) AS booking_sparkline_14d
            FROM tenants t
            LEFT JOIN plans p ON p.slug = t.current_plan
           WHERE (${search}::text IS NULL OR t.name ILIKE ${search}::text OR t.slug ILIKE ${search}::text OR COALESCE(t.billing_email,'') ILIKE ${search}::text)
             AND (${planFilter}::text IS NULL OR t.current_plan = ${planFilter}::text)
             AND (${statusFilter}::text IS NULL OR t.subscription_status = ${statusFilter}::text)
           ORDER BY ${orderSql} ${orderDir}, t.created_at DESC
           LIMIT ${pageSize}
           OFFSET ${offset}`,
      )) as unknown as Array<{
        id: string;
        name: string;
        slug: string;
        plan: string | null;
        subscription_status: string | null;
        trial_end: string | null;
        created_at: string;
        onboarding_completed_at: string | null;
        primary_color: string | null;
        logo_url: string | null;
        archetype: string | null;
        custom_domain: string | null;
        price_monthly_cents: number;
        user_count: number;
        bookings_30d: number;
        bookings_prior_30d: number;
        last_active_at: string | null;
        google_connected: boolean;
        google_expired: boolean;
        microsoft_connected: boolean;
        microsoft_expired: boolean;
        reminders_sent_30d: number;
        reminders_failed_30d: number;
        failed_payments_30d: number;
        booking_sparkline_14d: number[] | null;
      }>;

      const computed: TenantRow[] = rows.map((r) => {
        const bookings30 = Number(r.bookings_30d);
        const bookingsPrior30 = Number(r.bookings_prior_30d);
        const growthPct =
          bookingsPrior30 > 0
            ? Math.round(((bookings30 - bookingsPrior30) / bookingsPrior30) * 1000) / 10
            : null;
        const remindersSent = Number(r.reminders_sent_30d);
        const remindersFailed = Number(r.reminders_failed_30d);
        const remindersTotal = remindersSent + remindersFailed;
        const reminderSuccessPct =
          remindersTotal > 0 ? Math.round((remindersSent / remindersTotal) * 1000) / 10 : null;

        const health = computeHealthScore({
          recent_activity: bookings30 > 0,
          booking_growth: growthPct ?? 0,
          active_users: Number(r.user_count),
          past_due: r.subscription_status === "past_due",
          google_connected: r.google_connected,
          microsoft_connected: r.microsoft_connected,
          reminder_success_pct: reminderSuccessPct,
          onboarding_completed: !!r.onboarding_completed_at,
          usage_frequency: bookings30 > 0,
        });

        const risk = computeRisk({
          bookings_30d: bookings30,
          bookings_prior_30d: bookingsPrior30,
          failed_payments_30d: Number(r.failed_payments_30d),
          subscription_status: r.subscription_status,
          google_expired: r.google_expired,
          microsoft_expired: r.microsoft_expired,
          active_users: Number(r.user_count),
        });

        // Sparkline: ensure always 14 entries, numeric, non-negative.
        const rawSpark = Array.isArray(r.booking_sparkline_14d) ? r.booking_sparkline_14d : [];
        const sparkline = Array.from({ length: 14 }, (_, i) => {
          const v = Number(rawSpark[i] ?? 0);
          return Number.isFinite(v) && v >= 0 ? v : 0;
        });

        return {
          id: r.id,
          name: r.name,
          slug: r.slug,
          plan: r.plan,
          subscriptionStatus: r.subscription_status,
          trialEnd: r.trial_end,
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at,
          paymentStatus: r.subscription_status,
          mrrCents: Number(r.price_monthly_cents),
          userCount: Number(r.user_count),
          bookings30d: bookings30,
          bookingsPrior30d: bookingsPrior30,
          bookingGrowthPct: growthPct,
          googleConnected: r.google_connected,
          googleExpired: r.google_expired,
          microsoftConnected: r.microsoft_connected,
          microsoftExpired: r.microsoft_expired,
          zoomConnected: false, // Zoom not wired yet — see SA-3 integrations
          customDomain: r.custom_domain,
          reminderSuccessPct,
          failedPayments30d: Number(r.failed_payments_30d),
          onboardingCompleted: !!r.onboarding_completed_at,
          healthScore: health,
          riskLevel: risk.level,
          churnProbabilityPct: risk.churnProbabilityPct,
          riskFactors: risk.factors,
          supportTickets: null,
          primaryColor: r.primary_color,
          logoUrl: r.logo_url,
          archetype: r.archetype,
          bookingSparkline14d: sparkline,
        };
      });

      // Risk filter (post-compute because it's derived).
      const filtered = query.risk ? computed.filter((r) => r.riskLevel === query.risk) : computed;

      // Sort by computed fields if requested (DB sort already happened
      // for mrr/growth/etc; health/risk need a post-sort).
      if (sort === "health") {
        filtered.sort((a, b) =>
          order === "asc" ? a.healthScore - b.healthScore : b.healthScore - a.healthScore,
        );
      } else if (sort === "risk") {
        const w: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
        filtered.sort((a, b) =>
          order === "asc" ? w[a.riskLevel] - w[b.riskLevel] : w[b.riskLevel] - w[a.riskLevel],
        );
      }

      return {
        rows: filtered,
        total,
        page,
        pageSize,
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}
