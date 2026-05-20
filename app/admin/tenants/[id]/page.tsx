import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, bookings, plans, tenants, users } from "@/db/schema";
import { Badge } from "@/components/ui/primitives";
import { AdminShell } from "../../_shell";
import TenantActions from "./TenantActions";

export const metadata = { title: "Tenant — Super admin" };
export const dynamic = "force-dynamic";

const TABS = [
  { slug: "overview", label: "Overview" },
  { slug: "billing",  label: "Billing" },
  { slug: "usage",    label: "Usage" },
  { slug: "bookings", label: "Bookings" },
  { slug: "audit",    label: "Audit" },
  { slug: "emails",   label: "Emails" },
] as const;

type Tab = typeof TABS[number]["slug"];

export default async function AdminTenantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: Tab = (TABS.find((t) => t.slug === tabParam)?.slug as Tab) ?? "overview";

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!tenant) notFound();

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

      <div className="mt-6 border-b border-border">
        <nav className="-mb-px flex flex-wrap gap-1 text-sm">
          {TABS.map((t) => {
            const isActive = t.slug === tab;
            return (
              <Link
                key={t.slug}
                href={`/admin/tenants/${id}?tab=${t.slug}`}
                className={`border-b-2 px-3 py-2 ${
                  isActive
                    ? "border-brand-accent font-medium text-brand-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-6">
        {tab === "overview" && <OverviewTab tenant={tenant} />}
        {tab === "billing"  && <BillingTab tenant={tenant} />}
        {tab === "usage"    && <UsageTab tenant={tenant} />}
        {tab === "bookings" && <BookingsTab tenantId={tenant.id} />}
        {tab === "audit"    && <AuditTab tenantId={tenant.id} />}
        {tab === "emails"   && <EmailsTab tenantId={tenant.id} />}
      </div>

      <div className="mt-8">
        <Link href="/admin/tenants" className="text-sm text-brand-accent hover:underline">
          ← Back to tenants
        </Link>
      </div>
    </AdminShell>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────

async function OverviewTab({ tenant }: { tenant: typeof tenants.$inferSelect }) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [userCount, [bookingsTotal], [bookings7d], recentBookings, planRows] = await Promise.all([
    db.select({ count: count() }).from(users).where(eq(users.tenantId, tenant.id)).then((r) => Number(r[0]?.count ?? 0)),
    db.select({ n: count() }).from(bookings).where(eq(bookings.tenantId, tenant.id)),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), gte(bookings.createdAt, sevenDaysAgo))),
    db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        status: bookings.status,
        clientName: bookings.clientName,
      })
      .from(bookings)
      .where(eq(bookings.tenantId, tenant.id))
      .orderBy(desc(bookings.startAt))
      .limit(10),
    db.select({ slug: plans.slug, name: plans.name }).from(plans).where(eq(plans.active, true)).orderBy(asc(plans.sortOrder)),
  ]);

  const planOptions = planRows.length
    ? planRows
    : [{ slug: "free", name: "Free" }, { slug: "pro", name: "Pro" }, { slug: "enterprise", name: "Enterprise" }];

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Users" value={String(userCount)} />
        <Stat label="Bookings (total)" value={String(Number(bookingsTotal?.n ?? 0))} />
        <Stat label="Bookings (7d)" value={String(Number(bookings7d?.n ?? 0))} />
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">Workspace</h2>
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
            <Row k="Tenant ID" v={<code className="text-xs">{tenant.id}</code>} />
            <Row k="Plan" v={tenant.currentPlan} />
            <Row k="Billing email" v={tenant.billingEmail ?? "—"} />
            <Row k="Created" v={tenant.createdAt.toISOString().slice(0, 10)} />
            <Row k="Onboarding done" v={tenant.onboardingCompletedAt ? "yes" : "no"} />
            <Row k="Primary color" v={<span className="font-mono text-xs">{tenant.primaryColor}</span>} />
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
      <BookingsList rows={recentBookings} />
    </>
  );
}

// ─── Billing ───────────────────────────────────────────────────────────

async function BillingTab({ tenant }: { tenant: typeof tenants.$inferSelect }) {
  const billingActions = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorLabel: auditLogs.actorLabel,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenant.id), sql`${auditLogs.action} LIKE 'billing.%' OR ${auditLogs.action} LIKE 'subscription.%' OR ${auditLogs.action} LIKE 'stripe.%' OR ${auditLogs.action} LIKE 'admin.%'`))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  const trialDaysLeft = tenant.trialEnd
    ? Math.max(0, Math.ceil((tenant.trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Current plan" value={tenant.currentPlan} />
        <Stat label="Status" value={tenant.subscriptionStatus ?? "—"} />
        <Stat label="Trial days left" value={trialDaysLeft != null ? String(trialDaysLeft) : "—"} />
      </div>

      <section className="mt-6 rounded-lg border bg-white p-5 shadow-sm">
        <h2 className="text-base font-medium">Stripe linkage</h2>
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <Row k="Customer ID" v={tenant.stripeCustomerId ? <code className="text-xs">{tenant.stripeCustomerId}</code> : "—"} />
          <Row k="Subscription ID" v={tenant.stripeSubscriptionId ? <code className="text-xs">{tenant.stripeSubscriptionId}</code> : "—"} />
          <Row k="Trial ends" v={tenant.trialEnd ? tenant.trialEnd.toISOString().slice(0, 10) : "—"} />
          <Row k="Billing email" v={tenant.billingEmail ?? "—"} />
        </dl>
      </section>

      <h2 className="mt-10 text-base font-medium">Recent billing / admin activity</h2>
      <AuditTable rows={billingActions} />
    </>
  );
}

// ─── Usage ─────────────────────────────────────────────────────────────

async function UsageTab({ tenant }: { tenant: typeof tenants.$inferSelect }) {
  const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [byStatus, [last30], staffCount, managerCount, serviceCountRow] = await Promise.all([
    db
      .select({
        status: bookings.status,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(bookings)
      .where(eq(bookings.tenantId, tenant.id))
      .groupBy(bookings.status),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), gte(bookings.createdAt, oneMonthAgo))),
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenant.id), eq(users.role, "staff"))).then((r) => Number(r[0]?.n ?? 0)),
    db.select({ n: count() }).from(users).where(and(eq(users.tenantId, tenant.id), eq(users.role, "manager"))).then((r) => Number(r[0]?.n ?? 0)),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM services WHERE tenant_id = ${tenant.id}`),
  ]);

  const statusMap: Record<string, number> = {};
  for (const row of byStatus) statusMap[row.status] = Number(row.n);
  const totalBookings = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const serviceCount = Number((serviceCountRow as unknown as { n: number }[])?.[0]?.n ?? 0);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-5">
        <Stat label="Staff" value={String(staffCount)} />
        <Stat label="Managers" value={String(managerCount)} />
        <Stat label="Services" value={String(serviceCount)} />
        <Stat label="Bookings total" value={String(totalBookings)} />
        <Stat label="Bookings (30d)" value={String(Number(last30?.n ?? 0))} />
      </div>

      <h2 className="mt-8 text-base font-medium">Bookings by status</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Count</th>
              <th className="px-4 py-2">% of total</th>
            </tr>
          </thead>
          <tbody>
            {["pending", "confirmed", "cancelled", "completed", "no_show"].map((s) => {
              const n = statusMap[s] ?? 0;
              const pct = totalBookings ? Math.round((n / totalBookings) * 100) : 0;
              return (
                <tr key={s} className="border-t">
                  <td className="px-4 py-2 capitalize">{s.replace("_", " ")}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{n}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full bg-brand-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-ink-muted">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Bookings (full list) ─────────────────────────────────────────────

async function BookingsTab({ tenantId }: { tenantId: string }) {
  const rows = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
    })
    .from(bookings)
    .where(eq(bookings.tenantId, tenantId))
    .orderBy(desc(bookings.startAt))
    .limit(100);
  return <BookingsList rows={rows} showEmail />;
}

// ─── Audit (full tenant audit) ────────────────────────────────────────

async function AuditTab({ tenantId }: { tenantId: string }) {
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorLabel: auditLogs.actorLabel,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      ip: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, tenantId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return <AuditTable rows={rows} />;
}

// ─── Emails (audit-derived) ───────────────────────────────────────────

async function EmailsTab({ tenantId }: { tenantId: string }) {
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorLabel: auditLogs.actorLabel,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), sql`${auditLogs.action} LIKE 'email.%'`))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  const sent = rows.filter((r) => r.action === "email.sent").length;
  const failed = rows.filter((r) => r.action === "email.failed").length;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Stat label="Email events (recent 200)" value={String(rows.length)} />
        <Stat label="Sent / Failed" value={`${sent} / ${failed}`} />
      </div>
      <h2 className="mt-8 text-base font-medium">Recent email events</h2>
      <AuditTable rows={rows} />
    </>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────

function BookingsList({
  rows,
  showEmail = false,
}: {
  rows: Array<{ id: string; startAt: Date; endAt?: Date; status: string; clientName: string; clientEmail?: string }>;
  showEmail?: boolean;
}) {
  return (
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
          {rows.length === 0 && (
            <tr><td colSpan={3} className="p-6 text-center text-sm text-slate-500">No bookings.</td></tr>
          )}
          {rows.map((b) => (
            <tr key={b.id} className="border-t">
              <td className="px-4 py-2 font-mono text-xs">{b.startAt.toISOString()}</td>
              <td className="px-4 py-2">
                {b.clientName}
                {showEmail && b.clientEmail && (
                  <div className="text-xs text-ink-subtle">{b.clientEmail}</div>
                )}
              </td>
              <td className="px-4 py-2"><Badge tone={statusTone(b.status)}>{b.status}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTable({
  rows,
}: {
  rows: Array<{
    id: string;
    action: string;
    actorLabel: string | null;
    entityType?: string | null;
    entityId?: string | null;
    ip?: string | null;
    createdAt: Date;
    metadata: unknown;
  }>;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-2">When</th>
            <th className="px-4 py-2">Action</th>
            <th className="px-4 py-2">Actor</th>
            <th className="px-4 py-2">Entity</th>
            <th className="px-4 py-2">Meta</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5} className="p-6 text-center text-sm text-slate-500">No audit entries.</td></tr>
          )}
          {rows.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="px-4 py-2 font-mono text-xs">{a.createdAt.toISOString()}</td>
              <td className="px-4 py-2">{a.action}</td>
              <td className="px-4 py-2 text-xs">{a.actorLabel ?? "—"}</td>
              <td className="px-4 py-2 text-xs">{a.entityType ? `${a.entityType}${a.entityId ? `#${a.entityId.slice(0, 8)}` : ""}` : "—"}</td>
              <td className="px-4 py-2 font-mono text-[10px] text-slate-500">
                {a.metadata && Object.keys(a.metadata as object).length
                  ? JSON.stringify(a.metadata).slice(0, 80)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
