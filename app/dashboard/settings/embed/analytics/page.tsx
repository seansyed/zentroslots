import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { embedEvents, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import { Card, EmptyState } from "@/components/ui/primitives";

export default async function EmbedAnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    [loads30],
    perService,
    dailyLoads,
  ] = await Promise.all([
    db.select({ n: count() })
      .from(embedEvents)
      .where(
        and(
          eq(embedEvents.tenantId, tenant.id),
          eq(embedEvents.kind, "embed.load"),
          gte(embedEvents.createdAt, thirtyDaysAgo)
        )
      ),
    db
      .select({
        serviceId: embedEvents.serviceId,
        serviceName: services.name,
        n: count(),
      })
      .from(embedEvents)
      .leftJoin(services, eq(services.id, embedEvents.serviceId))
      .where(
        and(
          eq(embedEvents.tenantId, tenant.id),
          eq(embedEvents.kind, "embed.load"),
          gte(embedEvents.createdAt, thirtyDaysAgo)
        )
      )
      .groupBy(embedEvents.serviceId, services.name)
      .orderBy(desc(count()))
      .limit(10),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${embedEvents.createdAt}), 'YYYY-MM-DD')`,
        n: count(),
      })
      .from(embedEvents)
      .where(
        and(
          eq(embedEvents.tenantId, tenant.id),
          eq(embedEvents.kind, "embed.load"),
          gte(embedEvents.createdAt, thirtyDaysAgo)
        )
      )
      .groupBy(sql`date_trunc('day', ${embedEvents.createdAt})`)
      .orderBy(sql`date_trunc('day', ${embedEvents.createdAt})`),
  ]);

  const totalLoads = Number(loads30?.n ?? 0);

  // Synthesize a full 30-day series so the chart isn't gapped.
  const map = new Map(dailyLoads.map((r) => [r.day, Number(r.n)]));
  const series: { label: string; n: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    series.push({ label: key, n: map.get(key) ?? 0 });
  }

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Embed analytics"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }, { label: "Embed", href: "/dashboard/settings/embed" }, { label: "Analytics" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Embed performance</h1>
      <p className="mt-1 text-sm text-ink-muted">How your embedded booking widgets are performing in the last 30 days.</p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Widget loads (30d)" value={totalLoads.toLocaleString()} />
        <Stat label="Services with traffic" value={String(perService.length)} />
        <Stat label="Avg loads/day" value={(totalLoads / 30).toFixed(1)} />
      </div>

      <h2 className="mt-10 text-lg font-medium">Daily loads</h2>
      <Card className="mt-3">
        {totalLoads === 0 ? (
          <div className="py-6 text-center text-xs text-ink-subtle">
            No widget loads yet. Drop the embed snippet on your website and check back here.
          </div>
        ) : (
          <BarChart days={series} />
        )}
      </Card>

      <h2 className="mt-10 text-lg font-medium">Top services</h2>
      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        {perService.length === 0 ? (
          <EmptyState title="No traffic yet" body="Embed your booking widget on a site to start collecting load + conversion data." />
        ) : (
          <ul className="divide-y divide-border">
            {perService.map((s, i) => (
              <li key={s.serviceId ?? `na-${i}`} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="text-ink">{s.serviceName ?? <span className="text-ink-subtle">(unknown service)</span>}</span>
                <span className="text-ink-muted">{Number(s.n)} loads</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
    </Card>
  );
}

function BarChart({ days }: { days: { label: string; n: number }[] }) {
  const W = 720, H = 160, PAD = 24;
  const max = Math.max(1, ...days.map((d) => d.n));
  const barWidth = (W - PAD * 2) / days.length - 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e2e8f0" />
      {days.map((d, i) => {
        const h = ((d.n / max) * (H - PAD * 2)) || 0;
        const x = PAD + i * ((W - PAD * 2) / days.length);
        const y = H - PAD - h;
        return (
          <rect key={d.label} x={x} y={y} width={Math.max(2, barWidth)} height={h} fill="#2563eb" rx="2">
            <title>{d.label}: {d.n}</title>
          </rect>
        );
      })}
      <text x={PAD} y={H - 4} fontSize="10" fill="#94a3b8">{days[0]?.label}</text>
      <text x={W - PAD} y={H - 4} fontSize="10" fill="#94a3b8" textAnchor="end">{days[days.length - 1]?.label}</text>
    </svg>
  );
}
