import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, bookings, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import { Badge } from "@/components/ui/primitives";

export const metadata = { title: "Internal admin" };

export default async function AdminPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    // 404 to avoid revealing the existence of the admin route.
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [
    allTenants,
    [usersTotal],
    [bookingsTotal],
    recentAudit,
    [emailFailures],
    [emailSent],
    expiredGoogleTenants,
    [recentBookings],
  ] = await Promise.all([
    db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.currentPlan,
        status: tenants.subscriptionStatus,
        stripeCustomerId: tenants.stripeCustomerId,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .orderBy(desc(tenants.createdAt))
      .limit(50),
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(bookings),
    db
      .select({
        id: auditLogs.id,
        tenantId: auditLogs.tenantId,
        action: auditLogs.action,
        actorLabel: auditLogs.actorLabel,
        entityType: auditLogs.entityType,
        ip: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(50),
    db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "email.failed"), gte(auditLogs.createdAt, sevenDaysAgo))),
    db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "email.sent"), gte(auditLogs.createdAt, sevenDaysAgo))),
    db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        users: sql<number>`(SELECT COUNT(*)::int FROM users WHERE users.tenant_id = ${tenants.id} AND users.google_status IN ('expired', 'error'))`,
      })
      .from(tenants)
      .where(
        sql`EXISTS (SELECT 1 FROM users WHERE users.tenant_id = ${tenants.id} AND users.google_status IN ('expired', 'error'))`
      )
      .limit(20),
    db.select({ n: count() }).from(bookings).where(gte(bookings.createdAt, sevenDaysAgo)),
  ]);

  return (
    <Shell
      user={me ? { name: me.name, email: me.email, role: me.role } : { name: session.email, email: session.email, role: "admin" }}
      variant="super"
      title="Operations"
      crumbs={[{ label: "Super-admin" }, { label: "Overview" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">Internal — superuser only</div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Operations</h1>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Tenants" value={String(allTenants.length)} />
        <Stat label="Users (total)" value={String(Number(usersTotal?.n ?? 0))} />
        <Stat label="Bookings (total)" value={String(Number(bookingsTotal?.n ?? 0))} />
      </div>

      {/* Ops health — 7-day rolling window */}
      <h2 className="mt-10 text-lg font-medium">7-day ops health</h2>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="Bookings (7d)"     value={String(Number(recentBookings?.n ?? 0))} />
        <Stat label="Emails sent (7d)"  value={String(Number(emailSent?.n ?? 0))} />
        <Stat label="Email failures (7d)" value={String(Number(emailFailures?.n ?? 0))} />
      </div>

      {/* Integration health — tenants whose Google connection broke */}
      <h2 className="mt-10 text-lg font-medium">Integration health</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        {expiredGoogleTenants.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-subtle">
            ✓ Every tenant&rsquo;s Google connection is healthy.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Expired connections</th>
                <th className="px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {expiredGoogleTenants.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="px-4 py-2 font-medium">{t.name}</td>
                  <td className="px-4 py-2"><code className="text-xs">{t.slug}</code></td>
                  <td className="px-4 py-2"><Badge tone="red">{Number(t.users)} user(s)</Badge></td>
                  <td className="px-4 py-2 text-xs text-ink-muted">Tenant admin needs to reconnect</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="mt-10 text-lg font-medium">Tenants</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Slug</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Sub status</th>
              <th className="px-4 py-2">Stripe</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {allTenants.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-4 py-2 font-medium">{t.name}</td>
                <td className="px-4 py-2"><code className="text-xs">{t.slug}</code></td>
                <td className="px-4 py-2 capitalize">{t.plan}</td>
                <td className="px-4 py-2">{t.status ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{t.stripeCustomerId ?? "—"}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{t.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-lg font-medium">Recent audit log</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Actor</th>
              <th className="px-4 py-2">Entity</th>
              <th className="px-4 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {recentAudit.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-sm text-slate-500">No audit entries yet.</td></tr>
            )}
            {recentAudit.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="px-4 py-2 font-mono text-xs">{a.createdAt.toISOString()}</td>
                <td className="px-4 py-2">{a.action}</td>
                <td className="px-4 py-2 text-xs">{a.actorLabel ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{a.entityType ?? "—"}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{a.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-ink-subtle">
        Authorization: <code>SUPER_ADMIN_EMAILS</code> env var (comma-separated).
      </p>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
