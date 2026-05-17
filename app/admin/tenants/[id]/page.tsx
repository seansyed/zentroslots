import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users, bookings, plans } from "@/db/schema";
import { Badge } from "@/components/ui/primitives";
import { AdminShell } from "../../_shell";
import TenantActions from "./TenantActions";

export const metadata = { title: "Tenant — Super admin" };

export default async function AdminTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!tenant) notFound();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [staff, [bookingTotal], [bookings7d], recentBookings, planRows] = await Promise.all([
    db.select({ count: count() }).from(users).where(eq(users.tenantId, id)).then((r) => Number(r[0]?.count ?? 0)),
    db.select({ n: count() }).from(bookings).where(eq(bookings.tenantId, id)),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, id), gte(bookings.createdAt, sevenDaysAgo))),
    db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        status: bookings.status,
        clientName: bookings.clientName,
      })
      .from(bookings)
      .where(eq(bookings.tenantId, id))
      .orderBy(desc(bookings.startAt))
      .limit(10),
    db.select({ slug: plans.slug, name: plans.name }).from(plans).where(eq(plans.active, true)).orderBy(asc(plans.sortOrder)),
  ]);

  const planOptions = planRows.length
    ? planRows
    : [
        { slug: "free", name: "Free" },
        { slug: "pro", name: "Pro" },
        { slug: "enterprise", name: "Enterprise" },
      ];

  return (
    <AdminShell
      title={tenant.name}
      crumbs={[
        { label: "Super-admin", href: "/admin" },
        { label: "Tenants", href: "/admin/tenants" },
        { label: tenant.name },
      ]}
    >
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <code className="rounded bg-surface-subtle px-1.5 py-0.5">{tenant.slug}</code>
        <Badge tone={tenant.active ? "green" : "red"}>{tenant.active ? "active" : "suspended"}</Badge>
        <Badge tone="blue">{tenant.currentPlan}</Badge>
        {tenant.subscriptionStatus && <Badge tone="neutral">{tenant.subscriptionStatus}</Badge>}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Stat label="Users" value={String(staff)} />
        <Stat label="Bookings (total)" value={String(Number(bookingTotal?.n ?? 0))} />
        <Stat label="Bookings (7d)" value={String(Number(bookings7d?.n ?? 0))} />
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">Workspace</h2>
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
            <Row k="Tenant ID" v={<code className="text-xs">{tenant.id}</code>} />
            <Row k="Plan" v={tenant.currentPlan} />
            <Row k="Billing email" v={tenant.billingEmail ?? "—"} />
            <Row k="Stripe customer" v={tenant.stripeCustomerId ?? "—"} />
            <Row k="Stripe sub" v={tenant.stripeSubscriptionId ?? "—"} />
            <Row k="Trial ends" v={tenant.trialEnd ? tenant.trialEnd.toISOString().slice(0, 10) : "—"} />
            <Row k="Created" v={tenant.createdAt.toISOString().slice(0, 10)} />
            <Row k="Onboarding done" v={tenant.onboardingCompletedAt ? "yes" : "no"} />
          </dl>
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">Admin actions</h2>
          <p className="mt-1 text-xs text-ink-muted">All actions audited and immediate.</p>
          <TenantActions
            tenantId={tenant.id}
            active={tenant.active}
            currentPlan={tenant.currentPlan}
            planOptions={planOptions}
          />
        </section>
      </div>

      <h2 className="mt-10 text-base font-medium">Recent bookings</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Start</th>
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {recentBookings.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-sm text-slate-500">No bookings yet.</td></tr>
            )}
            {recentBookings.map((b) => (
              <tr key={b.id} className="border-t">
                <td className="px-4 py-2 font-mono text-xs">{b.startAt.toISOString()}</td>
                <td className="px-4 py-2">{b.clientName}</td>
                <td className="px-4 py-2"><Badge tone={statusTone(b.status)}>{b.status}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6">
        <Link href="/admin/tenants" className="text-sm text-brand-accent hover:underline">← Back to tenants</Link>
      </div>
    </AdminShell>
  );
}

function statusTone(s: string): "neutral" | "blue" | "green" | "amber" | "red" | "violet" {
  switch (s) {
    case "confirmed": return "green";
    case "pending":   return "amber";
    case "cancelled": return "red";
    case "completed": return "blue";
    case "no_show":   return "red";
    default:          return "neutral";
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase text-ink-subtle">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </>
  );
}
