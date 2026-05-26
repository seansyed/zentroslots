"use client";

/**
 * SA-6 — Financial Operations Center.
 *
 * Five sections in one page:
 *   A. Revenue Operations  (10 tiles + 5 charts)
 *   B. Dunning Center      (tenant table + action buttons)
 *   C. Subscription Intel  (6 lists + recommendation card)
 *   D. Stripe Reconciliation (findings table + fix actions)
 *   E. Finance Feed        (recent finance-related audit events)
 *
 * All data arrives server-rendered (see app/admin/finance/page.tsx).
 * Actions invoke /api/admin/finance/actions with a required reason
 * via a single shared ConfirmActionDialog — every action is audited.
 */

import * as React from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  Loader2,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { FinanceBundle, FinanceTile } from "@/lib/admin-analytics/finance";
import type { DunningPage, DunningTenant } from "@/lib/admin-analytics/dunning";
import type { SubIntelBundle, SubIntelList } from "@/lib/admin-analytics/subscription-intelligence";
import type { ReconReport, ReconFinding } from "@/lib/admin-analytics/stripe-recon";
import type { ActivityEvent, ActivityPage } from "@/lib/admin-analytics/activity";

type Bundle = {
  revenue: FinanceBundle | null;
  dunning: DunningPage | null;
  subIntel: SubIntelBundle | null;
  recon: ReconReport | null;
  generatedAt?: string;
};

// ─── Formatters ────────────────────────────────────────────────────

const fmtCents = (c: number | null) =>
  c === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: c >= 100_000 ? 0 : 2,
      }).format(c / 100);

const fmtNum = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("en-US").format(n);

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ─── Confirmation dialog ───────────────────────────────────────────

type PendingAction = {
  title: string;
  detail: string;
  op: string;
  tenantId: string;
  extra?: Record<string, unknown>;
  destructive?: boolean;
};

function ConfirmActionDialog({
  pending,
  onClose,
  onSuccess,
}: {
  pending: PendingAction | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!pending) {
      setReason("");
      setErr(null);
      setBusy(false);
    }
  }, [pending]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  if (!pending) return null;

  async function submit() {
    if (!pending) return;
    if (reason.trim().length < 3) {
      setErr("Reason is required (≥3 chars).");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/finance/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: pending.op,
          tenantId: pending.tenantId,
          reason: reason.trim(),
          ...(pending.extra ?? {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data?.error ?? "Action failed");
        return;
      }
      onSuccess();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{pending.title}</h3>
            <p className="mt-1 text-[13px] text-slate-600">{pending.detail}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4">
          <label className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            Reason (required, audit-logged)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. customer reached out via support, comping for outage SLA"
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            autoFocus
            disabled={busy}
          />
        </div>
        {err ? (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
            {err}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || reason.trim().length < 3}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50 ${
              pending.destructive ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-900 hover:bg-slate-800"
            }`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Section A — Revenue Operations ────────────────────────────────

function TileGrid({ tiles }: { tiles: FinanceTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.key}
          className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)]"
          title={t.tooltip}
        >
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{t.label}</div>
          <div className="mt-1.5 text-[20px] font-semibold leading-none text-slate-900">
            {t.unit === "currency_cents"
              ? fmtCents(t.value)
              : t.unit === "percent"
              ? t.value === null
                ? "—"
                : `${t.value}%`
              : fmtNum(t.value)}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-500">{t.detail}</div>
        </div>
      ))}
    </div>
  );
}

function RevenueCharts({ data }: { data: FinanceBundle }) {
  const allZero = (arr: Array<{ value?: number; a?: number; b?: number }>) =>
    arr.every((p) => (p.value ?? 0) === 0 && (p.a ?? 0) === 0 && (p.b ?? 0) === 0);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard title="Collections" subtitle="Cash collected per month, last 12 months">
        {allZero(data.collectionsTrend) ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.collectionsTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v) => fmtCents(Number(v))} width={64} />
              <Tooltip formatter={(v) => fmtCents(Number(v))} contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="MRR trend" subtitle="Cumulative paid subscription MRR per month">
        {allZero(data.mrrTrend) ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.mrrTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v) => fmtCents(Number(v))} width={64} />
              <Tooltip formatter={(v) => fmtCents(Number(v))} contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Line type="monotone" dataKey="value" stroke="#359df3" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Churn events" subtitle="Cancellations + downgrades per month">
        {allZero(data.churnTrend) ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.churnTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Bar dataKey="value" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Upgrades vs Downgrades" subtitle="Plan-transition events per month">
        {allZero(data.upgradeDowngradeTrend) ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.upgradeDowngradeTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="a" name="Upgrades" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="b" name="Downgrades" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Failed payments" subtitle="Stripe charge.failed per month" wide>
        {allZero(data.failedPaymentsTrend) ? (
          <EmptyChart />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.failedPaymentsTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Line type="monotone" dataKey="value" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  wide,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${wide ? "lg:col-span-2" : ""}`}>
      <h3 className="text-sm font-medium text-slate-900">{title}</h3>
      <p className="mt-0.5 text-[12px] text-slate-500">{subtitle}</p>
      <div className="mt-3 h-[200px]">{children}</div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center rounded-md border border-dashed border-slate-200 text-center text-[12px] text-slate-500">
      No data in this window yet.
    </div>
  );
}

