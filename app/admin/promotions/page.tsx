import { AdminShell } from "../_shell";
import PromotionsLuxuryClient from "@/components/admin/PromotionsLuxuryClient";
import {
  computePromotionsKpis,
  fetchEnrichedPromotions,
} from "@/lib/admin-analytics/promotions-intelligence";

export const metadata = { title: "Promotions & Campaigns — Super admin" };
export const dynamic = "force-dynamic";

/**
 * /admin/promotions — Growth Campaign Center.
 *
 * Two data fetches in parallel:
 *   • Enriched promotions (real rows + derived flags: capUtilization,
 *     expiringSoon, status, discountLabel)
 *   • Campaign KPIs (active count, total redemptions, expiring soon,
 *     top campaign, cap utilization across capped promos)
 *
 * All values are derived from real DB columns. No fabricated MRR,
 * no fake conversion percentages. When a metric isn't computable
 * from the available columns, the UI renders "—" rather than a
 * made-up number.
 */
export default async function AdminPromotionsPage() {
  const [enriched, kpis] = await Promise.all([
    fetchEnrichedPromotions().catch(() => []),
    computePromotionsKpis().catch(() => null),
  ]);

  return (
    <AdminShell
      title="Promotions & campaigns"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Promotions" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Promotions &amp; Campaigns</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Growth operations: discount codes, trial extensions, winback offers, and referral
        campaigns. Every campaign maps to a real promo code that the checkout flow recognizes.
      </p>

      <div className="mt-5">
        <PromotionsLuxuryClient initial={enriched} kpis={kpis} />
      </div>
    </AdminShell>
  );
}
