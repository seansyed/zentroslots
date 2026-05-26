"use client";

/**
 * SA-5 — Advanced Live Activity Center client.
 *
 * Single full-page operations stream. Builds on the SA-3 feed plus:
 *   • Live Mode (5s poll, pause toggle, sound toggle, smooth insertion)
 *   • Search input (full-text against summary + raw action)
 *   • Tenant filter (paste/select a tenantId)
 *   • Time range filter (last 1h / 24h / 7d / 30d / all)
 *   • Severity filter (info / warning / critical)
 *   • Kind filter chips (24 supported kinds)
 *   • Anomaly banner (deterministic rules; only renders when ≥1 fires)
 *   • Grouped events (consecutive rows with same group key collapse)
 *   • Click row → metadata drawer (right-side sheet)
 *   • Keyboard: J/K navigate, Esc close drawer
 *
 * Initial data is server-rendered for fast first paint.
 */

import * as React from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  Filter,
  Loader2,
  Pause,
  Play,
  Search,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";

import type { ActivityEvent, ActivityPage, ActivitySeverity } from "@/lib/admin-analytics/activity";
import type { Anomaly, AnomalyReport } from "@/lib/admin-analytics/anomalies";

// Mirrored from lib/admin-analytics/activity.ts. Inlined here to keep
// this client component free of server-only imports (the lib module
// transitively pulls db/client.ts which Next.js can't ship to the
// browser). Adding a new kind in both places is a one-line change.
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

// ─── Anomaly banner ────────────────────────────────────────────────

function AnomalyBanner({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5" />
        Anomalies detected · {anomalies.length}
      </div>
      <ul className="mt-2 space-y-1.5">
        {anomalies.map((a) => (
          <li key={a.kind} className="flex items-start gap-2 text-[13px]">
            <span
              className={`mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                SEV_CLS[a.severity]
              }`}
            >
              {a.severity}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-900">{a.label}</div>
              <div className="text-[12px] text-slate-600">{a.detail}</div>
            </div>
            <span className="text-[11px] text-slate-500 whitespace-nowrap">{a.window}</span>
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
}: {
  event: ActivityEvent;
  grouped?: number;
  onClick: () => void;
  isNew: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left transition-all last:border-b-0 hover:bg-slate-50/60 ${
        isNew ? "animate-pulse-once bg-sky-50/40" : ""
      }`}
    >
      <span
        className={`mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${
          SEV_CLS[event.severity]
        }`}
      >
        {event.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-slate-900">{event.summary}</span>
          {grouped && grouped > 1 ? (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              +{grouped - 1} similar
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span>{ACTIVITY_KIND_LABELS[event.kind] ?? event.kind}</span>
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
      <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />
    </button>
  );
}

// ─── Metadata drawer ───────────────────────────────────────────────

function EventDrawer({ event, onClose }: { event: ActivityEvent | null; onClose: () => void }) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!event) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4">
          <div className="min-w-0">
            <div
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${
                SEV_CLS[event.severity]
              }`}
            >
              {event.severity} · {ACTIVITY_KIND_LABELS[event.kind] ?? event.kind}
            </div>
            <h2 className="mt-1.5 text-base font-semibold text-slate-900">{event.summary}</h2>
            <div className="mt-1 text-[12px] text-slate-500">
              <span>{new Date(event.ts).toLocaleString()}</span>
              <span> · {timeAgo(event.ts)}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          <Section title="Context">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <Field label="Action" value={<code className="text-[12px]">{event.action}</code>} />
              <Field
                label="Tenant"
                value={
                  event.tenantId ? (
                    <a href={`/admin/tenants/${event.tenantId}`} className="text-sky-700 hover:underline">
                      {event.tenantId.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )
                }
              />
              <Field label="Actor" value={event.actorLabel ?? <span className="text-slate-400">—</span>} />
              <Field label="IP" value={event.ipAddress ?? <span className="text-slate-400">—</span>} />
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

          {event.metadata && Object.keys(event.metadata).length > 0 ? (
            <Section title="Metadata">
              <pre className="overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </Section>
          ) : null}

          <Section title="Quick actions">
            <div className="flex flex-wrap gap-2">
              {event.tenantId ? (
                <>
                  <ActionLink href={`/admin/tenants/${event.tenantId}`} label="Open tenant" />
                  <ActionLink
                    href={`/admin/activity?tenantId=${event.tenantId}`}
                    label="Filter by tenant"
                  />
                </>
              ) : null}
              <ActionLink href={`/admin/activity?kinds=${event.kind}`} label="Filter by kind" />
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
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">{title}</div>
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

function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
    >
      {label} <ChevronRight className="h-3 w-3" />
    </a>
  );
}

// ─── Top-level client ──────────────────────────────────────────────

export default function ActivityCenter({ initial }: { initial: Initial }) {
  const [events, setEvents] = React.useState<ActivityEvent[]>(initial.feed?.events ?? []);
  const [cursor, setCursor] = React.useState<string | null>(initial.feed?.nextCursor ?? null);
  const [anomalies, setAnomalies] = React.useState<Anomaly[]>(initial.anomalies?.anomalies ?? []);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [kinds, setKinds] = React.useState<string[]>([]);
  const [severity, setSeverity] = React.useState<"" | ActivitySeverity>("");
  const [tenantFilter, setTenantFilter] = React.useState("");
  const [rangeIdx, setRangeIdx] = React.useState(2); // Default "Last 7d"
  const [showFilter, setShowFilter] = React.useState(false);

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
      // Only group when the timestamps are within 5 minutes — older
      // events of the same kind should still be visible individually.
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

  // Filter by severity client-side (the server doesn't have a
  // severity column; severity is derived in the classifier).
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

  return (
    <div className="space-y-4">
      {/* Sticky filter bar */}
      <div className="sticky top-0 z-10 -mx-2 space-y-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
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
              <span className="ml-1 rounded-full bg-slate-900 px-1.5 text-[10px] text-white">{kinds.length}</span>
            ) : null}
          </button>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLiveMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium ${
                liveMode
                  ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <Zap className={`h-3 w-3 ${liveMode ? "fill-emerald-500 text-emerald-500" : ""}`} />
              Live
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
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
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
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <Clock className="h-3.5 w-3.5 text-slate-500" />
            Activity stream
            <span className="text-[11px] text-slate-500">
              · {events.length} loaded
              {liveMode ? (
                <span className="ml-1 text-emerald-700">{paused ? "(paused)" : "(live, 5s)"}</span>
              ) : null}
            </span>
          </div>
          <div className="text-[11px] text-slate-400">Keyboard: j/k navigate · enter open · esc close</div>
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-14 text-center text-sm text-slate-500">No events match your filters.</div>
        ) : (
          filtered.map(({ event, grouped }, idx) => (
            <div
              key={event.id}
              className={focusIdx === idx ? "bg-slate-50/40 ring-1 ring-inset ring-slate-200" : ""}
            >
              <EventCard
                event={event}
                grouped={grouped}
                onClick={() => setDrawerEvent(event)}
                isNew={newIds.has(event.id)}
              />
            </div>
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
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
              Load more
            </button>
          </div>
        ) : null}
      </div>

      <EventDrawer event={drawerEvent} onClose={() => setDrawerEvent(null)} />

      {/* Live-mode notification ping. Inline data URI = 0 network cost. */}
      <audio
        ref={audioRef}
        src="data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        preload="auto"
      />
    </div>
  );
}
