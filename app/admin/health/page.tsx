import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, bookings, tenants, users } from "@/db/schema";
import { Badge } from "@/components/ui/primitives";
import { AdminShell } from "../_shell";

export const metadata = { title: "System health — Super admin" };

export const dynamic = "force-dynamic";

export default async function AdminHealthPage() {
  const t0 = Date.now();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    [excludeConstraint],
    [emailFailures1d],
    [emailSent1d],
    [webhookEvents1d],
    [recentReminders1h],
    [activeBookings1h],
    [usersTotal],
    [tenantsTotal],
    [pgRow],
  ] = await Promise.all([
    db.execute(sql`SELECT 1 AS ok FROM pg_constraint WHERE conname = 'bookings_no_overlap' AND contype = 'x'`),
    db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, "email.failed"), gte(auditLogs.createdAt, oneDayAgo))),
    db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, "email.sent"),   gte(auditLogs.createdAt, oneDayAgo))),
    db.select({ n: count() }).from(auditLogs).where(and(sql`${auditLogs.action} LIKE 'webhook.%'`, gte(auditLogs.createdAt, oneDayAgo))),
    db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, "reminder.sent"), gte(auditLogs.createdAt, oneHourAgo))),
    db.select({ n: count() }).from(bookings).where(gte(bookings.createdAt, oneHourAgo)),
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(tenants),
    db.execute(sql<{ v: string }>`SELECT version() AS v`),
  ]);

  const dbLatencyMs = Date.now() - t0;
  const excludeOk = Array.isArray(excludeConstraint) ? (excludeConstraint as { ok?: number }[]).length > 0 : false;
  const pgVersion = (pgRow as unknown as { v: string }[])?.[0]?.v ?? "?";

  const checks: Check[] = [
    { name: "Database connectivity",  ok: dbLatencyMs < 1500, detail: `${dbLatencyMs} ms total query batch` },
    { name: "EXCLUDE constraint",     ok: excludeOk,          detail: "bookings_no_overlap present (GiST)" },
    { name: "Email pipeline (24h)",   ok: Number(emailSent1d?.n ?? 0) === 0 || Number(emailFailures1d?.n ?? 0) / Math.max(1, Number(emailSent1d?.n ?? 0)) < 0.1, detail: `${Number(emailSent1d?.n ?? 0)} sent, ${Number(emailFailures1d?.n ?? 0)} failed` },
    { name: "Reminders (last 1h)",    ok: true,               detail: `${Number(recentReminders1h?.n ?? 0)} audit entries` },
    { name: "Webhook deliveries (24h)", ok: true,             detail: `${Number(webhookEvents1d?.n ?? 0)} events` },
  ];

  const allOk = checks.every((c) => c.ok);

  return (
    <AdminShell
      title="System health"
      crumbs={[{ label: "Super-admin", href: "/admin" }, { label: "Health" }]}
    >
      <div className="mt-4 flex items-center gap-3">
        <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${allOk ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
          <span className={`h-2 w-2 rounded-full ${allOk ? "bg-green-500" : "bg-red-500"}`} />
          {allOk ? "All systems nominal" : "Degraded"}
        </div>
        <span className="text-xs text-ink-subtle">refresh page for new snapshot</span>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {checks.map((c) => (
          <div key={c.name} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{c.name}</div>
              <Badge tone={c.ok ? "green" : "red"}>{c.ok ? "ok" : "fail"}</Badge>
            </div>
            <div className="mt-1 text-xs text-ink-muted">{c.detail}</div>
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-base font-medium">Footprint</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-4">
        <Stat label="Tenants"            value={String(Number(tenantsTotal?.n ?? 0))} />
        <Stat label="Users"              value={String(Number(usersTotal?.n ?? 0))} />
        <Stat label="Bookings created (1h)" value={String(Number(activeBookings1h?.n ?? 0))} />
        <Stat label="Email failures (24h)" value={String(Number(emailFailures1d?.n ?? 0))} />
      </div>

      <h2 className="mt-10 text-base font-medium">Runtime</h2>
      <dl className="mt-3 grid grid-cols-2 gap-y-2 rounded-lg border bg-white p-4 text-sm shadow-sm md:grid-cols-4">
        <Row k="Node"        v={process.version} />
        <Row k="Platform"    v={process.platform} />
        <Row k="Env"         v={process.env.NODE_ENV ?? "?"} />
        <Row k="App version" v={process.env.npm_package_version ?? "0.1.0"} />
        <Row k="Postgres"    v={(pgVersion.match(/PostgreSQL\s+([\d.]+)/) ?? [, "?"])[1] ?? "?"} />
        <Row k="Process uptime" v={`${Math.floor(process.uptime() / 60)} min`} />
      </dl>
    </AdminShell>
  );
}

type Check = { name: string; ok: boolean; detail: string };

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
