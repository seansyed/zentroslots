"use client";

/**
 * Activity Center — premium operational mission-control surface.
 *
 * Builds on the original SA-5 live stream with:
 *   • ActivityMissionHero — 8 executive KPIs + stream-health pulse rail
 *   • Saved-view preset chips (All / Critical / Security / OAuth / Billing /
 *     Delivery) for keyboard-driven incident triage
 *   • Premium event cards with severity rail (left edge), category badges,
 *     hover lift, urgency glow on critical
 *   • Smooth-insertion animation when new events arrive in live mode
 *   • Rich incident drawer with related-event preview + quick actions to
 *     diagnostics / security / finance / audit
 *   • Operational-calm empty state with health reassurance + recent
 *     anomaly summary
 *
 * Initial data still server-rendered for fast first paint.
 * Live polling unchanged (5s tick, pause/sound toggles, visibility-aware).
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock,
  CreditCard,
  ExternalLink,
  Eye,
  Filter,
  KeyRound,
  Loader2,
  Pause,
  Play,
  Radio,
  Search,
  Shield,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";

import type { ActivityEvent, ActivityPage, ActivitySeverity } from "@/lib/admin-analytics/activity";
import type { Anomaly, AnomalyReport } from "@/lib/admin-analytics/anomalies";
import type {
  ActivityMissionKpis,
  ActivityPreset,
} from "@/lib/admin-analytics/activity-presets";
import { ACTIVITY_PRESETS, KIND_CATEGORY } from "@/lib/admin-analytics/activity-presets";
import ActivityMissionHero from "@/components/admin/ActivityMissionHero";

// ─── Local kind labels (mirrors lib/admin-analytics/activity.ts) ──

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  new_signup: "New signup",
  subscription_created: "Subscription created",
  subscription_upgraded: "Subscription upgraded",
  subscription_downgraded: "Subscription downgraded",
  subscription_cancelled: "Subscription cancelled",
  payment_failed: "Payment failed",
  invoice_paid: "Invoice paid",
  webhook_failed: "Webhook failed",
  webhook_recovered: "Webhook recovered",
  oauth_connected: "OAuth connected",
  oauth_failed: "OAuth failure",
  oauth_token_expired: "OAuth token expired",
  calendar_sync_failed: "Calendar sync failed",
  reminder_failed: "Reminder failed",
  queue_spike: "Queue spike",
  cron_failure: "Cron failure",
  suspicious_activity: "Suspicious activity",
  login_failure: "Login failure",
  impersonation_started: "Impersonation started",
  bulk_admin_action: "Bulk admin action",
  tenant_suspended: "Tenant suspended",
  tenant_reactivated: "Tenant reactivated",
  custom_domain_connected: "Custom domain connected",
  ses_bounce: "SES bounce/complaint",
  sms_failure: "SMS failure",
};

const ALL_KINDS = Object.keys(ACTIVITY_KIND_LABELS);

type Initial = {
  feed: ActivityPage | null;
  anomalies: AnomalyReport | null;
  mission: ActivityMissionKpis | null;
};

// ─── Time range presets ────────────────────────────────────────────

const RANGE_PRESETS = [
  { label: "Last 1h", ms: 60 * 60_000 },
  { label: "Last 24h", ms: 24 * 60 * 60_000 },
  { label: "Last 7d", ms: 7 * 24 * 60 * 60_000 },
  { label: "Last 30d", ms: 30 * 24 * 60 * 60_000 },
  { label: "All time", ms: null },
] as const;

// ─── Helpers ───────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

const SEV_CLS: Record<ActivitySeverity, string> = {
  info: "bg-sky-50 text-sky-700 ring-sky-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  critical: "bg-rose-50 text-rose-700 ring-rose-200",
};

const SEV_RAIL: Record<ActivitySeverity, string> = {
  info: "before:bg-sky-400/50",
  warning: "before:bg-amber-400/70",
  critical: "before:bg-rose-500/80",
};

const SEV_HOVER_BG: Record<ActivitySeverity, string> = {
  info: "hover:bg-sky-50/40",
  warning: "hover:bg-amber-50/40",
  critical: "hover:bg-rose-50/40",
};

const CATEGORY_STYLES: Record<
  string,
  { bg: string; text: string; ring: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  security: { bg: "bg-rose-50", text: "text-rose-700", ring: "ring-rose-200", Icon: Shield },
  auth: { bg: "bg-orange-50", text: "text-orange-700", ring: "ring-orange-200", Icon: KeyRound },
  billing: {
    bg: "bg-violet-50",
    text: "text-violet-700",
    ring: "ring-violet-200",
    Icon: CreditCard,
  },
  infrastructure: {
    bg: "bg-sky-50",
    text: "text-sky-700",
    ring: "ring-sky-200",
    Icon: Radio,
  },
  tenant: { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", Icon: Sparkles },
  info: { bg: "bg-slate-50", text: "text-slate-600", ring: "ring-slate-200", Icon: CircleDot },
};

const PRESET_ICONS: Record<ActivityPreset["icon"], React.ComponentType<{ className?: string }>> = {
  shield: Shield,
  key: KeyRound,
  zap: Zap,
  bell: Bell,
  "credit-card": CreditCard,
  activity: Activity,
};

const PRESET_TONE: Record<
  ActivityPreset["tone"],
  { active: string; idle: string }
> = {
  neutral: {
    active: "border-slate-900 bg-slate-900 text-white",
    idle: "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
  },
  primary: {
    active: "border-sky-500 bg-sky-50 text-sky-800 ring-1 ring-sky-200",
    idle: "border-slate-200 bg-white text-slate-700 hover:border-sky-200 hover:bg-sky-50/40",
  },
  warning: {
    active: "border-amber-500 bg-amber-50 text-amber-900 ring-1 ring-amber-200",
    idle: "border-slate-200 bg-white text-slate-700 hover:border-amber-200 hover:bg-amber-50/40",
  },
  critical: {
    active: "border-rose-500 bg-rose-50 text-rose-900 ring-1 ring-rose-200",
    idle: "border-slate-200 bg-white text-slate-700 hover:border-rose-200 hover:bg-rose-50/40",
  },
};

function categoryFor(kind: string) {
  return CATEGORY_STYLES[KIND_CATEGORY[kind] ?? "info"];
}

// ─── Anomaly banner ────────────────────────────────────────────────

function AnomalyBanner({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length === 0) return null;
  return (
    <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50/60 via-white to-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5" />
        Anomalies detected · {anomalies.length}
        <span className="ml-auto text-slate-400">deterministic rules · NO ML</span>
      </div>
      <ul className="mt-3 space-y-2">
        {anomalies.map((a) => (
          <li key={a.kind} className="flex items-start gap-3 text-[13px]">
            <span
              className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${
                SEV_CLS[a.severity]
              }`}
            >
              {a.severity}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-900">{a.label}</div>
              <div className="text-[12px] text-slate-600">{a.detail}</div>
            </div>
            <span className="whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {a.window}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Event card ────────────────────────────────────────────────────

function EventCard({
  event,
  grouped,
  onClick,
  isNew,
  focused,
}: {
  event: ActivityEvent;
  grouped?: number;
  onClick: () => void;
  isNew: boolean;
  focused: boolean;
}) {
  const cat = categoryFor(event.kind);
  const isCritical = event.severity === "critical";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 pl-5 text-left transition-all duration-300 last:border-b-0 before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:transition-opacity ${SEV_RAIL[event.severity]} ${SEV_HOVER_BG[event.severity]} ${
        focused ? "bg-slate-50/40 ring-1 ring-inset ring-slate-200" : ""
      } ${isNew ? "animate-[fadeInRow_500ms_ease-out] bg-sky-50/40" : ""} ${
        isCritical ? "before:opacity-100" : "before:opacity-70"
      }`}
    >
      {/* Severity pill */}
      <span
        className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${
          SEV_CLS[event.severity]
        }`}
      >
        {event.severity}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-slate-900">{event.summary}</span>
          {grouped && grouped > 1 ? (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              ×{grouped} clustered
            </span>
          ) : null}
          {isNew ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-sky-700">
              <span className="relative inline-flex h-1 w-1">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75" />
                <span className="relative inline-flex h-1 w-1 rounded-full bg-sky-500" />
              </span>
              New
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          {/* Category badge */}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${cat.bg} ${cat.text} ${cat.ring}`}
          >
            <cat.Icon className="h-2.5 w-2.5" />
            {ACTIVITY_KIND_LABELS[event.kind] ?? event.kind}
          </span>
          <span>·</span>
          <span title={event.ts}>{timeAgo(event.ts)}</span>
          {event.tenantId ? (
            <>
              <span>·</span>
              <span className="font-mono">tenant {event.tenantId.slice(0, 8)}</span>
            </>
          ) : null}
          {event.actorLabel ? (
            <>
              <span>·</span>
              <span className="truncate">{event.actorLabel}</span>
            </>
          ) : null}
        </div>
      </div>
      <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" />
    </button>
  );
}

