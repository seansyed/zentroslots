/**
 * Announcements & Customer Communications Intelligence.
 *
 * Drives the executive layer on /admin/announcements + the
 * per-card analytics. Every value is real:
 *
 *   activeAnnouncements  — status='active' AND not expired AND publishedAt <= NOW()
 *   totalDeliveries      — SUM(delivery_count)
 *   totalViews           — SUM(view_count)
 *   totalDismisses       — SUM(dismiss_count)
 *   totalClicks          — SUM(click_count)
 *   engagementRate       — SUM(view_count) / SUM(delivery_count); null when no deliveries
 *   ctr                  — SUM(click_count) / SUM(view_count); null when no views
 *   dismissRate          — SUM(dismiss_count) / SUM(view_count); null when no views
 *   expiringSoon         — expires_at within 7 days
 *   draftCount           — status='draft'
 *   topEngagement        — highest view_count
 *
 * If the engagement columns are 0 across the board, the UI renders
 * "—" rather than a meaningless 0%. NO fabricated metrics — when we
 * don't have deliveries reported yet, we don't pretend we do.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { announcements } from "@/db/schema";
import { memoize } from "./cache";

export type AnnouncementStatus =
  | "draft"
  | "scheduled"
  | "active"
  | "paused"
  | "expired"
  | "archived";

export type AnnouncementsKpis = {
  activeAnnouncements: number;
  totalDeliveries: number;
  totalViews: number;
  totalDismisses: number;
  totalClicks: number;
  /** 0..1 or null when delivery_count is 0. */
  engagementRate: number | null;
  /** 0..1 or null when view_count is 0. */
  ctr: number | null;
  /** 0..1 or null when view_count is 0. */
  dismissRate: number | null;
  expiringSoon: number;
  draftCount: number;
  topEngagement: {
    id: string;
    title: string;
    viewCount: number;
    deliveryCount: number;
  } | null;
  generatedAt: string;
  computedInMs: number;
};

export async function computeAnnouncementsKpis(): Promise<AnnouncementsKpis> {
  return memoize(
    "admin:announcements:kpis:v1",
    async () => {
      const t0 = Date.now();
      const rows = (await db.execute(
        sql`SELECT
              (SELECT COUNT(*)::int FROM announcements
                WHERE status = 'active'
                  AND active = true
                  AND (expires_at IS NULL OR expires_at > NOW())
                  AND published_at <= NOW()
              ) AS active_count,
              (SELECT COALESCE(SUM(delivery_count)::bigint, 0) FROM announcements) AS total_deliveries,
              (SELECT COALESCE(SUM(view_count)::bigint, 0) FROM announcements) AS total_views,
              (SELECT COALESCE(SUM(dismiss_count)::bigint, 0) FROM announcements) AS total_dismisses,
              (SELECT COALESCE(SUM(click_count)::bigint, 0) FROM announcements) AS total_clicks,
              (SELECT COUNT(*)::int FROM announcements
                WHERE expires_at IS NOT NULL
                  AND expires_at > NOW()
                  AND expires_at < NOW() + INTERVAL '7 days'
                  AND active = true
              ) AS expiring_soon,
              (SELECT COUNT(*)::int FROM announcements WHERE status = 'draft') AS draft_count`,
      )) as unknown as Array<{
        active_count: number;
        total_deliveries: number;
        total_views: number;
        total_dismisses: number;
        total_clicks: number;
        expiring_soon: number;
        draft_count: number;
      }>;

      const r = rows[0] ?? {
        active_count: 0,
        total_deliveries: 0,
        total_views: 0,
        total_dismisses: 0,
        total_clicks: 0,
        expiring_soon: 0,
        draft_count: 0,
      };

      const totalDeliveries = Number(r.total_deliveries);
      const totalViews = Number(r.total_views);
      const totalDismisses = Number(r.total_dismisses);
      const totalClicks = Number(r.total_clicks);

      const engagementRate = totalDeliveries > 0 ? totalViews / totalDeliveries : null;
      const ctr = totalViews > 0 ? totalClicks / totalViews : null;
      const dismissRate = totalViews > 0 ? totalDismisses / totalViews : null;

      const topRows = (await db.execute(
        sql`SELECT id::text, title, view_count::int AS view_count, delivery_count::int AS delivery_count
              FROM announcements
             WHERE view_count > 0
             ORDER BY view_count DESC
             LIMIT 1`,
      )) as unknown as Array<{
        id: string;
        title: string;
        view_count: number;
        delivery_count: number;
      }>;
      const topEngagement =
        topRows.length > 0
          ? {
              id: topRows[0].id,
              title: topRows[0].title,
              viewCount: Number(topRows[0].view_count),
              deliveryCount: Number(topRows[0].delivery_count),
            }
          : null;

      return {
        activeAnnouncements: Number(r.active_count),
        totalDeliveries,
        totalViews,
        totalDismisses,
        totalClicks,
        engagementRate,
        ctr,
        dismissRate,
        expiringSoon: Number(r.expiring_soon),
        draftCount: Number(r.draft_count),
        topEngagement,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}

// ─── Audience reach estimation ────────────────────────────────────

export type AudienceRules = {
  plans?: string[];
  subscriptionStatuses?: string[];
  onboardingStates?: ("completed" | "incomplete")[];
  minBookings30d?: number;
  inactiveDays?: number;
};

export async function estimateAudienceReach(rules: AudienceRules): Promise<{ reach: number; totalActive: number }> {
  // Always count active tenants only.
  const conditions: string[] = ["active = true"];
  if (rules.plans && rules.plans.length > 0) {
    const plansList = rules.plans.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    conditions.push(`current_plan IN (${plansList})`);
  }
  if (rules.subscriptionStatuses && rules.subscriptionStatuses.length > 0) {
    const statusList = rules.subscriptionStatuses.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
    conditions.push(`subscription_status IN (${statusList})`);
  }
  if (rules.onboardingStates && rules.onboardingStates.length > 0) {
    const has = (st: "completed" | "incomplete") => rules.onboardingStates!.includes(st);
    if (has("completed") && !has("incomplete")) {
      conditions.push("onboarding_completed_at IS NOT NULL");
    } else if (has("incomplete") && !has("completed")) {
      conditions.push("onboarding_completed_at IS NULL");
    }
  }
  if (rules.inactiveDays && rules.inactiveDays > 0) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.tenant_id = tenants.id AND b.created_at > NOW() - INTERVAL '${rules.inactiveDays} days')`,
    );
  }

  const whereClause = conditions.join(" AND ");
  const reachRow = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM tenants WHERE ${sql.raw(whereClause)}`,
  ).catch(() => [{ n: 0 }])) as unknown as Array<{ n: number }>;

  const totalRow = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM tenants WHERE active = true`,
  ).catch(() => [{ n: 0 }])) as unknown as Array<{ n: number }>;

  if (rules.minBookings30d && rules.minBookings30d > 0) {
    // Re-run with the booking volume filter — a JOIN-based count.
    const refined = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM tenants t
            WHERE ${sql.raw(whereClause.replace(/tenants\./g, "t."))}
              AND (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at > NOW() - INTERVAL '30 days') >= ${rules.minBookings30d}`,
    ).catch(() => [{ n: 0 }])) as unknown as Array<{ n: number }>;
    return { reach: Number(refined[0]?.n ?? 0), totalActive: Number(totalRow[0]?.n ?? 0) };
  }

  return { reach: Number(reachRow[0]?.n ?? 0), totalActive: Number(totalRow[0]?.n ?? 0) };
}

