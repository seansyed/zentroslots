"use client";

/**
 * Super-admin revenue analytics — Recharts visualizations.
 *
 * Lazy-mounted client component. Receives a pre-computed RevenueSeries
 * from the server so first paint is data-ready; charts hydrate.
 *
 * Layout:
 *   • Row 1: MRR/Revenue line + ARR snapshot bar (full width split 2/3 + 1/3)
 *   • Row 2: Signups bar + Bookings line (half/half)
 *   • Row 3: Plan distribution donut + Revenue by plan bar (half/half)
 *   • Row 4: Churn vs Upgrades grouped bar (full)
 *   • Row 5: Top 10 tenants by MRR horizontal bar (full)
 *
 * Each chart is its own <ChartSection> with title + subtitle +
 * graceful empty state when data is empty. Errors render inline,
 * never block the rest of the page.
 *
 * Theme: light tokens only for now — the dashboard renders in light
 * mode. Dark-mode hooks are stub'd via the `theme` arg so a future
 * dark toggle can pass through.
 */

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { RevenueSeries } from "@/lib/admin-analytics/revenue";

// Brand-tuned palette. Order = render order in donuts/legends.
const PALETTE = ["#359df3", "#0ea5e9", "#06b6d4", "#10b981", "#a78bfa", "#f59e0b", "#ef4444", "#64748b"];

function fmtCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents >= 100_000 ? 0 : 2,
  }).format(cents / 100);
}

function fmtNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

// ─── Section wrapper ─────────────────────────────────────────────

