import { asc } from "drizzle-orm";

import { db } from "@/db/client";
import { plans } from "@/db/schema";
import {
  computePlanIntelligence,
  fetchStripeSyncDiagnostics,
  fetchUpgradeCandidates,
} from "@/lib/admin-analytics/plans-intelligence";
import { AdminShell } from "../_shell";
import PlansLuxuryClient from "@/components/admin/PlansLuxuryClient";

export const metadata = { title: "Plans & Monetization — Super admin" };
export const dynamic = "force-dynamic";

/**
 * /admin/plans — Plans & Monetization command center.
 *
 * Three data fetches in parallel:
 *   • plans table (the pricing source of truth)
 *   • per-plan intelligence (subs, MRR, churn, signup sparkline)
 *   • Stripe sync diagnostics (per-plan stripe_price_id_* presence)
 *   • upgrade candidates (free/pro tenants near limits)
 *
 * Every data source is real DB-backed. No mock pricing, no fake
 * subscriber counts.
 */
export default async function AdminPlansPage() {
  const [rows, intel, diagnostics, candidates] = await Promise.all([
    db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.priceMonthlyCents)),
    computePlanIntelligence().catch(() => null),
    fetchStripeSyncDiagnostics().catch(() => []),
    fetchUpgradeCandidates(10).catch(() => []),
  ]);

  // Serialize Date objects to strings — they don't survive the
  // server→client boundary as Date instances reliably.
  const serialized = rows.map((p) => ({
    ...p,
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));

  return (
    <AdminShell
      title="Plans & monetization"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Plans" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Plans &amp; Monetization</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Per-plan subscriber + MRR telemetry, Stripe sync state, upgrade-pressure detection, and
        feature matrix. Plan <code>slug</code> is the join key used by{" "}
        <code>tenants.current_plan</code> — slugs are immutable.
      </p>

      <div className="mt-5">
        <PlansLuxuryClient
          initialPlans={serialized}
          intel={intel}
          diagnostics={diagnostics}
          candidates={candidates}
        />
      </div>
    </AdminShell>
  );
}