// ─── Section B — Dunning Center ────────────────────────────────────

const RISK_STYLES: Record<DunningTenant["riskTier"], string> = {
  recoverable: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  at_risk: "bg-amber-50 text-amber-700 ring-amber-200",
  high_risk: "bg-orange-50 text-orange-700 ring-orange-200",
  critical: "bg-rose-50 text-rose-700 ring-rose-200",
};

function DunningTable({
  data,
  onAction,
}: {
  data: DunningPage;
  onAction: (a: PendingAction) => void;
}) {
  if (data.tenants.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-12 text-center">
        <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-500" />
        <div className="mt-2 text-sm font-medium text-slate-900">No tenants in dunning</div>
        <div className="mt-1 text-[12px] text-slate-500">
          Nothing past due and no failed payments in last 30 days.
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-slate-50 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2 text-right">MRR</th>
              <th className="px-3 py-2 text-right">Failures (30d)</th>
              <th className="px-3 py-2">Last failure</th>
              <th className="px-3 py-2">Risk</th>
              <th className="px-3 py-2 text-right">Recovery</th>
              <th className="px-3 py-2 text-right">Suspends in</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.tenants.map((t) => (
              <tr key={t.tenantId} className="border-t border-slate-100 text-[13px] hover:bg-slate-50/60">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-900">
                    <a href={`/admin/tenants/${t.tenantId}`} className="hover:underline">
                      {t.name}
                    </a>
                  </div>
                  <div className="text-[11px] text-slate-500">/{t.slug}</div>
                </td>
                <td className="px-3 py-2.5">{t.plan ?? "—"}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtCents(t.mrrCents)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{t.failedPayments30d}</td>
                <td className="px-3 py-2.5 text-[12px] text-slate-600">{timeAgo(t.lastFailureAt)}</td>
                <td className="px-3 py-2.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${RISK_STYLES[t.riskTier]}`}>
                    {t.riskTier.replace("_", " ")}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{t.recoveryProbability}%</td>
                <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-slate-600">
                  {t.daysUntilSuspension === null ? "—" : t.daysUntilSuspension === 0 ? "now" : `${t.daysUntilSuspension}d`}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap justify-end gap-1">
                    <DunningBtn
                      label="Retry"
                      onClick={() =>
                        onAction({
                          title: "Retry payment",
                          detail: `Trigger a Stripe payment_intent retry for ${t.name}.`,
                          op: "retry_payment",
                          tenantId: t.tenantId,
                        })
                      }
                    />
                    <DunningBtn
                      label="Resend invoice"
                      onClick={() =>
                        onAction({
                          title: "Resend invoice",
                          detail: `Pull the most recent Stripe invoice for ${t.name} and resend.`,
                          op: "resend_invoice",
                          tenantId: t.tenantId,
                        })
                      }
                    />
                    <DunningBtn
                      label="Extend 7d"
                      onClick={() =>
                        onAction({
                          title: "Extend grace 7 days",
                          detail: `Push trial_end forward 7 days for ${t.name}.`,
                          op: "extend_grace",
                          tenantId: t.tenantId,
                          extra: { days: 7 },
                        })
                      }
                    />
                    <DunningBtn
                      label="Mark paid"
                      onClick={() => {
                        const amountRaw = window.prompt("Amount paid in cents (e.g. 4900 for $49):");
                        const amountCents = amountRaw ? parseInt(amountRaw, 10) : NaN;
                        if (!Number.isFinite(amountCents) || amountCents <= 0) return;
                        onAction({
                          title: "Mark manually paid",
                          detail: `Book-keeping marker for ${t.name} at $${(amountCents / 100).toFixed(2)}.`,
                          op: "mark_manually_paid",
                          tenantId: t.tenantId,
                          extra: { amountCents },
                        });
                      }}
                    />
                    {t.riskTier === "critical" ? (
                      <DunningBtn
                        label="Suspend"
                        destructive
                        onClick={() =>
                          onAction({
                            title: "Suspend tenant",
                            detail: `Set active=false for ${t.name}. Booking surface stops accepting writes.`,
                            op: "suspend",
                            tenantId: t.tenantId,
                            destructive: true,
                          })
                        }
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DunningBtn({
  label,
  onClick,
  destructive,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-[11px] font-medium ${
        destructive
          ? "border border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
          : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Section C — Subscription Intelligence ─────────────────────────

function SubIntelSection({ data }: { data: SubIntelBundle }) {
  const [openKey, setOpenKey] = React.useState<string | null>(data.lists[0]?.key ?? null);
  return (
    <div className="space-y-3">
      {data.lists.map((list) => (
        <div key={list.key} className="rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <button
            type="button"
            onClick={() => setOpenKey(openKey === list.key ? null : list.key)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50/40"
          >
            <div>
              <div className="text-sm font-medium text-slate-900">{list.label}</div>
              <div className="mt-0.5 text-[12px] text-slate-500">{list.recommendation}</div>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-slate-500">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                {list.tenants.length}
              </span>
              {openKey === list.key ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </div>
          </button>
          {openKey === list.key ? (
            list.tenants.length === 0 ? (
              <div className="border-t border-slate-100 px-4 py-6 text-center text-[12px] text-slate-500">
                No tenants in this category right now.
              </div>
            ) : (
              <ul className="border-t border-slate-100">
                {list.tenants.map((t) => (
                  <li
                    key={t.tenantId}
                    className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-[13px] last:border-b-0 hover:bg-slate-50/40"
                  >
                    <div className="min-w-0 flex-1">
                      <a href={`/admin/tenants/${t.tenantId}`} className="font-medium text-slate-900 hover:underline">
                        {t.name}
                      </a>
                      <span className="ml-2 text-[11px] text-slate-500">/{t.slug}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[12px] text-slate-600">
                      <span>{t.plan ?? "—"}</span>
                      <span className="tabular-nums">{fmtCents(t.mrrCents)}</span>
                      <span className="tabular-nums">{t.bookings30d} bookings</span>
                      {t.trialEnd ? (
                        <span title={t.trialEnd}>trial ends {timeAgo(t.trialEnd)}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ─── Section D — Stripe Reconciliation ─────────────────────────────

function ReconSection({ data, onAction }: { data: ReconReport; onAction: (a: PendingAction) => void }) {
  if (data.findings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center">
        <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-500" />
        <div className="mt-2 text-sm font-medium text-slate-900">All clear</div>
        <div className="mt-1 text-[12px] text-slate-500">
          No local-DB mismatches detected by the rule engine.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {data.findings.map((f, idx) => (
        <ReconRow key={`${f.kind}:${f.tenantId}:${idx}`} f={f} onAction={onAction} />
      ))}
    </div>
  );
}

function ReconRow({ f, onAction }: { f: ReconFinding; onAction: (a: PendingAction) => void }) {
  const sevCls =
    f.severity === "critical"
      ? "border-rose-200 bg-rose-50/30"
      : f.severity === "warning"
      ? "border-amber-200 bg-amber-50/30"
      : "border-slate-200 bg-white";

  function suggested() {
    switch (f.suggestedFix) {
      case "manual_stripe_sync":
        onAction({
          title: "Trigger manual Stripe sync",
          detail: `Queue a manual Stripe pull for ${f.tenantName}. Resolves '${f.kind}'.`,
          op: "retry_payment", // audit-only marker
          tenantId: f.tenantId,
        });
        break;
      case "set_free":
        onAction({
          title: "Comp tenant to free",
          detail: `Override ${f.tenantName} to plan=free, status=active. Resolves stale status.`,
          op: "comp",
          tenantId: f.tenantId,
          extra: { plan: "free" },
        });
        break;
      case "suspend":
        onAction({
          title: "Suspend tenant",
          detail: `Set active=false for ${f.tenantName}. Resolves '${f.kind}'.`,
          op: "suspend",
          tenantId: f.tenantId,
          destructive: true,
        });
        break;
      case "extend_trial":
        onAction({
          title: "Extend trial 14 days",
          detail: `Push trial_end forward 14 days for ${f.tenantName}.`,
          op: "extend_grace",
          tenantId: f.tenantId,
          extra: { days: 14 },
        });
        break;
      default:
        break;
    }
  }

  return (
    <div className={`rounded-xl border p-3 ${sevCls}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <AlertCircle
              className={`h-3.5 w-3.5 ${
                f.severity === "critical" ? "text-rose-700" : f.severity === "warning" ? "text-amber-700" : "text-slate-500"
              }`}
            />
            <span className="text-sm font-medium text-slate-900">{f.kind.replace(/_/g, " ")}</span>
            <span className="text-[11px] uppercase tracking-wider text-slate-500">{f.severity}</span>
          </div>
          <div className="mt-1 text-[13px] text-slate-700">{f.detail}</div>
          <div className="mt-1 text-[11px] text-slate-500">
            Tenant:{" "}
            <a href={`/admin/tenants/${f.tenantId}`} className="font-medium hover:underline">
              {f.tenantName}
            </a>{" "}
            · /{f.tenantSlug} · status={f.subscriptionStatus ?? "—"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {f.suggestedFix !== "investigate" ? (
            <button
              type="button"
              onClick={suggested}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <Wrench className="h-3 w-3" />
              Fix
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Section E — Finance feed ──────────────────────────────────────

function FinanceFeed() {
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          limit: "30",
          kinds: [
            "subscription_created",
            "subscription_upgraded",
            "subscription_downgraded",
            "subscription_cancelled",
            "payment_failed",
            "invoice_paid",
            "tenant_suspended",
            "tenant_reactivated",
          ].join(","),
        });
        const res = await fetch(`/api/admin/activity/feed?${params.toString()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const page = (await res.json()) as ActivityPage;
        if (!cancelled) setEvents(page.events);
      } catch {
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Activity className="h-3.5 w-3.5 text-slate-500" />
          Finance feed
        </div>
      </div>
      {loading ? (
        <div className="px-4 py-10 text-center text-[12px] text-slate-500">
          <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : events.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-slate-500">
          No finance-related events yet.
        </div>
      ) : (
        <ul>
          {events.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-[13px] last:border-b-0 hover:bg-slate-50/40"
            >
              <div className="min-w-0 flex-1 truncate">
                <span className="font-medium text-slate-900">{e.summary}</span>
                {e.tenantId ? (
                  <a
                    href={`/admin/tenants/${e.tenantId}`}
                    className="ml-2 text-[11px] text-slate-500 hover:underline"
                  >
                    tenant {e.tenantId.slice(0, 8)}
                  </a>
                ) : null}
              </div>
              <span className="text-[11px] text-slate-500">{timeAgo(e.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Top-level client ──────────────────────────────────────────────

export default function FinanceClient({ initial }: { initial: Bundle }) {
  const [bundle, setBundle] = React.useState<Bundle>(initial);
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());

  const refreshAll = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/finance", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as Bundle;
        setBundle(data);
        setLastRefreshAt(Date.now());
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Financial Operations Center</div>
            <div className="text-[11px] text-slate-500">
              Last refreshed {timeAgo(new Date(lastRefreshAt).toISOString())}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-medium text-slate-900">Revenue operations</h2>
          {bundle.revenue ? (
            <span className="text-[11px] text-slate-400">{bundle.revenue.computedInMs}ms · cached 2min</span>
          ) : null}
        </div>
        {bundle.revenue ? (
          <div className="space-y-4">
            <TileGrid tiles={bundle.revenue.tiles} />
            <RevenueCharts data={bundle.revenue} />
          </div>
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 text-[13px] text-amber-800">
            Revenue bundle failed to compute. Check pm2 logs.
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-medium text-slate-900">Dunning center</h2>
          {bundle.dunning ? (
            <span className="text-[11px] text-slate-400">
              {bundle.dunning.total} tenant{bundle.dunning.total === 1 ? "" : "s"} in dunning
            </span>
          ) : null}
        </div>
        {bundle.dunning ? <DunningTable data={bundle.dunning} onAction={setPending} /> : <EmptyChart />}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-medium text-slate-900">Subscription intelligence</h2>
        </div>
        {bundle.subIntel ? (
          <SubIntelSection data={bundle.subIntel} />
        ) : (
          <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 text-[13px] text-amber-800">
            Subscription intelligence failed to compute.
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-medium text-slate-900">Stripe reconciliation</h2>
          {bundle.recon ? (
            <span className="text-[11px] text-slate-400">
              {bundle.recon.findings.length} finding{bundle.recon.findings.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {bundle.recon ? <ReconSection data={bundle.recon} onAction={setPending} /> : null}
      </section>

      <section>
        <FinanceFeed />
      </section>

      <ConfirmActionDialog
        pending={pending}
        onClose={() => setPending(null)}
        onSuccess={() => {
          // Refetch after successful action
          void refreshAll();
        }}
      />
    </div>
  );
}
