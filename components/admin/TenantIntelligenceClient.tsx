"use client";

/**
 * SA-4 — Tenant Intelligence client grid.
 *
 * Server fetches the first page; this component takes over for:
 *   • Search input (debounced)
 *   • Plan / status / risk filters
 *   • Multi-column sort
 *   • Pagination
 *   • CSV export (server-side stream — clicks /api/admin/tenants/intelligence?format=csv)
 *   • Row selection + bulk actions
 *   • Detail drawer on row click
 *   • Keyboard nav (Esc closes drawer; ←/→ paginate)
 *
 * NO mock data. All values come from /api/admin/tenants/intelligence.
 *
 * Sticky table header so column labels remain visible while scrolling
 * through long lists.
 */

import * as React from "react";
import { confirmAction } from "@/components/ui/primitives";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Search,
  TrendingUp,
  TrendingDown,
  X,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";

import type { TenantRow, TenantIntelPage } from "@/lib/admin-analytics/tenant-intelligence";
import type { RiskLevel } from "@/lib/admin-analytics/tenant-scoring";

const PAGE_SIZE = 25;

// ─── Helpers ────────────────────────────────────────────────────────

const fmtCents = (c: number) =>
  c === 0 ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c / 100);

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

const timeAgo = (iso: string | null) => {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
};

function HealthBar({ score }: { score: number }) {
  const cls =
    score >= 80
      ? "bg-emerald-500"
      : score >= 60
      ? "bg-sky-500"
      : score >= 40
      ? "bg-amber-500"
      : "bg-rose-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${cls}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-[12px] font-medium tabular-nums text-slate-700">{score}</span>
    </div>
  );
}

// ─── Luxury primitives (2026-05-26) ─────────────────────────────────

function tenantInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "•";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Soft tenant avatar — logo if present, else initials on tenant primary color. */
function TenantAvatar({
  name,
  logoUrl,
  primaryColor,
  size = "md",
}: {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  size?: "sm" | "md";
}) {
  const dim = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const txt = size === "sm" ? "text-[10px]" : "text-[12px]";
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        className={`${dim} shrink-0 rounded-lg object-contain ring-1 ring-slate-200 bg-white`}
      />
    );
  }
  const color = primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : "#2563EB";
  return (
    <div
      className={`${dim} shrink-0 inline-flex items-center justify-center rounded-lg font-semibold ${txt} text-white shadow-[inset_0_-2px_4px_rgba(0,0,0,0.12)]`}
      style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}
      aria-hidden
    >
      {tenantInitials(name)}
    </div>
  );
}

const ARCHETYPE_LABEL: Record<string, string> = {
  cpa: "CPA",
  law: "Law",
  medspa: "Med Spa",
  salon: "Salon",
  consultant: "Consulting",
  agency: "Agency",
  clinic: "Clinic",
  coach: "Coach",
};

/** Small label badge for archetype (only visible on simulated tenants today). */
function ArchetypeBadge({ archetype }: { archetype: string | null }) {
  if (!archetype) return null;
  const label = ARCHETYPE_LABEL[archetype] ?? archetype;
  return (
    <span
      className="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600"
      title={`Vertical: ${label}`}
    >
      {label}
    </span>
  );
}

/** 14-day daily-booking sparkline as inline SVG. Auto-scales to its
 *  max value; flat zeros render as a faint baseline. */
function BookingSparkline({ data }: { data: number[] }) {
  const w = 64;
  const h = 18;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data
    .map((v, i) => {
      const x = i * step;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const lastX = (data.length - 1) * step;
  const lastY = h - (data[data.length - 1] / max) * (h - 2) - 1;
  const total = data.reduce((a, b) => a + b, 0);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      aria-label={`14-day bookings: ${total}`}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className="text-sky-500"
        points={points}
      />
      <circle cx={lastX} cy={lastY} r={2} className="fill-sky-500" />
    </svg>
  );
}

/** Integration status pill — shows green ring on healthy, amber on
 *  needs-reconnect, neutral when not connected. */
function IntegrationPill({
  label,
  connected,
  expired,
}: {
  label: string;
  connected: boolean;
  expired: boolean;
}) {
  const cls = expired
    ? "bg-amber-50 text-amber-800 ring-amber-200"
    : connected
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : "bg-slate-50 text-slate-500 ring-slate-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${cls}`}
    >
      <span
        className={`inline-flex h-1.5 w-1.5 rounded-full ${
          expired ? "bg-amber-500" : connected ? "bg-emerald-500" : "bg-slate-300"
        }`}
      />
      {label}
    </span>
  );
}

