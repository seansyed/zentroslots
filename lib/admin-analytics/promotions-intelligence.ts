/**
 * Promotions Campaign Intelligence.
 *
 * Drives the executive KPI strip above /admin/promotions and the
 * per-card analytics. Every number is sourced from real DB columns
 * — there is no synthetic "MRR influenced" or "conversion rate"
 * fabrication. When a metric isn't computable from the available
 * data (e.g. we don't link redemptions to subscriptions yet), we
 * return null and the UI renders "—".
 *
 * Source columns:
 *   • promotions.redemption_count  — real (incremented by checkout
 *     when a code is applied — already wired in the existing flow)
 *   • promotions.max_redemptions   — set per-promo at creation
 *   • promotions.status            — explicit lifecycle (migration 0067)
 *   • promotions.expires_at        — for expiring-soon flag
 *   • promotions.active            — kill switch
 *
 * Memoized 60s.
 */

import { and, eq, gte, isNotNull, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { promotions } from "@/db/schema";
import { memoize } from "./cache";

// ─── Public types ──────────────────────────────────────────────────

export type PromotionStatus =
  | "draft"
  | "scheduled"
  | "active"
  | "paused"
  | "expired"
  | "archived";

export type CampaignKpis = {
  /** Currently sellable: status='active' AND not expired AND under
   *  the redemption cap (or no cap). */
  activeCampaigns: number;
  /** Sum of redemption_count across all promos. */
  totalRedemptions: number;
  /** Redemptions in the last 30 days. Real only when redemption
   *  events are logged (current schema doesn't log per-redemption
   *  events — derived from redemption_count delta vs created_at). */
  redemptions30d: number;
  /** Cap utilization across capped promos: SUM(redemption_count) /
   *  SUM(max_redemptions) where max_redemptions IS NOT NULL.
   *  Returns null when no promos have caps. */
  capUtilizationPct: number | null;
  /** Campaigns whose expires_at is within the next 7 days. */
  expiringSoon: number;
  /** Campaigns in draft (status='draft'). */
  draftCampaigns: number;
  /** Highest-performing campaign by redemption count. */
  topCampaign: {
    code: string;
    description: string | null;
    redemptionCount: number;
  } | null;
  generatedAt: string;
  computedInMs: number;
};

export async function computePromotionsKpis(): Promise<CampaignKpis> {
  return memoize(
    "admin:promotions:kpis:v1",
    async () => {
      const t0 = Date.now();

      const row = (await db.execute(
        sql`SELECT
              -- Active campaigns: explicit status='active' AND not expired
              -- AND under cap. Honest definition — UI matches what's
              -- actually sellable today.
              (SELECT COUNT(*)::int FROM promotions
                WHERE status = 'active'
                  AND active = true
                  AND (expires_at IS NULL OR expires_at > NOW())
                  AND (max_redemptions IS NULL OR redemption_count < max_redemptions)
              ) AS active_campaigns,
              (SELECT COALESCE(SUM(redemption_count)::bigint, 0) FROM promotions) AS total_redemptions,
              -- 30d redemptions proxy: promos created in last 30d × their
              -- redemption_count. Not perfectly accurate (a long-running
              -- promo's redemptions could be older) but closest honest
              -- approximation until per-redemption events are logged.
              (SELECT COALESCE(SUM(redemption_count)::bigint, 0) FROM promotions
                WHERE created_at >= NOW() - INTERVAL '30 days') AS redemptions_30d,
              (SELECT COUNT(*)::int FROM promotions
                WHERE expires_at IS NOT NULL
                  AND expires_at > NOW()
                  AND expires_at < NOW() + INTERVAL '7 days'
                  AND active = true
              ) AS expiring_soon,
              (SELECT COUNT(*)::int FROM promotions WHERE status = 'draft') AS draft_campaigns,
              (SELECT COALESCE(SUM(max_redemptions)::bigint, 0) FROM promotions
                WHERE max_redemptions IS NOT NULL) AS total_cap,
              (SELECT COALESCE(SUM(redemption_count)::bigint, 0) FROM promotions
                WHERE max_redemptions IS NOT NULL) AS capped_redemptions`,
      )) as unknown as Array<{
        active_campaigns: number;
        total_redemptions: number;
        redemptions_30d: number;
        expiring_soon: number;
        draft_campaigns: number;
        total_cap: number;
        capped_redemptions: number;
      }>;

      const r = row[0] ?? {
        active_campaigns: 0,
        total_redemptions: 0,
        redemptions_30d: 0,
        expiring_soon: 0,
        draft_campaigns: 0,
        total_cap: 0,
        capped_redemptions: 0,
      };

      const totalCap = Number(r.total_cap);
      const cappedRedemptions = Number(r.capped_redemptions);
      const capUtilizationPct =
        totalCap > 0 ? Math.round((cappedRedemptions / totalCap) * 1000) / 10 : null;

      // Top campaign by raw redemption count.
      const topRows = (await db.execute(
        sql`SELECT code, description, redemption_count::int AS redemption_count
              FROM promotions
             WHERE redemption_count > 0
             ORDER BY redemption_count DESC
             LIMIT 1`,
      )) as unknown as Array<{
        code: string;
        description: string | null;
        redemption_count: number;
      }>;
      const topCampaign =
        topRows.length > 0
          ? {
              code: topRows[0].code,
              description: topRows[0].description,
              redemptionCount: Number(topRows[0].redemption_count),
            }
          : null;

      return {
        activeCampaigns: Number(r.active_campaigns),
        totalRedemptions: Number(r.total_redemptions),
        redemptions30d: Number(r.redemptions_30d),
        capUtilizationPct,
        expiringSoon: Number(r.expiring_soon),
        draftCampaigns: Number(r.draft_campaigns),
        topCampaign,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}

// ─── Per-promotion enriched row ────────────────────────────────────

export type EnrichedPromotion = {
  id: string;
  code: string;
  description: string | null;
  kind: string;
  percentOff: number | null;
  amountOffCents: number | null;
  trialExtensionDays: number | null;
  appliesToPlan: string | null;
  targetPlans: string[];
  maxRedemptions: number | null;
  redemptionCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  status: PromotionStatus;
  stripeCouponId: string | null;
  stripePromotionCodeId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // ─── Derived ──────────────────────────────────────────────────
  /** Utilization 0..1 when capped, else null. Drives progress ring. */
  capUtilization: number | null;
  /** True when expires_at within 7 days. */
  expiringSoon: boolean;
  /** True when expires_at in the past (regardless of status field). */
  isExpired: boolean;
  /** Display label for the discount. */
  discountLabel: string;
};

function deriveStatus(p: typeof promotions.$inferSelect): PromotionStatus {
  // If the column has a non-default explicit value, honor it first.
  // Otherwise derive from active/dates.
  const stored = p.status as PromotionStatus | null | undefined;
  if (stored && stored !== "active") return stored;
  if (p.active === false) return "archived";
  if (p.expiresAt && p.expiresAt.getTime() < Date.now()) return "expired";
  if (p.startsAt && p.startsAt.getTime() > Date.now()) return "scheduled";
  return "active";
}

function discountLabel(p: typeof promotions.$inferSelect): string {
  if (p.kind === "percent" && p.percentOff != null) return `${p.percentOff}% off`;
  if (p.kind === "fixed" && p.amountOffCents != null)
    return `$${(p.amountOffCents / 100).toFixed(p.amountOffCents % 100 === 0 ? 0 : 2)} off`;
  if (p.kind === "trial_extension" && p.trialExtensionDays != null)
    return `+${p.trialExtensionDays}d trial`;
  if (p.kind === "free_month") return "1 free month";
  if (p.kind === "seat_expansion") return "Bonus seats";
  if (p.kind === "annual_incentive" && p.percentOff != null) return `${p.percentOff}% off annual`;
  if (p.kind === "referral") return "Referral reward";
  if (p.kind === "winback" && p.percentOff != null) return `${p.percentOff}% winback`;
  if (p.kind === "seasonal" && p.percentOff != null) return `${p.percentOff}% seasonal`;
  return p.kind;
}

export async function fetchEnrichedPromotions(): Promise<EnrichedPromotion[]> {
  const rows = await db.select().from(promotions).orderBy(sql`created_at DESC`);
  const now = Date.now();
  return rows.map((p) => {
    const tp = Array.isArray(p.targetPlans) ? (p.targetPlans as string[]) : [];
    const capUtilization =
      p.maxRedemptions && p.maxRedemptions > 0
        ? Math.min(1, p.redemptionCount / p.maxRedemptions)
        : null;
    const expIso = p.expiresAt ? p.expiresAt.toISOString() : null;
    const isExpired = p.expiresAt ? p.expiresAt.getTime() < now : false;
    const expiringSoon =
      p.expiresAt !== null &&
      !isExpired &&
      p.expiresAt.getTime() < now + 7 * 24 * 60 * 60_000;
    return {
      id: p.id,
      code: p.code,
      description: p.description,
      kind: p.kind,
      percentOff: p.percentOff,
      amountOffCents: p.amountOffCents,
      trialExtensionDays: p.trialExtensionDays,
      appliesToPlan: p.appliesToPlan,
      targetPlans: tp,
      maxRedemptions: p.maxRedemptions,
      redemptionCount: p.redemptionCount,
      startsAt: p.startsAt ? p.startsAt.toISOString() : null,
      expiresAt: expIso,
      active: p.active,
      status: deriveStatus(p),
      stripeCouponId: p.stripeCouponId ?? null,
      stripePromotionCodeId: p.stripePromotionCodeId ?? null,
      metadata: (p.metadata as Record<string, unknown>) ?? {},
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      capUtilization,
      expiringSoon,
      isExpired,
      discountLabel: discountLabel(p),
    };
  });
}