// ─── Incident drawer ──────────────────────────────────────────────

function EventDrawer({
  event,
  related,
  onClose,
}: {
  event: ActivityEvent | null;
  related: ActivityEvent[];
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!event) return null;
  const cat = categoryFor(event.kind);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl animate-[slideInDrawer_220ms_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-gradient-to-br from-white via-white to-slate-50/50 px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${
                    SEV_CLS[event.severity]
                  }`}
                >
                  {event.severity}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${cat.bg} ${cat.text} ${cat.ring}`}
                >
                  <cat.Icon className="h-2.5 w-2.5" />
                  {ACTIVITY_KIND_LABELS[event.kind] ?? event.kind}
                </span>
              </div>
              <h2 className="mt-2 text-base font-semibold tracking-tight text-slate-900">
                {event.summary}
              </h2>
              <div className="mt-1 text-[12px] text-slate-500">
                <span>{new Date(event.ts).toLocaleString()}</span>
                <span> · {timeAgo(event.ts)}</span>
              </div>
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
          <Section title="Context">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <Field label="Action" value={<code className="text-[12px]">{event.action}</code>} />
              <Field
                label="Tenant"
                value={
                  event.tenantId ? (
                    <a
                      href={`/admin/tenants/${event.tenantId}`}
                      className="text-sky-700 hover:underline"
                    >
                      {event.tenantId.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )
                }
              />
              <Field
                label="Actor"
                value={event.actorLabel ?? <span className="text-slate-400">—</span>}
              />
              <Field
                label="IP"
                value={event.ipAddress ?? <span className="text-slate-400">—</span>}
              />
              <Field
                label="Entity"
                value={
                  event.entityType ? (
                    <span>
                      {event.entityType}
                      {event.entityId ? ` · ${event.entityId.slice(0, 8)}` : ""}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )
                }
              />
            </dl>
          </Section>

          {/* Related events — same groupKey, ranked by time */}
          {related.length > 0 ? (
            <Section title={`Related events (${related.length})`}>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-[12px]">
                {related.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-slate-700">{r.summary}</span>
                    <span className="ml-2 whitespace-nowrap text-slate-400">{timeAgo(r.ts)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {event.metadata && Object.keys(event.metadata).length > 0 ? (
            <Section title="Metadata">
              <pre className="overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </Section>
          ) : null}

          <Section title="Quick actions">
            <div className="grid grid-cols-2 gap-2">
              {event.tenantId ? (
                <>
                  <ActionLink
                    href={`/admin/tenants/${event.tenantId}`}
                    label="Open tenant"
                    Icon={ExternalLink}
                  />
                  <ActionLink
                    href={`/admin/activity?tenantId=${event.tenantId}`}
                    label="Filter by tenant"
                    Icon={Filter}
                  />
                </>
              ) : null}
              <ActionLink
                href={`/admin/activity?kinds=${event.kind}`}
                label="Filter by kind"
                Icon={Filter}
              />
              <ActionLink href="/admin/diagnostics" label="Open diagnostics" Icon={Activity} />
              {(KIND_CATEGORY[event.kind] === "billing" || event.kind === "payment_failed") ? (
                <ActionLink href="/admin/finance" label="Open finance" Icon={CreditCard} />
              ) : null}
              {(KIND_CATEGORY[event.kind] === "security" ||
                KIND_CATEGORY[event.kind] === "auth") ? (
                <ActionLink href="/admin/security" label="Open security" Icon={Shield} />
              ) : null}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {title}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </>
  );
}

function ActionLink({
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

// ─── Operational-calm empty state ─────────────────────────────────

function CalmEmptyState({
  kpis,
  anomalies,
  hasFilters,
}: {
  kpis: ActivityMissionKpis | null;
  anomalies: Anomaly[];
  hasFilters: boolean;
}) {
  if (hasFilters) {
    return (
      <div className="px-4 py-14 text-center">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 ring-1 ring-slate-200">
          <Search className="h-5 w-5 text-slate-400" />
        </div>
        <div className="mt-3 text-sm font-semibold text-slate-900">No events match these filters</div>
        <div className="mt-1 text-[12px] text-slate-500">
          Try widening the time range or clearing the preset.
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-14 text-center">
      <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200/60">
        <CheckCircle2 className="h-7 w-7 text-emerald-500" />
      </div>
      <div className="mt-3 text-sm font-semibold text-slate-900">All quiet — operations nominal</div>
      <div className="mt-1 max-w-md mx-auto text-[12px] leading-snug text-slate-500">
        No events in this window. The stream is healthy; activity will appear here within seconds of
        an audit-log write.
      </div>
      {kpis ? (
        <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 text-[11px]">
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 ring-1 ring-emerald-200">
            {kpis.eventsLastHour} events / 1h
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
            baseline {kpis.baselineEventsPerHour}/hr
          </span>
          {anomalies.length === 0 ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 ring-1 ring-emerald-200">
              0 anomalies
            </span>
          ) : (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-amber-200">
              {anomalies.length} anomalies
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Top-level client ──────────────────────────────────────────────

export default function ActivityCenter({ initial }: { initial: Initial }) {
  const [events, setEvents] = React.useState<ActivityEvent[]>(initial.feed?.events ?? []);
  const [cursor, setCursor] = React.useState<string | null>(initial.feed?.nextCursor ?? null);
  const [anomalies, setAnomalies] = React.useState<Anomaly[]>(initial.anomalies?.anomalies ?? []);
  const [mission, setMission] = React.useState<ActivityMissionKpis | null>(initial.mission);

  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [kinds, setKinds] = React.useState<string[]>([]);
  const [severity, setSeverity] = React.useState<"" | ActivitySeverity>("");
  const [tenantFilter, setTenantFilter] = React.useState("");
  const [rangeIdx, setRangeIdx] = React.useState(2); // Default "Last 7d"
  const [showFilter, setShowFilter] = React.useState(false);
  const [activePresetId, setActivePresetId] = React.useState<string>("all");

  const [liveMode, setLiveMode] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [soundOn, setSoundOn] = React.useState(false);
  const [newIds, setNewIds] = React.useState<Set<string>>(new Set());

  const [drawerEvent, setDrawerEvent] = React.useState<ActivityEvent | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [focusIdx, setFocusIdx] = React.useState(0);

  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Initialize from URL on first mount
  React.useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const k = sp.get("kinds");
    if (k) setKinds(k.split(",").filter(Boolean));
    const t = sp.get("tenantId");
    if (t) setTenantFilter(t);
    const preset = sp.get("preset");
    if (preset) applyPreset(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search input
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  // Build the query string used by all fetches.
  const buildParams = React.useCallback(
    (limit: number, opts?: { cursor?: string | null; since?: string | null }) => {
      const sp = new URLSearchParams({ limit: String(limit) });
      if (debouncedSearch) sp.set("q", debouncedSearch);
      if (kinds.length > 0) sp.set("kinds", kinds.join(","));
      if (tenantFilter.trim()) sp.set("tenantId", tenantFilter.trim());
      const rangeMs = RANGE_PRESETS[rangeIdx].ms;
      if (opts?.since) sp.set("since", opts.since);
      else if (rangeMs !== null) sp.set("since", new Date(Date.now() - rangeMs).toISOString());
      if (opts?.cursor) sp.set("cursor", opts.cursor);
      return sp;
    },
    [debouncedSearch, kinds, tenantFilter, rangeIdx],
  );

  // Initial / filter-change fetch
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sp = buildParams(50);
        const res = await fetch(`/api/admin/activity/feed?${sp.toString()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const page = (await res.json()) as ActivityPage;
        if (cancelled) return;
        setEvents(page.events);
        setCursor(page.nextCursor);
        setNewIds(new Set());
        setFocusIdx(0);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [buildParams]);

  // Anomaly poll (every 60s, regardless of live mode)
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/admin/activity/anomalies", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const r = (await res.json()) as AnomalyReport;
        if (!cancelled) setAnomalies(r.anomalies);
      } catch {}
    };
    const id = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Mission KPI poll — refreshes on live mode tick + every 30s otherwise.
  React.useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/admin/activity/mission", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const r = (await res.json()) as ActivityMissionKpis;
        if (!cancelled) setMission(r);
      } catch {}
    };
    const id = window.setInterval(refresh, liveMode ? 15_000 : 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [liveMode]);

  // Live mode poll
  React.useEffect(() => {
    if (!liveMode || paused) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const since = events.length > 0 ? events[0].ts : new Date(Date.now() - 60_000).toISOString();
        const sp = buildParams(50, { since });
        const res = await fetch(`/api/admin/activity/feed?${sp.toString()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const page = (await res.json()) as ActivityPage;
        if (cancelled || page.events.length === 0) return;
        const fresh = page.events.filter((e) => !events.some((existing) => existing.id === e.id));
        if (fresh.length === 0) return;
        setEvents((prev) => [...fresh, ...prev]);
        setNewIds((prev) => {
          const next = new Set(prev);
          for (const e of fresh) next.add(e.id);
          return next;
        });
        // Clear highlight after 4s
        window.setTimeout(() => {
          setNewIds((prev) => {
            const next = new Set(prev);
            for (const e of fresh) next.delete(e.id);
            return next;
          });
        }, 4000);
        if (soundOn && audioRef.current) {
          audioRef.current.currentTime = 0;
          audioRef.current.play().catch(() => undefined);
        }
      } catch {}
    };
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [liveMode, paused, events, buildParams, soundOn]);

  // Keyboard nav
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (drawerEvent) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        setFocusIdx((i) => Math.min(events.length - 1, i + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" && events[focusIdx]) {
        setDrawerEvent(events[focusIdx]);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [events, focusIdx, drawerEvent]);

  // Group consecutive same-groupKey rows for display.
  const displayRows: Array<{ event: ActivityEvent; grouped: number }> = React.useMemo(() => {
    const out: Array<{ event: ActivityEvent; grouped: number }> = [];
    let i = 0;
    while (i < events.length) {
      const head = events[i];
      let j = i + 1;
      // Only group when the timestamps are within 5 minutes
      while (
        j < events.length &&
        events[j].groupKey === head.groupKey &&
        new Date(head.ts).getTime() - new Date(events[j].ts).getTime() < 5 * 60_000
      ) {
        j++;
      }
      out.push({ event: head, grouped: j - i });
      i = j;
    }
    return out;
  }, [events]);

  // Filter by severity client-side.
  const filtered = severity ? displayRows.filter((r) => r.event.severity === severity) : displayRows;

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = buildParams(50, { cursor });
      const res = await fetch(`/api/admin/activity/feed?${sp.toString()}`, { cache: "no-store" });
      if (res.ok) {
        const page = (await res.json()) as ActivityPage;
        setEvents((prev) => [...prev, ...page.events]);
        setCursor(page.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleKind(k: string) {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  function applyPreset(id: string) {
    const preset = ACTIVITY_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setActivePresetId(id);
    setKinds(preset.kinds);
    setSeverity(preset.severity);
  }

  // Build related-events list for the drawer (same groupKey, exclude self).
  const drawerRelated = React.useMemo(() => {
    if (!drawerEvent) return [];
    return events
      .filter((e) => e.id !== drawerEvent.id && e.groupKey === drawerEvent.groupKey)
      .slice(0, 12);
  }, [drawerEvent, events]);

  const hasActiveFilters =
    debouncedSearch.length > 0 ||
    kinds.length > 0 ||
    severity !== "" ||
    tenantFilter.trim().length > 0;

  return (
    <div className="space-y-5">
      <style jsx global>{`
        @keyframes fadeInRow {
          0% {
            opacity: 0;
            transform: translateY(-6px);
            background-color: rgba(14, 165, 233, 0.12);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
            background-color: rgba(14, 165, 233, 0.04);
          }
        }
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

      {/* Executive mission hero */}
      {mission ? <ActivityMissionHero kpis={mission} liveOn={liveMode && !paused} /> : null}

      {/* Preset chip row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ACTIVITY_PRESETS.map((p) => {
          const Icon = PRESET_ICONS[p.icon];
          const active = activePresetId === p.id;
          const tone = PRESET_TONE[p.tone];
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition-all ${
                active ? tone.active : tone.idle
              }`}
            >
              <Icon className="h-3 w-3" />
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Sticky filter bar */}
      <div className="sticky top-0 z-10 -mx-2 space-y-2 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search activity…"
              className="w-64 rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-3 text-[13px] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </div>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as "" | ActivitySeverity)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
          >
            <option value="">All severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            value={rangeIdx}
            onChange={(e) => setRangeIdx(Number(e.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
          >
            {RANGE_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            placeholder="Tenant ID…"
            className="w-40 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setShowFilter((s) => !s)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <Filter className="h-3 w-3" />
            Kinds
            {kinds.length > 0 ? (
              <span className="ml-1 rounded-full bg-slate-900 px-1.5 text-[10px] text-white">
                {kinds.length}
              </span>
            ) : null}
          </button>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLiveMode((v) => !v)}
              className={`relative inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-all ${
                liveMode
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700 shadow-[0_0_0_3px_rgba(16,185,129,0.08)]"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {liveMode && !paused ? (
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
              ) : (
                <Zap className={`h-3 w-3 ${liveMode ? "fill-emerald-500 text-emerald-500" : ""}`} />
              )}
              Live
              {liveMode ? (
                <span className="text-[10px] font-medium uppercase tracking-wider opacity-80">
                  · 5s
                </span>
              ) : null}
            </button>
            {liveMode ? (
              <>
                <button
                  type="button"
                  onClick={() => setPaused((v) => !v)}
                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                  title={paused ? "Resume polling" : "Pause polling"}
                >
                  {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => setSoundOn((v) => !v)}
                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                  title={soundOn ? "Mute notifications" : "Enable notification sound"}
                >
                  {soundOn ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
                </button>
              </>
            ) : null}
          </div>
        </div>

        {showFilter ? (
          <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-2">
            {ALL_KINDS.map((k) => {
              const active = kinds.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleKind(k)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    active
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                  }`}
                >
                  {ACTIVITY_KIND_LABELS[k]}
                </button>
              );
            })}
            {kinds.length > 0 ? (
              <button
                type="button"
                onClick={() => setKinds([])}
                className="rounded-full px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 hover:underline"
              >
                Clear kinds
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <AnomalyBanner anomalies={anomalies} />

      {/* Stream */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-slate-50/80 to-white px-4 py-2.5">
          <div className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-slate-800">
            <Clock className="h-3.5 w-3.5 text-slate-500" />
            Activity stream
            <span className="text-[11px] font-medium text-slate-500">
              · {events.length} loaded
              {liveMode ? (
                <span className="ml-1 text-emerald-700">
                  {paused ? "(paused)" : "(live, 5s)"}
                </span>
              ) : null}
            </span>
          </div>
          <div className="text-[10px] text-slate-400">
            j/k navigate · enter open · esc close
          </div>
        </div>

        {filtered.length === 0 ? (
          <CalmEmptyState kpis={mission} anomalies={anomalies} hasFilters={hasActiveFilters} />
        ) : (
          filtered.map(({ event, grouped }, idx) => (
            <EventCard
              key={event.id}
              event={event}
              grouped={grouped}
              onClick={() => setDrawerEvent(event)}
              isNew={newIds.has(event.id)}
              focused={focusIdx === idx}
            />
          ))
        )}

        {cursor ? (
          <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Load more
            </button>
          </div>
        ) : null}
      </div>

      <EventDrawer event={drawerEvent} related={drawerRelated} onClose={() => setDrawerEvent(null)} />

      <audio
        ref={audioRef}
        src="data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        preload="auto"
      />
    </div>
  );
}