/** Subtle row glow on hover — uses tenant primary color as tint. */
function rowHoverStyle(primaryColor: string | null): React.CSSProperties {
  // Use as a CSS custom property; the row CSS in className paints it.
  const c = primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : "#2563EB";
  return { ["--row-glow" as never]: `${c}10` } as React.CSSProperties;
}

const RISK_STYLES: Record<RiskLevel, string> = {
  low: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  medium: "bg-amber-50 text-amber-700 ring-amber-200",
  high: "bg-orange-50 text-orange-700 ring-orange-200",
  critical: "bg-rose-50 text-rose-700 ring-rose-200",
};

function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${RISK_STYLES[level]}`}>
      {level}
    </span>
  );
}

function GrowthChip({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-[12px] text-slate-400">—</span>;
  const positive = pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[12px] font-medium ${
        positive ? "text-emerald-700" : "text-rose-700"
      }`}
    >
      {positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {positive ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

function ConnectionDot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${on ? "bg-emerald-500" : "bg-slate-300"}`}
      aria-label={on ? "connected" : "not connected"}
    />
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────

function TenantDrawer({
  row,
  onClose,
  onActionFinished,
}: {
  row: TenantRow | null;
  onClose: () => void;
  onActionFinished: () => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!row) return null;

  async function runAction(op: string, extra: Record<string, unknown> = {}) {
    if (!row) return;
    if (
      !(await confirmAction({
        title: `${op.replace(/_/g, " ")} "${row.name}"?`,
        body: "This action is audit-logged. You can review it from the Activity Center.",
        variant: "warning",
        confirmLabel: "Continue",
      }))
    ) {
      return;
    }
    setBusy(op);
    setToast(null);
    try {
      const res = await fetch("/api/admin/tenants/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, tenantIds: [row.id], ...extra }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ kind: "err", text: data?.error ?? "Action failed" });
      } else {
        setToast({ kind: "ok", text: `${op.replace(/_/g, " ")} applied` });
        onActionFinished();
      }
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Action failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <TenantAvatar name={row.name} logoUrl={row.logoUrl} primaryColor={row.primaryColor} />
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
                  <span>{row.plan ?? "—"}</span>
                  <span>·</span>
                  <span>{row.subscriptionStatus ?? "—"}</span>
                  <ArchetypeBadge archetype={row.archetype} />
                </div>
                <h2 className="mt-0.5 text-lg font-semibold text-slate-900">{row.name}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-slate-500">
                  <span>/u/{row.slug}</span>
                  <span>created {fmtDate(row.createdAt)}</span>
                  {row.customDomain ? <span>· domain {row.customDomain}</span> : null}
                </div>
              </div>
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Cross-link strip (T6) — quick contextual jumps into other
              admin surfaces filtered to this tenant. Every link respects
              the existing search-param contract of the target page. */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <a
              href={`/admin/finance?tenantId=${row.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Finance →
            </a>
            <a
              href={`/admin/activity?tenantId=${row.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Activity →
            </a>
            <a
              href={`/admin/security/audit?tenantId=${row.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Audit →
            </a>
            <a
              href={`/admin/intelligence?tenantId=${row.id}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Insights →
            </a>
          </div>
        </header>

        <div className="space-y-5 px-6 py-5">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="MRR" value={fmtCents(row.mrrCents)} />
            <Stat label="Users" value={String(row.userCount)} />
            <Stat label="Bookings 30d" value={String(row.bookings30d)} sub={row.bookingGrowthPct !== null ? <GrowthChip pct={row.bookingGrowthPct} /> : null} />
            <Stat label="Last activity" value={timeAgo(row.lastActiveAt)} />
            <Stat label="Health" value={String(row.healthScore)} sub={<HealthBar score={row.healthScore} />} />
            <Stat label="Risk" value={<RiskBadge level={row.riskLevel} />} sub={`${row.churnProbabilityPct}% churn`} />
            <Stat label="Reminders" value={row.reminderSuccessPct === null ? "—" : `${row.reminderSuccessPct}%`} />
            <Stat label="Failed payments 30d" value={String(row.failedPayments30d)} />
          </div>

          {/* 14-day booking timeline — sourced from the row's sparkline data */}
          <Section title="14-day booking trend">
            <div className="rounded-lg border border-slate-200 bg-gradient-to-br from-white to-slate-50/40 p-4">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    Daily bookings (oldest → today)
                  </div>
                  <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-slate-900">
                    {row.bookingSparkline14d.reduce((a, b) => a + b, 0)}
                  </div>
                </div>
                <BookingSparkline data={row.bookingSparkline14d} />
              </div>
              <div className="mt-3 flex h-8 items-end gap-0.5">
                {row.bookingSparkline14d.map((v, i) => {
                  const max = Math.max(...row.bookingSparkline14d, 1);
                  const h = Math.max(2, (v / max) * 32);
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-sm bg-gradient-to-t from-sky-500/30 to-sky-500 transition-all"
                      style={{ height: `${h}px` }}
                      title={`Day ${i + 1}: ${v}`}
                    />
                  );
                })}
              </div>
            </div>
          </Section>

          {/* Integration health at a glance */}
          <Section title="Integration health">
            <div className="flex flex-wrap gap-2">
              <IntegrationPill label="Google Calendar" connected={row.googleConnected} expired={row.googleExpired} />
              <IntegrationPill label="Microsoft 365" connected={row.microsoftConnected} expired={row.microsoftExpired} />
            </div>
          </Section>

          {row.riskFactors.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-amber-700">
                <AlertTriangle className="h-3 w-3" />
                Risk factors triggered
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {row.riskFactors.map((f) => (
                  <span key={f} className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
                    {f.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
              <div className="flex items-center gap-1.5 text-[12px] text-emerald-700">
                <ShieldCheck className="h-3.5 w-3.5" />
                No active risk factors.
              </div>
            </div>
          )}

          {/* Integrations */}
          <Section title="Integrations">
            <ul className="text-[13px] text-slate-700">
              <li className="flex items-center justify-between border-b border-slate-100 py-2">
                <span>Google Calendar</span>
                <ConnectionDot on={row.googleConnected} />
              </li>
              <li className="flex items-center justify-between border-b border-slate-100 py-2">
                <span>Microsoft Calendar</span>
                <ConnectionDot on={row.microsoftConnected} />
              </li>
              <li className="flex items-center justify-between border-b border-slate-100 py-2">
                <span>Zoom</span>
                <ConnectionDot on={row.zoomConnected} />
              </li>
              <li className="flex items-center justify-between py-2">
                <span>Custom domain</span>
                <span className="text-[12px] text-slate-500">{row.customDomain ?? "—"}</span>
              </li>
            </ul>
          </Section>

          {/* Quick actions */}
          <Section title="Quick actions">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              <ActionButton
                label="Impersonate"
                desc="Sign in as this tenant's admin"
                onClick={() => {
                  // Reuse the existing impersonate route.
                  window.open(`/api/admin/tenants/${row.id}/impersonate`, "_self");
                }}
                disabled={busy !== null}
              />
              <ActionButton
                label="Suspend"
                desc="Set active=false (preserves data)"
                onClick={() => runAction("suspend")}
                disabled={busy === "suspend"}
                busy={busy === "suspend"}
                variant="danger"
              />
              <ActionButton
                label="Reactivate"
                desc="Set active=true"
                onClick={() => runAction("reactivate")}
                disabled={busy === "reactivate"}
                busy={busy === "reactivate"}
              />
              <ActionButton
                label="Extend trial 14d"
                desc="Push trialEnd forward 14 days"
                onClick={() => runAction("extend_trial", { days: 14 })}
                disabled={busy === "extend_trial"}
                busy={busy === "extend_trial"}
              />
              <ActionButton
                label="Comp Pro 30d"
                desc="Manually set plan=pro for 30 days"
                onClick={() => {
                  const reason = window.prompt("Reason for comp (required):");
                  if (!reason || reason.length < 3) return;
                  void runAction("comp_subscription", { plan: "pro", reason });
                }}
                disabled={busy === "comp_subscription"}
                busy={busy === "comp_subscription"}
              />
              <ActionButton
                label="Resend onboarding"
                desc="Audit-only marker (queued)"
                onClick={() => runAction("resend_onboarding")}
                disabled={busy === "resend_onboarding"}
                busy={busy === "resend_onboarding"}
              />
              <ActionButton
                label="Manual Stripe sync"
                desc="Audit-only marker (queued)"
                onClick={() => runAction("manual_sync_billing")}
                disabled={busy === "manual_sync_billing"}
                busy={busy === "manual_sync_billing"}
              />
            </div>

            {toast ? (
              <div
                className={`mt-3 rounded-md border px-3 py-2 text-[12px] ${
                  toast.kind === "ok"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-rose-200 bg-rose-50 text-rose-700"
                }`}
              >
                {toast.text}
              </div>
            ) : null}
          </Section>

          <Section title="Audit & history">
            <a
              href={`/admin/tenants/${row.id}?tab=audit`}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-sky-700 hover:underline"
            >
              Open full audit history →
            </a>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-[15px] font-semibold text-slate-900">{value}</div>
      {sub ? <div className="mt-1 text-[11px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">{title}</div>
      <div>{children}</div>
    </section>
  );
}

function ActionButton({
  label,
  desc,
  onClick,
  disabled,
  busy,
  variant,
}: {
  label: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-lg border p-3 transition-colors hover:bg-slate-50 disabled:opacity-50 ${
        variant === "danger"
          ? "border-rose-200 hover:bg-rose-50"
          : "border-slate-200"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-slate-900">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {label}
      </div>
      <div className="mt-0.5 text-[11px] text-slate-500">{desc}</div>
    </button>
  );
}

// ─── Grid ───────────────────────────────────────────────────────────

type SortKey = "mrr" | "growth" | "health" | "risk" | "created" | "lastActive" | "name";

export default function TenantIntelligenceClient({ initial }: { initial: TenantIntelPage | null }) {
  const [data, setData] = React.useState<TenantIntelPage | null>(initial);
  const [loading, setLoading] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [plan, setPlan] = React.useState<string>("");
  const [status, setStatus] = React.useState<string>("");
  const [risk, setRisk] = React.useState<string>("");
  const [sort, setSort] = React.useState<SortKey>("mrr");
  const [order, setOrder] = React.useState<"asc" | "desc">("desc");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [drawerRow, setDrawerRow] = React.useState<TenantRow | null>(null);

  // Debounce search.
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  // Reset page on filter change.
  React.useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [debouncedSearch, plan, status, risk, sort, order]);

  // Fetch.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort,
          order,
        });
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (plan) params.set("plan", plan);
        if (status) params.set("status", status);
        if (risk) params.set("risk", risk);
        const res = await fetch(`/api/admin/tenants/intelligence?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as TenantIntelPage;
        if (cancelled) return;
        setData(json);
      } catch {
        // Keep prior data
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, plan, status, risk, sort, order, page]);

  // Keyboard nav: ← / → paginate.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (drawerRow) return;
      if (e.key === "ArrowLeft" && page > 1) setPage((p) => p - 1);
      if (e.key === "ArrowRight" && data && page * PAGE_SIZE < data.total) setPage((p) => p + 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page, data, drawerRow]);

  function toggleSort(k: SortKey) {
    if (k === sort) setOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(k);
      setOrder("desc");
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulkAction(op: string) {
    if (selected.size === 0) return;
    if (
      !(await confirmAction({
        title: `${op.replace(/_/g, " ")} ${selected.size} tenant${selected.size === 1 ? "" : "s"}?`,
        body: "This action is audit-logged. You can review every change from the Activity Center.",
        variant: "warning",
        confirmLabel: "Continue",
      }))
    ) {
      return;
    }
    const body: Record<string, unknown> = { op, tenantIds: [...selected] };
    if (op === "extend_trial") body.days = 14;
    if (op === "comp_subscription") {
      const reason = window.prompt("Reason for comp (required):");
      if (!reason) return;
      body.plan = "pro";
      body.reason = reason;
    }
    const res = await fetch("/api/admin/tenants/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setSelected(new Set());
      // Refetch
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, order });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (plan) params.set("plan", plan);
      if (status) params.set("status", status);
      if (risk) params.set("risk", risk);
      const r = await fetch(`/api/admin/tenants/intelligence?${params.toString()}`, { cache: "no-store" });
      if (r.ok) setData((await r.json()) as TenantIntelPage);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const rows = data?.rows ?? [];
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function csvHref() {
    const params = new URLSearchParams({ format: "csv", sort, order });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (plan) params.set("plan", plan);
    if (status) params.set("status", status);
    if (risk) params.set("risk", risk);
    return `/api/admin/tenants/intelligence?${params.toString()}`;
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, slug, billing email…"
            className="w-72 rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-3 text-[13px] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
        </div>
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          <option value="">All plans</option>
          <option value="free">Free</option>
          <option value="solo">Solo</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
          <option value="enterprise">Enterprise</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="past_due">Past due</option>
          <option value="canceled">Canceled</option>
        </select>
        <select
          value={risk}
          onChange={(e) => setRisk(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          <option value="">All risk levels</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={csvHref()}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3 w-3" />
            CSV
          </a>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 ? (
        <div className="flex items-center justify-between rounded-lg border border-slate-900/10 bg-slate-900 px-4 py-2 text-white">
          <div className="text-[13px]">
            {selected.size} tenant{selected.size === 1 ? "" : "s"} selected
          </div>
          <div className="flex items-center gap-1.5">
            <BulkBtn label="Suspend" onClick={() => runBulkAction("suspend")} />
            <BulkBtn label="Reactivate" onClick={() => runBulkAction("reactivate")} />
            <BulkBtn label="Extend trial 14d" onClick={() => runBulkAction("extend_trial")} />
            <BulkBtn label="Resend onboarding" onClick={() => runBulkAction("resend_onboarding")} />
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2 py-1 text-[12px] text-slate-300 hover:text-white"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {/* Grid */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={() => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (allOnPageSelected) {
                          rows.forEach((r) => next.delete(r.id));
                        } else {
                          rows.forEach((r) => next.add(r.id));
                        }
                        return next;
                      });
                    }}
                  />
                </th>
                <Th label="Tenant" sortKey="name" current={sort} order={order} onClick={toggleSort} />
                <Th label="Plan" sortKey={null} />
                <Th label="MRR" sortKey="mrr" current={sort} order={order} onClick={toggleSort} align="right" />
                <Th label="Users" sortKey={null} align="right" />
                <Th label="Bookings 30d" sortKey="growth" current={sort} order={order} onClick={toggleSort} align="right" />
                <Th label="Growth" sortKey={null} align="right" />
                <Th label="Last active" sortKey="lastActive" current={sort} order={order} onClick={toggleSort} />
                <Th label="Payment" sortKey={null} />
                <Th label="G" sortKey={null} align="center" />
                <Th label="M" sortKey={null} align="center" />
                <Th label="Domain" sortKey={null} />
                <Th label="Health" sortKey="health" current={sort} order={order} onClick={toggleSort} />
                <Th label="Risk" sortKey="risk" current={sort} order={order} onClick={toggleSort} />
                <Th label="Churn %" sortKey={null} align="right" />
                <Th label="Trial end" sortKey={null} />
                <Th label="Created" sortKey="created" current={sort} order={order} onClick={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={17} className="px-3 py-12 text-center text-sm text-slate-500">
                    {loading ? (
                      <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>
                    ) : (
                      "No tenants match your filters."
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-t border-slate-100 text-[13px] hover:bg-slate-50/60"
                    onClick={(e) => {
                      // Don't open drawer when clicking the checkbox cell.
                      const target = e.target as HTMLElement;
                      if (target.tagName === "INPUT" || target.closest('input[type="checkbox"]')) return;
                      setDrawerRow(r);
                    }}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelect(r.id);
                        }}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <TenantAvatar
                          name={r.name}
                          logoUrl={r.logoUrl}
                          primaryColor={r.primaryColor}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-slate-900">{r.name}</span>
                            <ArchetypeBadge archetype={r.archetype} />
                          </div>
                          <div className="truncate text-[11px] text-slate-500">/u/{r.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                        {r.plan ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtCents(r.mrrCents)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.userCount}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <BookingSparkline data={r.bookingSparkline14d} />
                        <span className="tabular-nums text-[12px] font-medium">{r.bookings30d}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <GrowthChip pct={r.bookingGrowthPct} />
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-slate-600">{timeAgo(r.lastActiveAt)}</td>
                    <td className="px-3 py-2.5">
                      <PaymentBadge status={r.paymentStatus} />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="inline-flex items-center gap-1">
                        <IntegrationPill label="G" connected={r.googleConnected} expired={r.googleExpired} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="inline-flex items-center gap-1">
                        <IntegrationPill label="MS" connected={r.microsoftConnected} expired={r.microsoftExpired} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-slate-600">{r.customDomain ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <HealthBar score={r.healthScore} />
                    </td>
                    <td className="px-3 py-2.5">
                      <RiskBadge level={r.riskLevel} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-[12px] tabular-nums text-slate-600">
                      {r.churnProbabilityPct}%
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-slate-600">{fmtDate(r.trialEnd)}</td>
                    <td className="px-3 py-2.5 text-[12px] text-slate-600">{fmtDate(r.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data ? (
          <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-[12px] text-slate-600">
            <div>
              Showing{" "}
              <span className="font-medium text-slate-900">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)}
              </span>{" "}
              of <span className="font-medium text-slate-900">{data.total}</span>
              {loading ? <Loader2 className="ml-2 inline h-3 w-3 animate-spin" /> : null}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-2 tabular-nums">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages}
                className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 disabled:opacity-40 hover:bg-slate-50"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <TenantDrawer
        row={drawerRow}
        onClose={() => setDrawerRow(null)}
        onActionFinished={() => {
          // Refetch current page
          setPage((p) => p);
          setSelected(new Set());
        }}
      />
    </div>
  );
}

function Th({
  label,
  sortKey,
  current,
  order,
  onClick,
  align = "left",
}: {
  label: string;
  sortKey: SortKey | null;
  current?: SortKey;
  order?: "asc" | "desc";
  onClick?: (k: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const isActive = sortKey && sortKey === current;
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  if (!sortKey) return <th className={`px-3 py-2 ${alignCls}`}>{label}</th>;
  return (
    <th className={`px-3 py-2 ${alignCls}`}>
      <button
        type="button"
        onClick={() => onClick?.(sortKey)}
        className="inline-flex items-center gap-1 hover:text-slate-700"
      >
        {label}
        {isActive ? (order === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
      </button>
    </th>
  );
}

function PaymentBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-[11px] text-slate-400">—</span>;
  const tone =
    status === "active"
      ? "bg-emerald-50 text-emerald-700"
      : status === "trialing"
      ? "bg-sky-50 text-sky-700"
      : status === "past_due"
      ? "bg-amber-50 text-amber-700"
      : status === "canceled"
      ? "bg-rose-50 text-rose-700"
      : "bg-slate-100 text-slate-700";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}

function BulkBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md bg-slate-800 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-slate-700"
    >
      {label}
    </button>
  );
}
