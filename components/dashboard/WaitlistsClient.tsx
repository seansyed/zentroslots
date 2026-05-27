"use client";

import * as React from "react";
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  Hourglass,
  Inbox,
  Mail,
  MailCheck,
  RefreshCw,
  Shield,
  Sparkles,
  Timer,
  TrendingUp,
  UserCheck,
  Users,
  X,
  XCircle,
} from "lucide-react";

import { Badge, Card, Skeleton, toast, confirmAction } from "@/components/ui/primitives";

// ─── Types (unchanged contract with /api/tenant/waitlists) ───────────

type Entry = {
  id: string;
  serviceId: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string | null;
  preferredDate: string | null;
  preferredTimeRange: string;
  status: string;
  priority: number;
  expiresAt: string | null;
  claimedAt: string | null;
  claimedBookingId: string | null;
  createdAt: string;
  serviceName: string | null;
};

type Notif = {
  id: string;
  waitlistId: string;
  bookingId: string | null;
  notificationType: string;
  status: string;
  slotStartAt: string | null;
  slotEndAt: string | null;
  expiresAt: string;
  respondedAt: string | null;
  createdAt: string;
};

type Service = { id: string; name: string; slug: string };

type ApiData = { entries: Entry[]; notifications: Notif[]; services: Service[] };

// ─── Status taxonomy ─────────────────────────────────────────────────

type StatusFilter = "all" | "waiting" | "notified" | "claimed" | "expired" | "cancelled";

const STATUS_META: Record<
  string,
  { label: string; classes: string; dot: string; icon: React.ComponentType<{ className?: string }> }
> = {
  waiting: {
    label: "Waiting",
    classes: "bg-sky-50 text-sky-700",
    dot: "bg-sky-500",
    icon: Hourglass,
  },
  notified: {
    label: "On hold",
    classes: "bg-amber-50 text-amber-800",
    dot: "bg-amber-500",
    icon: Bell,
  },
  claimed: {
    label: "Claimed",
    classes: "bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
    icon: CheckCircle2,
  },
  expired: {
    label: "Expired",
    classes: "bg-slate-100 text-slate-600",
    dot: "bg-slate-400",
    icon: XCircle,
  },
  cancelled: {
    label: "Cancelled",
    classes: "bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
    icon: X,
  },
  sent: { // notification status
    label: "Sent",
    classes: "bg-sky-50 text-sky-700",
    dot: "bg-sky-500",
    icon: MailCheck,
  },
  failed: { // notification status
    label: "Failed",
    classes: "bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
    icon: AlertCircle,
  },
};

// ─── Root ─────────────────────────────────────────────────────────────

export default function WaitlistsClient() {
  const [data, setData] = React.useState<ApiData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [serviceFilter, setServiceFilter] = React.useState<string>("all");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tenant/waitlists", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function action(id: string, kind: "cancel" | "expire_hold") {
    if (
      !(await confirmAction({
        title: kind === "cancel" ? "Remove from waitlist?" : "Force-expire this reservation hold?",
        body: kind === "cancel"
          ? "This customer is removed from the waitlist. They won't be notified when slots open."
          : "The slot is released and offered to the next eligible customer on the waitlist.",
        variant: "warning",
        confirmLabel: kind === "cancel" ? "Remove customer" : "Expire hold",
      }))
    ) {
      return;
    }
    try {
      const res = await fetch("/api/tenant/waitlists", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: kind }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Updated", "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  }

  // ── Real KPIs derived from existing API response ──────────────────
  const metrics = React.useMemo(() => deriveMetrics(data), [data]);

  // ── Filtered + sorted entries ─────────────────────────────────────
  const filteredEntries = React.useMemo(() => {
    if (!data) return [] as Entry[];
    let rows = data.entries;
    if (filter !== "all") rows = rows.filter((e) => e.status === filter);
    if (serviceFilter !== "all") rows = rows.filter((e) => e.serviceId === serviceFilter);
    return rows;
  }, [data, filter, serviceFilter]);

  return (
    <div className="mt-6 space-y-6 pb-12">
      <Hero metrics={metrics} loading={loading} onRefresh={refresh} />

      <KpiStrip metrics={metrics} loading={loading} />

      <EngineBehaviorCard />

      <FiltersBar
        filter={filter}
        setFilter={setFilter}
        services={data?.services ?? []}
        serviceFilter={serviceFilter}
        setServiceFilter={setServiceFilter}
        counts={metrics.counts}
      />

      <QueueSection
        entries={filteredEntries}
        totalEntries={data?.entries.length ?? 0}
        loading={loading}
        onAction={action}
      />

      <ActivitySection notifications={data?.notifications ?? []} loading={loading} />
    </div>
  );
}

