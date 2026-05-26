"use client";

/**
 * Operator Diagnostics — Premium real-time operations command center.
 *
 * Builds on the existing cron-heartbeat + stuck-queue + failure-stream
 * architecture with executive-grade UX:
 *
 *   • OpsMissionHero — 8 composite KPIs + platform-status pulse rail
 *   • Premium cron cards with severity rail, heartbeat pulse, retry
 *     counter, last-success emphasis
 *   • Premium failure stream with severity grouping + hover lift +
 *     click-to-investigate
 *   • Investigation drawer with execution timeline + stack trace +
 *     correlated context + deep-link quick actions
 *   • Storytelling chips per section (deterministic, mission-derived)
 *   • Live presence pulse on topbar
 *
 * Cron architecture preserved exactly. No new SQL queries. All scores
 * derived client-side from the existing OpsDiagnosticsBundle.
 */

import * as React from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Database,
  ExternalLink,
  Eye,
  HeartPulse,
  Lightbulb,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  Users,
  X,
  Zap,
} from "lucide-react";

import type {
  CronHeartbeat,
  CronStatus,
  OpsDiagnosticsBundle,
  RecentFailure,
  StuckQueueRow,
} from "@/lib/admin-analytics/opsDiagnostics";
import { deriveOpsMission, deriveOpsInsights } from "@/lib/admin-analytics/ops-mission";
import OpsMissionHero, { OpsInsightChip } from "@/components/admin/OpsMissionHero";

// ─── Tone tokens ──────────────────────────────────────────────────

const STATUS_TONE: Record<
  CronStatus,
  {
    ring: string;
    bg: string;
    dot: string;
    rail: string;
    label: string;
    chip: string;
  }
