import Link from "next/link";
import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { Badge } from "@/components/ui/primitives";
import { AdminShell } from "../_shell";

export const metadata = { title: "Subscriptions — Super admin" };

// Subscription "buckets" — small set of operationally useful filters.
const FILTERS = [
  { slug: "all",       label: "All paid",   match: () => isNotNull(tenants.subscriptionStatus) },
  { slug: "active",    label: "Active",     match: () => eq(tenants.subscriptionStatus, "active") },
  { slug: "trialing",  label: "Trialing",   match: () => eq(tenants.subscriptionStatus, "trialing") },
  { slug: "past_due",  label: "Past due",   match: () => eq(tenants.subscriptionStatus, "past_due") },
  { slug: "canceled",  label: "Canceled",   match: () => eq(tenants.subscriptionStatus, "canceled") },
  { slug: "free",      label: "Free / none", match: () => or(isNull(tenants.subscriptionStatus), eq(tenants.currentPlan, "free")) },
] as const;

export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const active = FILTERS.find((f) => f.slug === filter) ?? FILTERS[0];

  const [rows, [counts]] = await Promise.all([
    db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.currentPlan,
        status: tenants.subscriptionStatus,
        trialEnd: tenants.trialEnd,
        stripeCustomerId: tenants.stripeCustomerId,
        stripeSubscriptionId: tenants.stripeSubscriptionId,
        billingEmail: tenants.billingEmail,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(active.match()!)
      .orderBy(desc(tenants.createdAt))
      .limit(200),
    db
      .select({
        all:      sql<number>`COUNT(*) FILTER (WHERE ${tenants.subscriptionStatus} IS NOT NULL)::int`,
        active:   sql<number>`COUNT(*) FILTER (WHERE ${tenants.subscriptionStatus} = 'active')::int`,
        trialing: sql<number>`COUNT(*) FILTER (WHERE ${tenants.subscriptionStatus} = 'trialing')::int`,
        past_due: sql<number>`COUNT(*) FILTER (WHERE ${tenants.subscriptionStatus} = 'past_due')::int`,
        canceled: sql<number>`COUNT(*) FILTER (WHERE ${tenants.subscriptionStatus} = 'canceled')::int`,
        free:     sql<number>`COUNT(*) FILTER (WHERE ${tenants.subscriptionStatus} IS NULL OR ${tenants.currentPlan} = 'free')::int`,
      })
      .from(tenants),
  ]);

  return (
    <AdminShell
      title="Subscriptions"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Subscriptions" }]}
    >
      <div className="mt-4 flex flex-wrap gap-1.5 text-sm">
        {FILTERS.map((f) => {
          const n = (counts as Record<string, number>)?.[f.slug] ?? 0;
          const isActive = f.slug === active.slug;
          return (
            <Link
              key={f.slug}
              href={`/admin/subscriptions?filter=${f.slug}`}
              className={`rounded-md border px-3 py-1.5 ${isActive ? "border-brand-accent bg-brand-accent text-white" : "border-border bg-white text-ink-muted hover:bg-surface-subtle"}`}
            >
              {f.label} <span className={`ml-1 text-xs ${isActive ? "text-white/80" : "text-ink-subtle"}`}>{Number(n)}</span>
            </Link>
          );
        })}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Workspace</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Trial ends</th>
              <th className="px-4 py-2">Stripe</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-sm text-slate-500">No tenants in this bucket.</td></tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} className="border-t hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link href={`/admin/tenants/${t.id}`} className="font-medium text-brand-accent hover:underline">{t.name}</Link>
                  <div className="text-xs text-ink-muted"><code>{t.slug}</code></div>
                  {t.billingEmail && <div className="text-xs text-ink-subtle">{t.billingEmail}</div>}
                </td>
                <td className="px-4 py-2"><Badge tone="blue">{t.plan}</Badge></td>
                <td className="px-4 py-2">
                  {t.status ? (
                    <Badge tone={t.status === "trialing" ? "amber" : t.status === "past_due" ? "red" : t.status === "canceled" ? "neutral" : "green"}>
                      {t.status}
                    </Badge>
                  ) : <span className="text-xs text-ink-subtle">—</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{t.trialEnd ? t.trialEnd.toISOString().slice(0, 10) : "—"}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{t.stripeSubscriptionId ?? t.stripeCustomerId ?? "—"}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{t.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