// ─── Hero (Phase 1) ───────────────────────────────────────────────────

function Hero({
  metrics,
  loading,
  onRefresh,
}: {
  metrics: Metrics;
  loading: boolean;
  onRefresh: () => void;
}) {
  const engineActive = metrics.counts.waiting > 0 || metrics.counts.notified > 0;
  return (
    <Card className="overflow-hidden p-0">
      <div className="bg-gradient-to-br from-brand-accent/8 via-surface to-surface px-6 py-7">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-accent/10 text-brand-accent">
              <Inbox className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-accent">
                  <Sparkles className="h-3 w-3" /> Schedule recovery
                </span>
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold " +
                    (engineActive
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-600")
                  }
                >
                  <span
                    className={
                      "h-1.5 w-1.5 rounded-full " +
                      (engineActive ? "animate-pulse bg-emerald-500" : "bg-slate-400")
                    }
                  />
                  {engineActive
                    ? `${metrics.counts.waiting + metrics.counts.notified} active in queue`
                    : "Queue idle"}
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
                Waitlists &amp; Auto-Fill
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                Automatically recover cancelled bookings and maximize schedule
                utilization. Customers join from the public booking page when
                their preferred date is full — when an opening appears, the
                engine offers it to the next-best match with a 15-minute
                reservation hold.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
            aria-label="Refresh waitlist data"
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
            Refresh
          </button>
        </div>
      </div>
    </Card>
  );
}

// ─── KPI strip (Phase 2 — REAL data only) ────────────────────────────

function KpiStrip({
  metrics,
  loading,
}: {
  metrics: Metrics;
  loading: boolean;
}) {
  // Honest set of KPIs: every value is derived from existing API data.
  // We intentionally do NOT render "recovery rate %" or "revenue
  // recovered" — the schema doesn't carry source attribution on
  // bookings, so those would be fake.
  const items = [
    {
      icon: Hourglass,
      label: "Waiting",
      value: String(metrics.counts.waiting),
      tone: metrics.counts.waiting > 0 ? "sky" : "muted",
      hint: "Customers in the queue",
    },
    {
      icon: Bell,
      label: "On hold",
      value: String(metrics.counts.notified),
      tone: metrics.counts.notified > 0 ? "amber" : "muted",
      hint: "Active reservation offers",
    },
    {
      icon: CheckCircle2,
      label: "Auto-filled",
      value: String(metrics.counts.claimed),
      tone: metrics.counts.claimed > 0 ? "emerald" : "muted",
      hint: "Slots recovered lifetime",
    },
    {
      icon: XCircle,
      label: "Expired holds",
      value: String(metrics.expiredHoldsCount),
      tone: metrics.expiredHoldsCount > 0 ? "rose" : "muted",
      hint: "Offers that timed out",
    },
    {
      icon: Timer,
      label: "Avg claim time",
      value: metrics.avgClaimMinutes === null ? "—" : `${metrics.avgClaimMinutes} min`,
      tone: metrics.avgClaimMinutes === null ? "muted" : "default",
      hint: "From join to claim",
    },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((it) => (
        <KpiCard
          key={it.label}
          icon={it.icon}
          label={it.label}
          value={loading ? "…" : it.value}
          tone={it.tone}
          hint={it.hint}
        />
      ))}
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "default" | "sky" | "amber" | "emerald" | "rose" | "muted";
  hint: string;
}) {
  const valueTone =
    tone === "sky"
      ? "text-sky-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "emerald"
          ? "text-emerald-700"
          : tone === "rose"
            ? "text-rose-700"
            : tone === "muted"
              ? "text-ink-subtle"
              : "text-ink";
  const iconWrap =
    tone === "sky"
      ? "bg-sky-50 text-sky-600"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700"
        : tone === "emerald"
          ? "bg-emerald-50 text-emerald-700"
          : tone === "rose"
            ? "bg-rose-50 text-rose-700"
            : "bg-brand-accent/10 text-brand-accent";
  return (
    <Card className="group flex items-start gap-3 p-4 transition-shadow duration-150 hover:shadow-md">
      <div className={"grid h-9 w-9 shrink-0 place-items-center rounded-lg " + iconWrap}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className={"text-xl font-semibold tabular-nums " + valueTone}>{value}</div>
        <div className="mt-0.5 text-[11px] font-medium text-ink">{label}</div>
        <div className="text-[10px] text-ink-subtle">{hint}</div>
      </div>
    </Card>
  );
}