function ChartSection({
  title,
  subtitle,
  isEmpty,
  emptyHint,
  error,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  isEmpty: boolean;
  emptyHint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className ?? ""}`}
    >
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-900">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[12px] text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {error ? (
        <div className="flex h-[200px] items-center justify-center rounded-md border border-dashed border-rose-200 bg-rose-50/40 px-4 text-center">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-rose-700">Failed to load</div>
            <div className="mt-1 max-w-md text-[12px] text-rose-600/80">{error}</div>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="flex h-[200px] items-center justify-center rounded-md border border-dashed border-slate-200 px-4 text-center">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-slate-500">No data yet</div>
            {emptyHint ? <div className="mt-1 max-w-md text-[12px] text-slate-500">{emptyHint}</div> : null}
          </div>
        </div>
      ) : (
        <div className="h-[240px]">{children}</div>
      )}
    </section>
  );
}

// ─── Public ──────────────────────────────────────────────────────

export default function RevenueCharts({ data }: { data: RevenueSeries }) {
  // Sanitize each section for emptiness — sums to zero across the
  // series means "no data" even when the array has 12 zero buckets.
  const isAllZero = (arr: Array<{ value?: number; a?: number; b?: number }>) =>
    arr.every((p) => (p.value ?? 0) === 0 && (p.a ?? 0) === 0 && (p.b ?? 0) === 0);

  return (
    <div className="space-y-4">
      {/* Row 1 — Monthly revenue (wide) + ARR snapshot tile */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartSection
            title="Monthly revenue"
            subtitle="Succeeded billing transactions minus refunds, last 12 months"
            isEmpty={isAllZero(data.monthlyRevenue)}
            emptyHint="No completed billing transactions in the last 12 months."
            error={data.errors.monthlyRevenue}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.monthlyRevenue} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickFormatter={(v) => fmtCurrency(Number(v))}
                  width={64}
                />
                <Tooltip
                  formatter={(v) => fmtCurrency(Number(v))}
                  contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
                />
                <Line type="monotone" dataKey="value" stroke={PALETTE[0]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>
        </div>
        <div>
          <ChartSection
            title="ARR snapshot"
            subtitle="MRR × 12 at this moment"
            isEmpty={data.arrSnapshotCents === 0}
            emptyHint="No active paid subscriptions yet."
            error={data.errors.arrSnapshot}
          >
            <div className="flex h-full flex-col items-center justify-center">
              <div className="text-[40px] font-semibold leading-none text-slate-900">
                {fmtCurrency(data.arrSnapshotCents)}
              </div>
              <div className="mt-2 text-[12px] text-slate-500">projected annual run rate</div>
            </div>
          </ChartSection>
        </div>
      </div>

      {/* Row 2 — Signups + Bookings */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSection
          title="New signups"
          subtitle="Tenants created per month, last 12 months"
          isEmpty={isAllZero(data.signupsByMonth)}
          emptyHint="No tenant signups recorded in the last 12 months."
          error={data.errors.signups}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.signupsByMonth} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Bar dataKey="value" fill={PALETTE[1]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartSection>
        <ChartSection
          title="Booking volume"
          subtitle="Platform-wide bookings per month, last 12 months"
          isEmpty={isAllZero(data.bookingsByMonth)}
          emptyHint="No bookings recorded yet."
          error={data.errors.bookings}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.bookingsByMonth} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
              <Tooltip
                formatter={(v) => fmtNumber(Number(v))}
                contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
              />
              <Line type="monotone" dataKey="value" stroke={PALETTE[2]} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartSection>
      </div>

      {/* Row 3 — Plan distribution donut + Revenue by plan bar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSection
          title="Plan distribution"
          subtitle="Active paid tenants by plan slug"
          isEmpty={data.planDistribution.length === 0 || data.planDistribution.every((s) => s.tenants === 0)}
          emptyHint="No active subscriptions to bucket yet."
          error={data.errors.planDistribution}
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.planDistribution}
                dataKey="tenants"
                nameKey="plan"
                cx="50%"
                cy="50%"
                innerRadius={48}
                outerRadius={84}
                paddingAngle={2}
              >
                {data.planDistribution.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v, _name, item) => {
                  const plan = (item as unknown as { payload?: { plan?: string } })?.payload?.plan ?? "";
                  return [`${fmtNumber(Number(v))} tenants`, plan];
                }}
                contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
              />
              <Legend
                verticalAlign="bottom"
                height={28}
                iconSize={8}
                wrapperStyle={{ fontSize: 11, color: "#475569" }}
              />
            </PieChart>
          </ResponsiveContainer>
        </ChartSection>
        <ChartSection
          title="Revenue by plan"
          subtitle="Aggregate MRR per plan tier"
          isEmpty={data.planDistribution.length === 0 || data.planDistribution.every((s) => s.mrrCents === 0)}
          emptyHint="No paying tenants on any plan yet."
          error={data.errors.planDistribution}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.planDistribution} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="plan" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis
                tick={{ fontSize: 11, fill: "#64748b" }}
                tickFormatter={(v) => fmtCurrency(Number(v))}
                width={64}
              />
              <Tooltip
                formatter={(v) => fmtCurrency(Number(v))}
                contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
              />
              <Bar dataKey="mrrCents" fill={PALETTE[3]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartSection>
      </div>

      {/* Row 4 — Churn vs Upgrades */}
      <ChartSection
        title="Churn vs upgrades"
        subtitle="Monthly count of cancellation/downgrade vs upgrade events from audit_logs"
        isEmpty={isAllZero(data.churnVsUpgrades)}
        emptyHint="No subscription-state-change audit events in the last 12 months."
        error={data.errors.churnVsUpgrades}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.churnVsUpgrades} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
            <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
            <Legend iconSize={8} wrapperStyle={{ fontSize: 11, color: "#475569" }} />
            <Bar dataKey="a" name="Churn" fill={PALETTE[6]} radius={[4, 4, 0, 0]} />
            <Bar dataKey="b" name="Upgrades" fill={PALETTE[3]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      {/* Row 5 — Top tenants */}
      <ChartSection
        title="Top 10 tenants by MRR"
        subtitle="Highest-revenue active paid tenants right now"
        isEmpty={data.topTenantsByMrr.length === 0}
        emptyHint="No active paid tenants yet."
        error={data.errors.topTenants}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data.topTenantsByMrr}
            layout="vertical"
            margin={{ top: 0, right: 24, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(v) => fmtCurrency(Number(v))}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: "#475569" }}
              width={160}
            />
            <Tooltip
              formatter={(v) => fmtCurrency(Number(v))}
              contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
            />
            <Bar dataKey="mrrCents" fill={PALETTE[0]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>
    </div>
  );
}