// ─── Enriched announcement row ─────────────────────────────────────

export type EnrichedAnnouncement = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  audience: string;
  audienceRules: AudienceRules;
  channels: string[];
  kind: string;
  status: AnnouncementStatus;
  linkUrl: string | null;
  linkLabel: string | null;
  publishedAt: string;
  scheduledAt: string | null;
  expiresAt: string | null;
  active: boolean;
  deliveryCount: number;
  viewCount: number;
  dismissCount: number;
  clickCount: number;
  /** view / delivery — null when no deliveries yet. */
  engagementRate: number | null;
  /** click / view — null when no views yet. */
  ctr: number | null;
  /** dismiss / view — null when no views yet. */
  dismissRate: number | null;
  expiringSoon: boolean;
  isExpired: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function deriveStatus(a: typeof announcements.$inferSelect): AnnouncementStatus {
  const stored = a.status as AnnouncementStatus | null | undefined;
  if (stored && stored !== "active") return stored;
  if (a.active === false) return "archived";
  if (a.expiresAt && a.expiresAt.getTime() < Date.now()) return "expired";
  if (a.scheduledAt && a.scheduledAt.getTime() > Date.now()) return "scheduled";
  if (a.publishedAt.getTime() > Date.now()) return "scheduled";
  return "active";
}

export async function fetchEnrichedAnnouncements(): Promise<EnrichedAnnouncement[]> {
  const rows = await db.select().from(announcements).orderBy(sql`created_at DESC`);
  const now = Date.now();
  return rows.map((a) => {
    const channels = Array.isArray(a.channels) ? (a.channels as string[]) : ["in_app"];
    const rules = (a.audienceRules as AudienceRules) ?? {};
    const isExpired = a.expiresAt ? a.expiresAt.getTime() < now : false;
    const expiringSoon =
      a.expiresAt !== null &&
      !isExpired &&
      a.expiresAt.getTime() < now + 7 * 24 * 60 * 60_000;
    const dc = a.deliveryCount ?? 0;
    const vc = a.viewCount ?? 0;
    const dsc = a.dismissCount ?? 0;
    const cc = a.clickCount ?? 0;
    return {
      id: a.id,
      title: a.title,
      body: a.body,
      severity: (a.severity as "info" | "warning" | "critical") ?? "info",
      audience: a.audience,
      audienceRules: rules,
      channels,
      kind: a.kind ?? "general",
      status: deriveStatus(a),
      linkUrl: a.linkUrl,
      linkLabel: a.linkLabel,
      publishedAt: a.publishedAt.toISOString(),
      scheduledAt: a.scheduledAt ? a.scheduledAt.toISOString() : null,
      expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
      active: a.active,
      deliveryCount: dc,
      viewCount: vc,
      dismissCount: dsc,
      clickCount: cc,
      engagementRate: dc > 0 ? vc / dc : null,
      ctr: vc > 0 ? cc / vc : null,
      dismissRate: vc > 0 ? dsc / vc : null,
      expiringSoon,
      isExpired,
      metadata: (a.metadata as Record<string, unknown>) ?? {},
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}