// ─── Engine behavior card (Phase 5/6 — honest read-only) ─────────────

function EngineBehaviorCard() {
  // Honest representation of the engine's CURRENT hardcoded behavior.
  // The brief asks for a configurable settings panel — none of these
  // are tenant-configurable today (no schema for it). Surfacing them
  // as read-only is the honest path; tenant-configurable lands in a
  // separate phase when the backend supports it.
  const rows: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    detail: string;
  }> = [
    {
      icon: Timer,
      label: "Hold duration",
      value: "15 minutes",
      detail: "Reservation expires after 15 min if not claimed. The cron worker re-promotes the slot to the next eligible customer.",
    },
    {
      icon: ArrowDownUp,
      label: "Priority strategy",
      value: "Best match → FIFO",
      detail: "Rank: exact date + time-range > exact date > time-range > any. Within a rank, oldest-joined wins.",
    },
    {
      icon: Mail,
      label: "Notification channel",
      value: "Email only",
      detail: "Powered by the workspace SMTP configuration. SMS + push are not currently wired.",
    },
    {
      icon: UserCheck,
      label: "Simultaneous offers per customer",
      value: "1",
      detail: "A customer can only hold one offer at a time. Enforced by a partial unique index.",
    },
    {
      icon: Shield,
      label: "Staff confirmation",
      value: "Not required",
      detail: "Holds are placed automatically when a slot opens. Staff don't need to approve.",
    },
    {
      icon: Clock,
      label: "Notification window",
      value: "24/7",
      detail: "Offers fire any time a slot opens. No quiet-hours suppression today.",
    },
  ];
  return (
    <section>
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Auto-fill engine</h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                Current matching + notification behavior. Read-only — these are
                platform-level defaults today. Tenant-configurable options land
                in a future phase.
              </p>
            </div>
          </div>
        </div>
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3"
            >
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-ink-subtle">
                <r.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                    {r.label}
                  </span>
                </div>
                <div className="mt-0.5 text-sm font-semibold text-ink">{r.value}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{r.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

// ─── Filters (Phase 9) ────────────────────────────────────────────────

function FiltersBar({
  filter,
  setFilter,
  services,
  serviceFilter,
  setServiceFilter,
  counts,
}: {
  filter: StatusFilter;
  setFilter: (s: StatusFilter) => void;
  services: Service[];
  serviceFilter: string;
  setServiceFilter: (s: string) => void;
  counts: Metrics["counts"];
}) {
  const filters: Array<{ key: StatusFilter; label: string; count: number; tone?: "sky" | "amber" | "emerald" | "rose" | "muted" }> = [
    { key: "all", label: "All", count: counts.all },
    { key: "waiting", label: "Waiting", count: counts.waiting, tone: "sky" },
    { key: "notified", label: "On hold", count: counts.notified, tone: "amber" },
    { key: "claimed", label: "Claimed", count: counts.claimed, tone: "emerald" },
    { key: "expired", label: "Expired", count: counts.expired, tone: "muted" },
    { key: "cancelled", label: "Cancelled", count: counts.cancelled, tone: "rose" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {filters.map((f) => (
          <FilterChip
            key={f.key}
            label={f.label}
            count={f.count}
            active={filter === f.key}
            tone={f.tone}
            onClick={() => setFilter(f.key)}
            hideIfZero={f.key !== "all" && f.key !== "waiting" && f.count === 0}
          />
        ))}
      </div>
      {services.length > 1 && (
        <>
          <span className="hidden text-ink-subtle sm:inline">·</span>
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
            aria-label="Filter by service"
          >
            <option value="all">All services</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
  hideIfZero,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "sky" | "amber" | "emerald" | "rose" | "muted";
  onClick: () => void;
  hideIfZero?: boolean;
}) {
  if (hideIfZero && count === 0) return null;
  const baseTone =
    tone === "sky"
      ? "text-sky-700"
      : tone === "amber"
        ? "text-amber-800"
        : tone === "emerald"
          ? "text-emerald-700"
          : tone === "rose"
            ? "text-rose-700"
            : "text-ink-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 " +
        (active
          ? "border-brand-accent bg-brand-accent text-white"
          : "border-border bg-surface hover:bg-surface-muted " + baseTone)
      }
    >
      <span>{label}</span>
      <span
        className={
          "rounded-full px-1.5 text-[10px] tabular-nums " +
          (active ? "bg-white/20" : "bg-slate-100 text-slate-600")
        }
      >
        {count}
      </span>
    </button>
  );
}

// ─── Queue section (Phase 3, 4) ──────────────────────────────────────

function QueueSection({
  entries,
  totalEntries,
  loading,
  onAction,
}: {
  entries: Entry[];
  totalEntries: number;
  loading: boolean;
  onAction: (id: string, kind: "cancel" | "expire_hold") => void;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Users}
        title="Queue"
        subtitle={
          totalEntries === 0
            ? "No customers waiting yet."
            : `${entries.length} of ${totalEntries} entries`
        }
      />
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : totalEntries === 0 ? (
        <QueueEmptyState />
      ) : entries.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-muted">
          No entries match these filters.
        </Card>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <EntryCard key={e.id} entry={e} onAction={onAction} />
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueEmptyState() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="bg-gradient-to-br from-brand-accent/[0.04] to-surface p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-accent/10 text-brand-accent">
          <Inbox className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-ink">
          No one is on the waitlist yet
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          When a customer&apos;s preferred date is full on your public booking
          page, they can join the waitlist with one click. The engine watches
          for openings and offers the slot to the best-matched waiting
          customer.
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <FlowStep
            n={1}
            icon={Users}
            text="Customer joins from public booking page"
          />
          <FlowStep
            n={2}
            icon={CalendarClock}
            text="An opening appears (cancel or reschedule)"
          />
          <FlowStep
            n={3}
            icon={MailCheck}
            text="Engine offers the slot with a 15-min hold"
          />
        </div>
      </div>
    </Card>
  );
}

function FlowStep({
  n,
  icon: Icon,
  text,
}: {
  n: number;
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 text-left">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
          Step {n}
        </div>
        <div className="text-xs text-ink-muted">{text}</div>
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  onAction,
}: {
  entry: Entry;
  onAction: (id: string, kind: "cancel" | "expire_hold") => void;
}) {
  const status = STATUS_META[entry.status] ?? STATUS_META.expired;
  const isOnHold = entry.status === "notified";
  return (
    <li>
      <Card className="overflow-hidden p-0 transition-shadow duration-150 hover:shadow-md">
        <div className="flex items-start gap-3 p-4">
          <CustomerAvatar name={entry.customerName} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">
                {entry.customerName || "(no name)"}
              </span>
              <a
                href={`mailto:${entry.customerEmail}`}
                className="text-xs text-ink-muted hover:text-ink hover:underline"
              >
                {entry.customerEmail}
              </a>
              <StatusPill status={entry.status} />
              {entry.priority > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                  title="Higher priority — moves ahead of zero-priority entries"
                >
                  <TrendingUp className="h-2.5 w-2.5" /> priority {entry.priority}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
              <span className="font-medium text-ink-muted">
                {entry.serviceName ?? entry.serviceId.slice(0, 8)}
              </span>
              {entry.preferredDate && (
                <span>· prefers {formatDate(entry.preferredDate)}</span>
              )}
              {entry.preferredTimeRange !== "any" && (
                <span>· {entry.preferredTimeRange}</span>
              )}
              <span>· joined {timeAgo(entry.createdAt)}</span>
              {entry.customerPhone && <span>· {entry.customerPhone}</span>}
            </div>
            {isOnHold && entry.expiresAt && (
              <HoldCountdown expiresAt={entry.expiresAt} />
            )}
            {entry.status === "claimed" && entry.claimedAt && entry.claimedBookingId && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
                <CheckCircle2 className="h-3 w-3" />
                Claimed {timeAgo(entry.claimedAt)} → booking{" "}
                <span className="font-mono">{entry.claimedBookingId.slice(0, 8)}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex gap-2">
              {entry.status === "notified" && (
                <button
                  onClick={() => onAction(entry.id, "expire_hold")}
                  className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink"
                  aria-label="Expire hold"
                >
                  Expire hold
                </button>
              )}
              {(entry.status === "waiting" || entry.status === "notified") && (
                <button
                  onClick={() => onAction(entry.id, "cancel")}
                  className="rounded-md border border-rose-200 bg-surface px-2.5 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
                  aria-label="Remove from waitlist"
                >
                  Remove
                </button>
              )}
            </div>
            <span className="text-[10px] text-ink-subtle" title={status.label}>
              <status.icon className="inline h-3 w-3" /> {status.label}
            </span>
          </div>
        </div>
      </Card>
    </li>
  );
}

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.expired;
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
        meta.classes
      }
    >
      <span className={"h-1.5 w-1.5 rounded-full " + meta.dot} />
      {meta.label}
    </span>
  );
}

function CustomerAvatar({ name }: { name: string }) {
  const initials =
    (name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  const palette = [
    "bg-sky-100 text-sky-700",
    "bg-violet-100 text-violet-700",
    "bg-emerald-100 text-emerald-700",
    "bg-amber-100 text-amber-700",
    "bg-rose-100 text-rose-700",
  ];
  let h = 0;
  for (let i = 0; i < (name || "?").length; i++) h = (h * 31 + (name || "?").charCodeAt(i)) | 0;
  const swatch = palette[Math.abs(h) % palette.length];
  return (
    <div
      className={"grid h-10 w-10 shrink-0 place-items-center rounded-full text-[12px] font-semibold " + swatch}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

function HoldCountdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = React.useState(() =>
    Math.max(0, new Date(expiresAt).getTime() - Date.now()),
  );
  React.useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  const totalSec = Math.floor(remaining / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const expired = remaining <= 0;
  return (
    <div
      className={
        "mt-2 inline-flex items-center gap-2 rounded-md px-2 py-1 text-[11px] font-medium " +
        (expired
          ? "bg-slate-100 text-slate-600"
          : remaining < 60_000
            ? "bg-rose-50 text-rose-700"
            : "bg-amber-50 text-amber-800")
      }
    >
      <Hourglass className={"h-3 w-3 " + (expired ? "" : "animate-pulse")} />
      {expired ? (
        <span>Hold expired — awaiting cron sweep</span>
      ) : (
        <>
          <span>Hold expires in</span>
          <span className="tabular-nums">
            {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
          </span>
        </>
      )}
    </div>
  );
}

// ─── Activity timeline (Phase 7) ─────────────────────────────────────

function ActivitySection({
  notifications,
  loading,
}: {
  notifications: Notif[];
  loading: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Activity}
        title="Recent activity"
        subtitle="Notification offers, claims, and expirations from the auto-fill engine."
      />
      {loading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : notifications.length === 0 ? (
        <ActivityEmptyState />
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-border/60">
            {notifications.map((n) => (
              <ActivityRow key={n.id} notif={n} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function ActivityEmptyState() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="p-8 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-ink-subtle">
          <Activity className="h-6 w-6" />
        </div>
        <h3 className="mt-3 text-sm font-semibold text-ink">No auto-fill activity yet</h3>
        <p className="mx-auto mt-1.5 max-w-md text-xs text-ink-muted">
          Once a customer joins the waitlist and a slot opens (via cancel
          or reschedule), you&apos;ll see the offer, claim, and expiration
          events here as they happen.
        </p>
      </div>
    </Card>
  );
}

function ActivityRow({ notif }: { notif: Notif }) {
  const meta = STATUS_META[notif.status] ?? STATUS_META.expired;
  const Icon = meta.icon;
  return (
    <li className="flex items-start gap-3 p-4 text-sm">
      <div className={"mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg " + meta.classes}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-ink">
          <span className="font-medium">{notificationLabel(notif.notificationType)}</span>
          <StatusPill status={notif.status} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
          {notif.slotStartAt && (
            <span>
              Slot {new Date(notif.slotStartAt).toLocaleString()}
              {notif.slotEndAt && ` – ${new Date(notif.slotEndAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            </span>
          )}
          <span>· Expired at {new Date(notif.expiresAt).toLocaleString()}</span>
          {notif.respondedAt && (
            <span>· Responded {timeAgo(notif.respondedAt)}</span>
          )}
        </div>
      </div>
      <div className="text-right text-[11px] text-ink-subtle">{timeAgo(notif.createdAt)}</div>
    </li>
  );
}

function notificationLabel(t: string): string {
  switch (t) {
    case "slot_available": return "Slot offered";
    case "reservation_expiring": return "Reservation expiring";
    case "reservation_claimed": return "Reservation claimed";
    default: return t;
  }
}

// ─── Section header primitive ────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3 px-1">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Metrics derivation ──────────────────────────────────────────────

type Metrics = {
  counts: {
    all: number;
    waiting: number;
    notified: number;
    claimed: number;
    expired: number;
    cancelled: number;
  };
  expiredHoldsCount: number;
  avgClaimMinutes: number | null;
};

function deriveMetrics(data: ApiData | null): Metrics {
  if (!data) {
    return {
      counts: { all: 0, waiting: 0, notified: 0, claimed: 0, expired: 0, cancelled: 0 },
      expiredHoldsCount: 0,
      avgClaimMinutes: null,
    };
  }
  const counts = {
    all: data.entries.length,
    waiting: data.entries.filter((e) => e.status === "waiting").length,
    notified: data.entries.filter((e) => e.status === "notified").length,
    claimed: data.entries.filter((e) => e.status === "claimed").length,
    expired: data.entries.filter((e) => e.status === "expired").length,
    cancelled: data.entries.filter((e) => e.status === "cancelled").length,
  };

  // Expired holds: notifications whose status flipped to "expired" by
  // the cron worker. Real data — not derived from waitlist status.
  const expiredHoldsCount = data.notifications.filter((n) => n.status === "expired").length;

  // Average claim time in minutes: claimed_at - created_at for entries
  // that successfully claimed. Null when no claims yet (honest empty).
  const claimedWithTimes = data.entries.filter(
    (e) => e.status === "claimed" && e.claimedAt,
  );
  let avgClaimMinutes: number | null = null;
  if (claimedWithTimes.length > 0) {
    const totalMs = claimedWithTimes.reduce((sum, e) => {
      const created = new Date(e.createdAt).getTime();
      const claimed = new Date(e.claimedAt!).getTime();
      return sum + Math.max(0, claimed - created);
    }, 0);
    avgClaimMinutes = Math.round(totalMs / claimedWithTimes.length / 60_000);
  }

  return { counts, expiredHoldsCount, avgClaimMinutes };
}

// ─── Format helpers ──────────────────────────────────────────────────

function formatDate(yyyymmdd: string): string {
  try {
    const d = new Date(yyyymmdd + "T12:00:00Z");
    if (Number.isNaN(d.getTime())) return yyyymmdd;
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return yyyymmdd;
  }
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