> = {
  ok: {
    ring: "border-emerald-200",
    bg: "from-white to-emerald-50/30",
    dot: "bg-emerald-500",
    rail: "before:bg-emerald-400/60",
    label: "OK",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  stale: {
    ring: "border-amber-200",
    bg: "from-white to-amber-50/40",
    dot: "bg-amber-500",
    rail: "before:bg-amber-400/70",
    label: "Stale",
    chip: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  down: {
    ring: "border-rose-200 shadow-[0_0_0_1px_rgba(244,63,94,0.06)]",
    bg: "from-white to-rose-50/40",
    dot: "bg-rose-500",
    rail: "before:bg-rose-500/80",
    label: "Down",
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
  },
  running: {
    ring: "border-sky-200",
    bg: "from-white to-sky-50/30",
    dot: "bg-sky-500",
    rail: "before:bg-sky-400/70",
    label: "Running",
    chip: "bg-sky-50 text-sky-700 ring-sky-200",
  },
  unknown: {
    ring: "border-slate-200",
    bg: "from-white to-slate-50/30",
    dot: "bg-slate-300",
    rail: "before:bg-slate-300/60",
    label: "Unknown",
    chip: "bg-slate-100 text-slate-600 ring-slate-200",
  },
};

function ageLabel(min: number | null): string {
  if (min === null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ─── Status dot with heartbeat pulse ──────────────────────────────

function StatusDot({ status }: { status: CronStatus }) {
  const tone = STATUS_TONE[status];
  const pulsing = status === "down" || status === "running";
  return (
    <span className="relative inline-flex h-2 w-2" aria-hidden>
      {pulsing ? (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${tone.dot}`} />
      ) : null}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${tone.dot}`} />
    </span>
  );
}

// ─── Cron card (premium) ──────────────────────────────────────────

function CronCard({
  heartbeat,
  onOpen,
}: {
  heartbeat: CronHeartbeat;
  onOpen: (h: CronHeartbeat) => void;
}) {
  const tone = STATUS_TONE[heartbeat.status];
  const isDown = heartbeat.status === "down";
  return (
    <button
      type="button"
      onClick={() => onOpen(heartbeat)}
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-3.5 pl-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_18px_rgba(15,23,42,0.06)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${tone.ring} ${tone.bg} ${tone.rail}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">
          <StatusDot status={heartbeat.status} />
          <span>{tone.label}</span>
        </div>
        <span className="text-[10px] text-slate-400">
          {heartbeat.expectedIntervalMin ? `every ${heartbeat.expectedIntervalMin}m` : ""}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[13px] font-semibold text-slate-900">
        {heartbeat.jobName}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          last {ageLabel(heartbeat.ageMinutes)} ago
        </span>
        <span className="inline-flex items-center gap-1.5">
          {heartbeat.lastDurationMs !== null ? (
            <span className="tabular-nums">{heartbeat.lastDurationMs}ms</span>
          ) : (
            "—"
          )}
          {heartbeat.failedRuns24h > 0 ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                heartbeat.failedRuns24h >= 3
                  ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                  : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
              }`}
            >
              ↺ {heartbeat.failedRuns24h}
            </span>
          ) : null}
        </span>
      </div>
      {isDown ? (
        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
          <AlertTriangle className="h-2.5 w-2.5" />
          Operator action required
        </div>
      ) : null}
      <ChevronRight className="absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ─── Cron grid ────────────────────────────────────────────────────

function CronGrid({
  rows,
  onOpen,
  storytellingChip,
}: {
  rows: CronHeartbeat[];
  onOpen: (h: CronHeartbeat) => void;
  storytellingChip?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-gradient-to-br from-slate-50/40 to-white px-4 py-10 text-center text-[12px] text-slate-500">
        No cron history yet — first run will populate this.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {storytellingChip ? (
        <div className="flex items-center gap-2">{storytellingChip}</div>
      ) : null}
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <CronCard key={r.jobName} heartbeat={r} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

// ─── Stuck queues ─────────────────────────────────────────────────

const QUEUE_KIND_VISUAL: Record<
  string,
  { Icon: React.ComponentType<{ className?: string }>; bg: string; iconColor: string; ring: string }
> = {
  pending_payment_backlog: {
    Icon: CreditCard,
    bg: "bg-violet-50",
    iconColor: "text-violet-600",
    ring: "ring-violet-200",
  },
  pending_automations_stuck: {
    Icon: Activity,
    bg: "bg-sky-50",
    iconColor: "text-sky-600",
    ring: "ring-sky-200",
  },
  webhook_signature_failures: {
    Icon: Shield,
    bg: "bg-rose-50",
    iconColor: "text-rose-600",
    ring: "ring-rose-200",
  },
  comms_failures: {
    Icon: AlertCircle,
    bg: "bg-orange-50",
    iconColor: "text-orange-600",
    ring: "ring-orange-200",
  },
};

function StuckQueues({
  rows,
  storytellingChip,
}: {
  rows: StuckQueueRow[];
  storytellingChip?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-emerald-200/70 bg-gradient-to-br from-emerald-50/30 via-white to-white px-6 py-10 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200/60">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        </div>
        <div className="mt-3 text-sm font-semibold text-slate-900">No stuck queues</div>
        <div className="mt-1 text-[12px] text-slate-500">
          All operational queues are draining normally.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {storytellingChip ? (
        <div className="flex items-center gap-2">{storytellingChip}</div>
      ) : null}
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        {rows.map((r) => {
          const visual =
            QUEUE_KIND_VISUAL[r.kind] ?? {
              Icon: Database,
              bg: "bg-amber-50",
              iconColor: "text-amber-600",
              ring: "ring-amber-200",
            };
          return (
            <div
              key={r.kind}
              className="relative overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-white to-amber-50/40 p-4 pl-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-amber-400/70"
            >
              <div className="flex items-start gap-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${visual.bg} ${visual.ring}`}>
                  <visual.Icon className={`h-4 w-4 ${visual.iconColor}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold tracking-tight text-slate-900">
                      {r.label}
                    </span>
                    <span className="text-[22px] font-semibold tabular-nums text-amber-700">
                      {r.count}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-slate-600">{r.detail}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Failure stream (premium) ─────────────────────────────────────

function classifyFailure(label: string): { tone: "critical" | "warning" | "info"; category: string } {
  const l = label.toLowerCase();
  if (l.includes("crash") || l.includes("fatal")) return { tone: "critical", category: "crash" };
  if (l.includes("webhook")) return { tone: "warning", category: "webhook" };
  if (l.includes("payment") || l.includes("stripe") || l.includes("billing"))
    return { tone: "warning", category: "billing" };
  if (l.includes("oauth") || l.includes("calendar")) return { tone: "warning", category: "integration" };
  if (l.includes("reminder") || l.includes("comm") || l.includes("ses"))
    return { tone: "warning", category: "delivery" };
  if (l.includes("cron") || l.includes("worker")) return { tone: "warning", category: "infra" };
  return { tone: "info", category: "other" };
}

function FailureStream({
  rows,
  onOpen,
  storytellingChip,
}: {
  rows: RecentFailure[];
  onOpen: (f: RecentFailure) => void;
  storytellingChip?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-emerald-200/70 bg-gradient-to-br from-emerald-50/30 via-white to-white px-6 py-12 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200/60">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
        </div>
        <div className="mt-3 text-sm font-semibold text-slate-900">No failures in the last 24h</div>
        <div className="mt-1 text-[12px] text-slate-500">
          Cron + audit failure streams clean. This is the optimal state.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {storytellingChip ? (
        <div className="flex items-center gap-2">{storytellingChip}</div>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-slate-50/80 to-white px-4 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
            {rows.length} failure{rows.length === 1 ? "" : "s"} in last 24h
          </div>
          <div className="text-[10px] text-slate-400">click any row to investigate</div>
        </div>
        <ul>
          {rows.map((r, i) => {
            const c = classifyFailure(r.label);
            const railCls =
              c.tone === "critical"
                ? "before:bg-rose-500/80"
                : c.tone === "warning"
                ? "before:bg-amber-400/70"
                : "before:bg-slate-300/60";
            return (
              <li
                key={`${r.ts}-${r.label}-${i}`}
                className={`relative border-b border-slate-100 px-4 py-3 pl-5 transition-colors last:border-b-0 hover:bg-slate-50/60 before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${railCls}`}
              >
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="flex w-full items-start gap-3 text-left"
                >
                  <span
                    className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${
                      r.source === "cron"
                        ? "bg-violet-50 text-violet-700 ring-violet-200"
                        : "bg-rose-50 text-rose-700 ring-rose-200"
                    }`}
                  >
                    {r.source}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-[12px] font-semibold text-slate-900">
                        {r.label}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          c.tone === "critical"
                            ? "bg-rose-100 text-rose-800"
                            : c.tone === "warning"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {c.category}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      <span title={r.ts}>{timeAgo(r.ts)}</span>
                      {r.tenantId ? (
                        <span className="ml-2 font-mono">· tenant {r.tenantId.slice(0, 8)}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 line-clamp-1 text-[11px] text-slate-600">{r.detail}</div>
                  </div>
                  <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-slate-300" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ─── Investigation drawer ─────────────────────────────────────────

type InvestigationTarget =
  | { kind: "cron"; cron: CronHeartbeat }
  | { kind: "failure"; failure: RecentFailure };

function InvestigationDrawer({
  target,
  onClose,
}: {
  target: InvestigationTarget | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!target) return null;

  const isCron = target.kind === "cron";
  const title = isCron ? target.cron.jobName : target.failure.label;
  const subtitle = isCron
    ? `Last ran ${ageLabel(target.cron.ageMinutes)} ago · ${target.cron.failedRuns24h} failure${
        target.cron.failedRuns24h === 1 ? "" : "s"
      } in 24h`
    : `${timeAgo(target.failure.ts)} · source: ${target.failure.source}`;

  const tone = isCron
    ? STATUS_TONE[target.cron.status]
    : classifyFailure(target.failure.label).tone === "critical"
    ? STATUS_TONE.down
    : classifyFailure(target.failure.label).tone === "warning"
    ? STATUS_TONE.stale
    : STATUS_TONE.unknown;
  const headerGradient = `from-slate-50/80 via-white to-white`;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl animate-[slideInDrawer_220ms_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className={`sticky top-0 z-10 border-b border-slate-200 bg-gradient-to-br ${headerGradient} px-6 py-5`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${tone.chip}`}
                >
                  <span className={`inline-flex h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                  {tone.label}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-700">
                  {isCron ? "cron job" : "failure event"}
                </span>
              </div>
              <h2 className="mt-2 break-all font-mono text-base font-semibold tracking-tight text-slate-900">
                {title}
              </h2>
              <div className="mt-1 text-[12px] text-slate-500">{subtitle}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="space-y-5 px-6 py-5">
          {isCron ? (
            <CronDrawerBody cron={target.cron} />
          ) : (
            <FailureDrawerBody failure={target.failure} />
          )}

          {/* Quick actions */}
          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Quick actions
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DrawerLink href="/admin/activity" label="Open activity feed" Icon={Activity} />
              <DrawerLink href="/admin/security" label="Open security ops" Icon={Shield} />
              <DrawerLink href="/admin/intelligence" label="Open intelligence" Icon={ShieldCheck} />
              {!isCron && target.failure.tenantId ? (
                <DrawerLink
                  href={`/admin/tenants/${target.failure.tenantId}`}
                  label="Open tenant impact"
                  Icon={Users}
                />
              ) : null}
            </div>
            <p className="mt-3 text-[11px] italic text-slate-500">
              Read-only intelligence — no autonomous remediation. All recovery actions remain manual,
              audited, and require operator confirmation.
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}

function CronDrawerBody({ cron }: { cron: CronHeartbeat }) {
  const recoveryGuidance =
    cron.status === "down"
      ? "Investigate worker logs · confirm crontab schedule · verify DB connectivity"
      : cron.status === "stale"
      ? "Job hasn't run within 3× its expected interval. Check worker uptime."
      : "Operational — no action required.";

  return (
    <>
      <section>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Execution context
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          <DrawerField label="Last status" value={cron.lastStatus ?? <span className="text-slate-400">—</span>} />
          <DrawerField label="Last started" value={timeAgo(cron.lastStartedAt)} />
          <DrawerField label="Last finished" value={timeAgo(cron.lastFinishedAt)} />
          <DrawerField
            label="Last duration"
            value={cron.lastDurationMs !== null ? `${cron.lastDurationMs}ms` : "—"}
          />
          <DrawerField
            label="Expected interval"
            value={cron.expectedIntervalMin !== null ? `every ${cron.expectedIntervalMin}m` : "—"}
          />
          <DrawerField
            label="Failures (24h)"
            value={
              <span
                className={`font-semibold ${
                  cron.failedRuns24h >= 3
                    ? "text-rose-700"
                    : cron.failedRuns24h > 0
                    ? "text-amber-700"
                    : "text-emerald-700"
                }`}
              >
                {cron.failedRuns24h}
              </span>
            }
          />
        </dl>
      </section>

      {cron.lastDetail && Object.keys(cron.lastDetail).length > 0 ? (
        <section>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Last execution detail
          </div>
          <pre className="overflow-auto rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-[11px] leading-relaxed text-slate-700">
            {JSON.stringify(cron.lastDetail, null, 2)}
          </pre>
        </section>
      ) : null}

      <section>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Recovery guidance
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/30 px-3 py-2 text-[12px] text-slate-700">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>{recoveryGuidance}</span>
        </div>
      </section>
    </>
  );
}

function FailureDrawerBody({ failure }: { failure: RecentFailure }) {
  const c = classifyFailure(failure.label);
  return (
    <>
      <section>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Event context
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          <DrawerField label="Source" value={failure.source} />
          <DrawerField label="Category" value={c.category} />
          <DrawerField label="Timestamp" value={new Date(failure.ts).toLocaleString()} />
          <DrawerField
            label="Tenant"
            value={
              failure.tenantId ? (
                <a
                  href={`/admin/tenants/${failure.tenantId}`}
                  className="font-mono text-sky-700 hover:underline"
                >
                  {failure.tenantId.slice(0, 8)}…
                </a>
              ) : (
                <span className="text-slate-400">—</span>
              )
            }
          />
        </dl>
      </section>

      {failure.detail ? (
        <section>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Failure detail
          </div>
          <pre className="overflow-auto rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-[11px] leading-relaxed text-slate-700">
            {failure.detail}
          </pre>
        </section>
      ) : null}

      <section>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Investigation guidance
        </div>
        <ul className="space-y-1.5 text-[12px] text-slate-700">
          {c.category === "crash" ? (
            <>
              <li>• Check process logs immediately for stack trace.</li>
              <li>• Cross-correlate with /admin/security for actor + IP context.</li>
              <li>• Confirm DB connection pool + memory headroom.</li>
            </>
          ) : c.category === "webhook" ? (
            <>
              <li>• Verify webhook secret hasn't rotated unexpectedly.</li>
              <li>• Inspect tenant_payment_webhook_events for invalid_signature pattern.</li>
            </>
          ) : c.category === "billing" ? (
            <>
              <li>• Review failed billing_transactions for clustering.</li>
              <li>• Check Stripe API status + tenant payment_connections.</li>
            </>
          ) : c.category === "delivery" ? (
            <>
              <li>• Check SES suppression list + sender identity.</li>
              <li>• Inspect communication_logs for cluster patterns.</li>
            </>
          ) : (
            <>
              <li>• Cross-reference activity feed for correlation.</li>
              <li>• Check tenant impact via security IP intelligence.</li>
            </>
          )}
        </ul>
      </section>
    </>
  );
}

function DrawerField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words font-medium text-slate-800">{value}</dd>
    </>
  );
}

function DrawerLink({
  href,
  label,
  Icon,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <a
      href={href}
      className="group inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)]"
    >
      <span className="inline-flex items-center gap-2">
        <Icon className="h-3 w-3 text-slate-400 group-hover:text-slate-600" />
        {label}
      </span>
      <ChevronRight className="h-3 w-3 text-slate-300 group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </a>
  );
}

// ─── Top-level client ─────────────────────────────────────────────

export default function OpsDiagnosticsClient({
  initial,
}: {
  initial: OpsDiagnosticsBundle | null;
}) {
  const [data, setData] = React.useState<OpsDiagnosticsBundle | null>(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());
  const [investigation, setInvestigation] = React.useState<InvestigationTarget | null>(null);
  const [heartbeatTick, setHeartbeatTick] = React.useState(0);

  const refresh = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/ops", { cache: "no-store" });
      if (res.ok) {
        const payload = (await res.json()) as OpsDiagnosticsBundle;
        setData(payload);
        setLastRefreshAt(Date.now());
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  React.useEffect(() => {
    const id = window.setInterval(() => setHeartbeatTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Derive mission KPIs + insights — DETERMINISTIC, client-side.
  const mission = data ? deriveOpsMission(data) : null;
  const insights = data && mission ? deriveOpsInsights(data, mission) : [];

  const cronInsight = insights.find((i) => i.surface === "cron") ?? null;
  const queueInsight = insights.find((i) => i.surface === "queue") ?? null;
  const failuresInsight = insights.find((i) => i.surface === "failures") ?? null;

  return (
    <div className="space-y-6">
      <style jsx global>{`
        @keyframes slideInDrawer {
          from {
            transform: translateX(20px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>

      {/* Sticky topbar with heartbeat */}
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-2xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="relative inline-flex h-2 w-2">
            <span
              key={heartbeatTick}
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75"
            />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <div>
            <div className="text-[13px] font-semibold tracking-tight text-slate-900">
              Operator Diagnostics
            </div>
            <div className="text-[11px] text-slate-500">
              Continuously monitored · cron + audit streams · refresh every 30s · last{" "}
              {timeAgo(new Date(lastRefreshAt).toISOString())}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </button>
      </div>

      {/* Mission hero */}
      {data && mission ? (
        <OpsMissionHero kpis={mission} insights={insights} liveOn={!refreshing} />
      ) : null}

      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Database className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Stuck queues
          </h2>
          <span className="text-[11px] text-slate-400">
            {data?.stuckQueues.length ?? 0} backed up
          </span>
        </div>
        <StuckQueues
          rows={data?.stuckQueues ?? []}
          storytellingChip={queueInsight ? <OpsInsightChip insight={queueInsight} /> : null}
        />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <HeartPulse className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Cron heartbeat
          </h2>
          <span className="text-[11px] text-slate-400">{data?.cronHeartbeats.length ?? 0} jobs</span>
          {data?.cronHeartbeats.some((h) => h.status === "running") ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-sky-700 ring-1 ring-sky-200">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-500" />
              </span>
              running now
            </span>
          ) : null}
        </div>
        <CronGrid
          rows={data?.cronHeartbeats ?? []}
          onOpen={(c) => setInvestigation({ kind: "cron", cron: c })}
          storytellingChip={cronInsight ? <OpsInsightChip insight={cronInsight} /> : null}
        />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Failure stream (24h)
          </h2>
          <span className="text-[11px] text-slate-400">{data?.recentFailures.length ?? 0}</span>
        </div>
        <FailureStream
          rows={data?.recentFailures ?? []}
          onOpen={(f) => setInvestigation({ kind: "failure", failure: f })}
          storytellingChip={failuresInsight ? <OpsInsightChip insight={failuresInsight} /> : null}
        />
      </section>

      <InvestigationDrawer target={investigation} onClose={() => setInvestigation(null)} />
    </div>
  );
}
