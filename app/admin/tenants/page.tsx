import Link from "next/link";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { Badge } from "@/components/ui/primitives";
import { AdminShell } from "../_shell";

export const metadata = { title: "Tenants — Super admin" };

const PLAN_TONES: Record<string, "green" | "blue" | "amber" | "neutral"> = {
  free: "neutral",
  pro: "blue",
  enterprise: "green",
};

export default async function AdminTenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; plan?: string; status?: string }>;
}) {
  const { q, plan, status } = await searchParams;

  const conds = [];
  if (q && q.trim()) {
    conds.push(
      or(
        ilike(tenants.name, `%${q.trim()}%`),
        ilike(tenants.slug, `%${q.trim()}%`),
        ilike(tenants.billingEmail, `%${q.trim()}%`)
      )!
    );
  }
  if (plan) conds.push(eq(tenants.currentPlan, plan));
  if (status === "active") conds.push(eq(tenants.active, true));
  if (status === "suspended") conds.push(eq(tenants.active, false));

  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      plan: tenants.currentPlan,
      active: tenants.active,
      subStatus: tenants.subscriptionStatus,
      trialEnd: tenants.trialEnd,
      billingEmail: tenants.billingEmail,
      createdAt: tenants.createdAt,
      userCount: sql<number>`(SELECT COUNT(*)::int FROM users WHERE users.tenant_id = ${tenants.id})`,
      bookingCount: sql<number>`(SELECT COUNT(*)::int FROM bookings WHERE bookings.tenant_id = ${tenants.id})`,
    })
    .from(tenants)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(tenants.createdAt))
    .limit(200);

  return (
    <AdminShell
      title="Tenants"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Tenants" }]}
    >
      <form className="mt-4 flex flex-wrap gap-2 text-sm" action="/admin/tenants" method="get">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, slug, email…"
          className="flex-1 min-w-[200px] rounded-md border border-border bg-white px-3 py-1.5"
        />
        <select name="plan" defaultValue={plan ?? ""} className="rounded-md border border-border bg-white px-3 py-1.5">
          <option value="">Any plan</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
        <select name="status" defaultValue={status ?? ""} className="rounded-md border border-border bg-white px-3 py-1.5">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
        <button type="submit" className="rounded-md bg-brand-accent px-3 py-1.5 text-white">Filter</button>
        <Link href="/admin/tenants" className="rounded-md border border-border bg-white px-3 py-1.5 text-ink-muted hover:bg-surface-subtle">
          Reset
        </Link>
      </form>

      <div className="mt-2 text-xs text-ink-subtle">
        {rows.length} tenant{rows.length === 1 ? "" : "s"} {q || plan || status ? "matching filters" : "total"}
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Workspace</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Users</th>
              <th className="px-4 py-2">Bookings</th>
              <th className="px-4 py-2">Trial ends</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-sm text-slate-500">No tenants match.</td></tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} className="border-t hover:bg-slate-50">
                <td className="px-4 py-2">
                  <Link href={`/admin/tenants/${t.id}`} className="font-medium text-brand-accent hover:underline">
                    {t.name}
                  </Link>
                  <div className="text-xs text-ink-muted"><code>{t.slug}</code></div>
                  {t.billingEmail && <div className="text-xs text-ink-subtle">{t.billingEmail}</div>}
                </td>
                <td className="px-4 py-2">
                  <Badge tone={PLAN_TONES[t.plan] ?? "neutral"}>{t.plan}</Badge>
                </td>
                <td className="px-4 py-2">
                  {!t.active ? (
                    <Badge tone="red">suspended</Badge>
                  ) : t.subStatus ? (
                    <Badge tone={t.subStatus === "trialing" ? "amber" : t.subStatus === "past_due" ? "red" : "green"}>
                      {t.subStatus}
                    </Badge>
                  ) : (
                    <span className="text-xs text-ink-subtle">—</span>
                  )}
                </td>
                <td className="px-4 py-2 tabular-nums">{Number(t.userCount)}</td>
                <td className="px-4 py-2 tabular-nums">{Number(t.bookingCount)}</td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {t.trialEnd ? t.trialEnd.toISOString().slice(0, 10) : "—"}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{t.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
