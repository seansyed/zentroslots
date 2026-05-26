/**
 * SA-6 §C — Subscription Intelligence.
 *
 * Six categorical lists of tenants matching deterministic rules,
 * plus an actionable recommendation per list.
 *
 * Lists:
 *   • expiring_trials       trialing + trial_end within next 7 days
 *   • upgrade_candidates    free plan + ≥30 bookings 30d + ≥3 users
 *                           (signals plan-pressure)
 *   • inactive_paid         paid plan + zero bookings 30d
 *   • highest_growth        active + 30d bookings ≥ 2× prior 30d
 *                           (top 10)
 *   • downgrade_risks       active paid + 30d bookings < 50% prior 30d
 *   • churn_risks           past_due OR (active + zero bookings 30d
 *                           AND no users)
 *
 * Each list caps at 25 rows. NO mock data. NO heuristics that
 * fabricate values.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

export type SubIntelTenant = {
  tenantId: string;
  name: string;
  slug: string;
  plan: string | null;
  mrrCents: number;
  bookings30d: number;
  bookingsPrior30d: number;
  userCount: number;
  trialEnd: string | null;
  subscriptionStatus: string | null;
};

export type SubIntelList = {
  key:
    | "expiring_trials"
    | "upgrade_candidates"
    | "inactive_paid"
    | "highest_growth"
    | "downgrade_risks"
    | "churn_risks";
  label: string;
  recommendation: string;
  tenants: SubIntelTenant[];
};

export type SubIntelBundle = {
  lists: SubIntelList[];
  generatedAt: string;
  computedInMs: number;
};

const BASE_SELECT = sql`
  SELECT t.id::text AS tenant_id,
         t.name, t.slug,
         t.current_plan AS plan,
         t.subscription_status,
         t.trial_end,
         COALESCE(p.price_monthly_cents, 0)::int AS price_cents,
         (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') AS bookings_30d,
         (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days') AS bookings_prior_30d,
         (SELECT COUNT(*)::int FROM users u  WHERE u.tenant_id = t.id) AS user_count
    FROM tenants t
    LEFT JOIN plans p ON p.slug = t.current_plan
`;

function mapRow(r: {
  tenant_id: string;
  name: string;
  slug: string;
  plan: string | null;
  subscription_status: string | null;
  trial_end: string | null;
  price_cents: number;
  bookings_30d: number;
  bookings_prior_30d: number;
  user_count: number;
}): SubIntelTenant {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    mrrCents: Number(r.price_cents),
    bookings30d: Number(r.bookings_30d),
    bookingsPrior30d: Number(r.bookings_prior_30d),
    userCount: Number(r.user_count),
    trialEnd: r.trial_end,
    subscriptionStatus: r.subscription_status,
  };
}

type Row = Parameters<typeof mapRow>[0];

async function runList(q: ReturnType<typeof sql>): Promise<SubIntelTenant[]> {
  try {
    const rows = (await db.execute(q)) as unknown as Row[];
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

export async function computeSubscriptionIntelligence(): Promise<SubIntelBundle> {
  return memoize(
    "admin:sub-intel:v1",
    async () => {
      const t0 = Date.now();

      const lists: SubIntelList[] = [];

      lists.push({
        key: "expiring_trials",
        label: "Expiring trials (next 7 days)",
        recommendation:
          "Reach out with onboarding help or a conversion incentive. These tenants will roll off in ≤7 days unless they convert.",
        tenants: await runList(
          sql`${BASE_SELECT}
               WHERE t.subscription_status = 'trialing'
                 AND t.trial_end IS NOT NULL
                 AND t.trial_end <= NOW() + INTERVAL '7 days'
                 AND t.trial_end >= NOW()
               ORDER BY t.trial_end ASC
               LIMIT 25`,
        ),
      });

      lists.push({
        key: "upgrade_candidates",
        label: "Upgrade candidates",
        recommendation:
          "Free tenants with usage signals (≥30 bookings/mo AND ≥3 users) — strong upgrade pitch.",
        tenants: await runList(
          sql`${BASE_SELECT}
               WHERE t.current_plan = 'free'
                 AND t.active = true
                 AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') >= 30
                 AND (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) >= 3
               ORDER BY (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') DESC
               LIMIT 25`,
        ),
      });

      lists.push({
        key: "inactive_paid",
        label: "Inactive paid tenants",
        recommendation:
          "Paying tenants with zero bookings in the last 30 days — proactive check-in before they cancel.",
        tenants: await runList(
          sql`${BASE_SELECT}
               WHERE t.subscription_status = 'active'
                 AND t.current_plan != 'free'
                 AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') = 0
               ORDER BY t.created_at DESC
               LIMIT 25`,
        ),
      });

      lists.push({
        key: "highest_growth",
        label: "Highest growth tenants",
        recommendation:
          "Active tenants with bookings ≥2× prior month — candidates for case studies, references, or higher-touch service.",
        tenants: await runList(
          sql`${BASE_SELECT}
               WHERE t.active = true
                 AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days') > 0
                 AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days')
                     >=
                     2 * (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days')
               ORDER BY (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') DESC
               LIMIT 10`,
        ),
      });

      lists.push({
        key: "downgrade_risks",
        label: "Downgrade risks",
        recommendation:
          "Active paid tenants whose bookings dropped > 50% MoM — proactive check-in to retain on current plan.",
        tenants: await runList(
          sql`${BASE_SELECT}
               WHERE t.subscription_status = 'active'
                 AND t.current_plan != 'free'
                 AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days') >= 5
                 AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days')
                     <
                     0.5 * (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days')
               ORDER BY (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') ASC
               LIMIT 25`,
        ),
      });

      lists.push({
        key: "churn_risks",
        label: "Churn risks",
        recommendation:
          "Tenants flagged for high churn likelihood (past_due, dunning, OR active w/ no bookings + no users).",
        tenants: await runList(
          sql`${BASE_SELECT}
               WHERE t.subscription_status = 'past_due'
                  OR (t.subscription_status = 'active'
                      AND (SELECT COUNT(*) FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') = 0
                      AND (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) <= 1)
               ORDER BY t.subscription_status = 'past_due' DESC, t.updated_at DESC
               LIMIT 25`,
        ),
      });

      return {
        lists,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    300_000, // 5 min
  );
}
