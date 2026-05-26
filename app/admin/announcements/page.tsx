import { AdminShell } from "../_shell";
import AnnouncementsLuxuryClient from "@/components/admin/AnnouncementsLuxuryClient";
import {
  computeAnnouncementsKpis,
  fetchEnrichedAnnouncements,
} from "@/lib/admin-analytics/announcements-intelligence";

export const metadata = { title: "Announcements & Communications — Super admin" };
export const dynamic = "force-dynamic";

/**
 * /admin/announcements — Customer Communications Center.
 *
 * Two parallel fetches:
 *   • Enriched announcement rows (derived status, engagement rates,
 *     expiring-soon flags)
 *   • Executive KPIs (active count, deliveries, engagement, CTR,
 *     top performer)
 *
 * Every metric is a real DB column or deterministically derived from
 * one. Engagement %s render "—" when delivery_count or view_count is
 * zero — never a fabricated 0% that would imply failure.
 */
export default async function AdminAnnouncementsPage() {
  const [enriched, kpis] = await Promise.all([
    fetchEnrichedAnnouncements().catch(() => []),
    computeAnnouncementsKpis().catch(() => null),
  ]);

  return (
    <AdminShell
      title="Announcements & communications"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Announcements" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Announcements &amp; Communications</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Platform announcements, maintenance notices, release notes, engagement nudges, and
        lifecycle messaging. Targeting + delivery channels configurable per send.
      </p>

      <div className="mt-5">
        <AnnouncementsLuxuryClient initial={enriched} kpis={kpis} />
      </div>
    </AdminShell>
  );
}
