"use client";

/**
 * CustomersClient — Customer Relationship Intelligence Command Center
 * (Phase 6A).
 *
 * STRICTLY PRESERVED:
 *   - Default export name (CustomersClient)
 *   - Props { userTimezone, canManage }
 *   - Row + CustomerDetail type shapes
 *   - All API calls:
 *       GET    /api/customers
 *       POST   /api/customers          (already exists — wired to UI)
 *       GET    /api/customers/[id]
 *       PATCH  /api/customers/[id]     (notes + tags)
 *
 * What changed (UI-only):
 *   - Premium Hero with brand-gradient + 3 actions (Add customer
 *     primary, Import, Invite secondary).
 *   - 4 KPI cards: Total · Active 30d · Repeat-rate % · VIP.
 *   - Premium SearchBar + filter pill bar (All · Active · VIP ·
 *     Archived · Recent).
 *   - Row cards replace the table — avatar + name + email + meta
 *     chips + status pill + hover halo with brand glow.
 *   - Premium empty state with brand-gradient CTA.
 *   - Apple-quality NewCustomerDrawer for manual creation.
 *   - Existing CustomerDrawer kept; polished hero treatment.
 *
 * Easing language: cubic-bezier(0.16, 1, 0.3, 1) end-to-end.
 */
import * as React from "react";
import { formatInTimeZone } from "date-fns-tz";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Plus,
  Search,
  Upload,
  Mail,
  Users,
  Crown,
  TrendingUp,
  Sparkles,
  X,
  ArrowRight,
  CalendarClock,
  Filter as FilterIcon,
} from "lucide-react";

import { Avatar, Badge, Button, Drawer, Skeleton, toast } from "@/components/ui/primitives";
import { PremiumCard, InsightCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import ActivityTimeline from "@/components/dashboard/ActivityTimeline";
import { STATUS_BADGE, STATUS_LABEL, type Status } from "@/lib/status-colors";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

type Row = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  tags: string[];
  totalBookings: number;
  cancelled: number;
  completed: number;
  lastAppointmentAt: string | null;
};

type CustomerDetail = {
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    notes: string | null;
    status: string;
    tags: string[];
  };
  history: Array<{
    id: string;
    startAt: string;
    endAt: string;
    status: Status;
    serviceName: string;
    staffName: string;
  }>;
};

type Filter = "all" | "active" | "vip" | "prospect" | "archived" | "recent";
type CustomerStatus = "active" | "vip" | "prospect" | "archived";

const FILTERS: Filter[] = ["all", "active", "vip", "prospect", "archived", "recent"];

const FILTER_LABEL: Record<Filter, string> = {
  all:      "All",
  active:   "Active",
  vip:      "VIP",
  prospect: "Prospect",
  archived: "Archived",
  recent:   "Recent · 30d",
};

const DRAWER_TABS = ["overview", "appointments", "notes", "activity"] as const;
type DrawerTab = (typeof DRAWER_TABS)[number];

// ─── Main component ────────────────────────────────────────────────

export default function CustomersClient({ userTimezone, canManage }: { userTimezone: string; canManage: boolean }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [openNew, setOpenNew] = React.useState(false);
  const [comingSoon, setComingSoon] = React.useState<null | "import" | "invite">(null);

  const reload = React.useCallback(() => {
    const url = new URL("/api/customers", window.location.origin);
    if (search) url.searchParams.set("q", search);
    fetch(url)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [search]);

  React.useEffect(() => {
    let cancelled = false;
    const url = new URL("/api/customers", window.location.origin);
    if (search) url.searchParams.set("q", search);
    fetch(url)
      .then((r) => r.json())
      .then((data) => !cancelled && setRows(Array.isArray(data) ? data : []))
      .catch(() => !cancelled && setRows([]));
    return () => { cancelled = true; };
  }, [search]);

  const stats = React.useMemo(() => computeStats(rows ?? []), [rows]);
  const filtered = React.useMemo(() => applyFilter(rows ?? [], filter), [rows, filter]);
  const counts = React.useMemo(() => computeCounts(rows ?? []), [rows]);

  return (
    <div className="relative mt-6 space-y-5">
      {/* Ambient background depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-32 -z-10 h-80 w-80 rounded-full bg-brand-accent/[0.05] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-96 -z-10 h-72 w-72 rounded-full bg-brand-accent/[0.04] blur-3xl"
      />

      {/* ── Hero ──────────────────────────────────────────────── */}
      <FadeIn>
        <Hero
          canManage={canManage}
          onAdd={() => setOpenNew(true)}
          onImport={() => setComingSoon("import")}
          onInvite={() => setComingSoon("invite")}
        />
      </FadeIn>

      {/* ── CRM Intelligence Strip ──────────────────────────── */}
      <FadeIn delay={1}>
        <CRMIntelligenceStrip signal={deriveCRMSignal(rows ?? [])} />
      </FadeIn>

      {/* ── KPI cluster ──────────────────────────────────────── */}
      <FadeIn delay={2}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Total customers"
            value={rows === null ? "—" : String(stats.total)}
            icon={Users}
            tone="brand"
          />
          <MetricCard
            label="Active · 30d"
            value={rows === null ? "—" : String(stats.active30)}
            icon={TrendingUp}
            tone="positive"
          />
          <MetricCard
            label="Repeat rate"
            value={rows === null ? "—" : `${stats.repeatRatePct}%`}
            icon={CalendarClock}
            tone="brand"
          />
          <MetricCard
            label="VIP"
            value={rows === null ? "—" : String(stats.vip)}
            icon={Crown}
            tone="warning"
          />
        </div>
      </FadeIn>

      {/* ── Search + filters ─────────────────────────────────── */}
      <FadeIn delay={3}>
        <SearchAndFilters
          search={search}
          onSearch={setSearch}
          filter={filter}
          onFilter={setFilter}
          counts={counts}
        />
      </FadeIn>

      {/* ── Body ──────────────────────────────────────────────── */}
      {rows === null ? (
        <LoadingSkeleton />
      ) : rows.length === 0 ? (
        <FadeIn delay={4}>
          <PremiumEmptyState
            canManage={canManage}
            onAdd={() => setOpenNew(true)}
            onImport={() => setComingSoon("import")}
          />
        </FadeIn>
      ) : filtered.length === 0 ? (
        <FadeIn delay={4}>
          <FilteredEmptyState filter={filter} search={search} />
        </FadeIn>
      ) : (
        <FadeIn delay={4}>
          <ul className="space-y-2">
            {filtered.map((r, idx) => (
              <FadeIn key={r.id} delay={idx} as="div">
                <CustomerRowCard
                  row={r}
                  userTimezone={userTimezone}
                  onOpen={() => setOpenId(r.id)}
                />
              </FadeIn>
            ))}
          </ul>
        </FadeIn>
      )}

      {/* Existing detail drawer (polished). */}
      <CustomerDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        userTimezone={userTimezone}
        canManage={canManage}
      />

      {/* New manual-create drawer. */}
      <NewCustomerDrawer
        open={openNew}
        onClose={() => setOpenNew(false)}
        onCreated={() => { setOpenNew(false); reload(); }}
      />

      <ComingSoonModal
        kind={comingSoon}
        onClose={() => setComingSoon(null)}
      />
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function Hero({
  canManage,
  onAdd,
  onImport,
  onInvite,
}: {
  canManage: boolean;
  onAdd: () => void;
  onImport: () => void;
  onInvite: () => void;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/40 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            <Users className="h-3 w-3" strokeWidth={2} />
            Customer relationship intelligence
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Customers
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Every relationship across your workspace — bookings, history, lifetime context.
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5">
            <SecondaryAction icon={Upload} label="Import" onClick={onImport} />
            <SecondaryAction icon={Mail} label="Invite" onClick={onInvite} />
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
              Add customer
            </button>
          </div>
        )}
      </div>
    </PremiumCard>
  );
}

function SecondaryAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {label}
    </button>
  );
}

// ─── Coming-soon modal ─────────────────────────────────────────────

function ComingSoonModal({
  kind,
  onClose,
}: {
  kind: null | "import" | "invite";
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && kind) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, onClose]);

  const content = kind === "import"
    ? {
        eyebrow: "CSV import",
        title: "Bulk import is coming soon",
        body: "Drop a CSV of customers (name, email, phone, tags) and we'll deduplicate against your existing workspace. This is in active development.",
        icon: Upload,
      }
    : {
        eyebrow: "Customer invites",
        title: "Email invites are coming soon",
        body: "Send branded invite emails so customers can complete their profile and book themselves in. We're polishing the SES integration for this.",
        icon: Mail,
      };
  const Icon = content?.icon ?? Upload;

  return (
    <AnimatePresence>
      {kind && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Coming soon"
            className="fixed left-1/2 top-1/2 z-50 w-[92%] max-w-md -translate-x-1/2 -translate-y-1/2"
            initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
              <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle/45 via-surface to-surface shadow-2xl">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
                />
                <div className="relative flex items-start gap-3 p-5">
                  <div className="zm-pulse-glow inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
                    <Icon className="h-5 w-5" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                      {content.eyebrow}
                    </div>
                    <h3 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
                      {content.title}
                    </h3>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                      {content.body}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
                  >
                    <X className="h-4 w-4" strokeWidth={2} />
                  </button>
                </div>
                <div className="relative flex justify-end gap-2 border-t border-border/70 bg-surface-subtle/40 px-5 py-3.5">
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-brand-accent/30 to-transparent"
                  />
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
                  >
                    Got it
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ─── Status selector — Standard / VIP / Prospect ──────────────────

function StatusSelector({
  value,
  onChange,
  layoutGroupId,
}: {
  value: CustomerStatus;
  onChange: (next: CustomerStatus) => void;
  layoutGroupId: string;
}) {
  const reduced = useReducedMotion();
  const options: Array<{ value: CustomerStatus; label: string; dot: string; subtleBg: string; activeFrom: string; activeTo: string }> = [
    { value: "active",   label: "Standard", dot: "bg-brand-accent",  subtleBg: "bg-brand-subtle/60", activeFrom: "from-brand-accent",  activeTo: "to-brand-hover"  },
    { value: "vip",      label: "VIP",      dot: "bg-amber-500",     subtleBg: "bg-amber-50",        activeFrom: "from-amber-400",     activeTo: "to-amber-500"    },
    { value: "prospect", label: "Prospect", dot: "bg-slate-400",     subtleBg: "bg-slate-100",       activeFrom: "from-slate-500",     activeTo: "to-slate-600"    },
  ];
  return (
    <div className="relative inline-flex rounded-lg border border-border bg-surface-subtle p-0.5 shadow-soft">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              "relative z-10 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.97]",
              active ? "text-white" : "text-ink-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId={`status-indicator-${layoutGroupId}`}
                className={cn(
                  "absolute inset-0 rounded-md bg-gradient-to-br shadow-[0_4px_12px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.25)]",
                  opt.activeFrom,
                  opt.activeTo,
                )}
                aria-hidden
                transition={reduced ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
            <span aria-hidden className={cn("relative inline-block h-1.5 w-1.5 rounded-full", active ? "bg-white/85" : opt.dot)} />
            <span className="relative">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── CRM Intelligence Strip ─────────────────────────────────────────

function CRMIntelligenceStrip({ signal }: { signal: string }) {
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
        {/* Diagonal light sweep — 15s ambient pass */}
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />

        <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Relationship intelligence
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-ink">
              {signal}
            </div>
          </div>

          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-2 py-0.5 text-[10px] font-medium text-ink-muted backdrop-blur-sm sm:inline-flex">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Live
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Rule-derived CRM signal. Always returns a calm string so the strip
 * never disappears — matches the Notifications AI strip behavior.
 */
function deriveCRMSignal(rows: Row[]): string {
  if (rows.length === 0) {
    return "Build your customer network — operational signals will surface here as your relationships grow.";
  }
  const now = Date.now();
  const thirty = 30 * 86_400_000;
  const sixty = 60 * 86_400_000;
  const total = rows.length;
  const vip = rows.filter((r) => r.status === "vip");
  const vipDormant = vip.filter(
    (r) => !r.lastAppointmentAt || now - new Date(r.lastAppointmentAt).getTime() > sixty,
  ).length;
  const active30 = rows.filter(
    (r) => r.lastAppointmentAt && now - new Date(r.lastAppointmentAt).getTime() <= thirty,
  ).length;
  const repeat = rows.filter((r) => r.totalBookings >= 2).length;
  const bookedAtAll = rows.filter((r) => r.totalBookings >= 1).length;
  const repeatRatePct = bookedAtAll > 0 ? Math.round((repeat / bookedAtAll) * 100) : 0;
  const neverBooked = rows.filter((r) => r.totalBookings === 0).length;

  if (vipDormant > 0) {
    return `${vipDormant} VIP ${vipDormant === 1 ? "customer hasn't" : "customers haven't"} booked in 60 days. A good window for proactive outreach.`;
  }
  if (repeatRatePct >= 50 && total >= 5) {
    return `Repeat booking rate is ${repeatRatePct}%. Customer engagement remains healthy.`;
  }
  if (active30 / Math.max(1, total) >= 0.4 && total >= 5) {
    return `${active30} customers active in the last 30 days. Your retention is healthy.`;
  }
  if (neverBooked >= 3) {
    return `${neverBooked} customers haven't booked yet. A calm window for nurture outreach.`;
  }
  if (active30 > 0) {
    return `${active30} ${active30 === 1 ? "customer" : "customers"} active recently. Steady operational rhythm.`;
  }
  return "Customer relationships are being tracked. Insights will surface as activity grows.";
}

// ─── Search + filters ──────────────────────────────────────────────

function SearchAndFilters({
  search, onSearch, filter, onFilter, counts,
}: {
  search: string;
  onSearch: (s: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  counts: Record<Filter, number>;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface px-2.5 py-2 shadow-soft">
      {/* Subtle inner top highlight — one tactile vocabulary across
          every premium surface */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-ink-subtle" strokeWidth={1.75} aria-hidden />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-xl border border-border bg-surface-subtle py-1.5 pl-9 pr-3 text-[13px] outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-border-strong focus:border-brand-accent focus:bg-surface focus:ring-4 focus:ring-brand-accent/15"
          />
        </div>

      <div className="relative inline-flex flex-wrap items-center gap-0.5 rounded-xl border border-border bg-surface-subtle p-0.5 shadow-soft">
        {FILTERS.map((f) => {
          const active = filter === f;
          const n = counts[f];
          return (
            <button
              key={f}
              onClick={() => onFilter(f)}
              aria-pressed={active}
              className={cn(
                "relative z-10 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.97]",
                active ? "text-white" : "text-ink-muted hover:text-ink",
              )}
            >
              {active && (
                <motion.span
                  layoutId="customers-filter-indicator"
                  className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(53,157,243,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]"
                  aria-hidden
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              <span className="relative">{FILTER_LABEL[f]}</span>
              {n > 0 && (
                <span
                  className={cn(
                    "relative inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                    active ? "bg-white/25 text-white" : "bg-surface-inset text-ink-subtle",
                  )}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}

// ─── Customer row card ─────────────────────────────────────────────

function CustomerRowCard({
  row,
  userTimezone,
  onOpen,
}: {
  row: Row;
  userTimezone: string;
  onOpen: () => void;
}) {
  const lastSeen = row.lastAppointmentAt
    ? formatInTimeZone(row.lastAppointmentAt, userTimezone, "MMM d, yyyy")
    : "Never booked";
  const isVip = row.status === "vip";
  const isArchived = row.status === "archived";
  const isProspect = row.status === "prospect";

  // Rule-derived lifecycle signal — UI scaffolding for future
  // engagement scoring without any backend dependency.
  const lifecycleSignal = (() => {
    if (row.totalBookings === 0) return { label: "New", tone: "brand" as const };
    if (!row.lastAppointmentAt) return null;
    const ageMs = Date.now() - new Date(row.lastAppointmentAt).getTime();
    if (ageMs <= 7 * 86_400_000) return { label: "Recent", tone: "emerald" as const };
    if (ageMs > 60 * 86_400_000) return { label: "Dormant", tone: "amber" as const };
    return null;
  })();
  const isEngaged = row.completed >= 3;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn(
          "group relative cursor-pointer overflow-hidden rounded-2xl border bg-surface px-3 py-2.5 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:px-4 sm:py-3",
          "hover:-translate-y-0.5 hover:scale-[1.002] hover:border-border-strong hover:shadow-lift",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
          isArchived ? "opacity-70 border-border" : "border-border",
        )}
      >
        {/* Hover halo */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
          style={{
            boxShadow:
              "0 0 0 1px rgba(53,157,243,0.18), 0 10px 28px rgba(53,157,243,0.10), 0 24px 52px -8px rgba(53,157,243,0.07)",
          }}
        />
        {/* Top inner highlight */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
        />
        {/* Status-tinted left rail */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 w-1 rounded-l-2xl",
            isVip ? "bg-amber-400" : isArchived ? "bg-slate-300" : "bg-brand-accent",
          )}
        />

        <div className="relative flex items-center gap-3 pl-2">
          <Avatar name={row.name} size="sm" className="!h-9 !w-9 !text-[11px]" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className={cn(
                "truncate text-[13px] font-semibold tracking-tight",
                isArchived ? "text-ink-muted" : "text-ink",
              )}>
                {row.name}
              </div>
              {isVip && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200/40">
                  <Crown className="h-2.5 w-2.5" strokeWidth={2} />
                  VIP
                </span>
              )}
              {isProspect && (
                <LifecycleChip label="Prospect" tone="brand" />
              )}
              {lifecycleSignal && (
                <LifecycleChip label={lifecycleSignal.label} tone={lifecycleSignal.tone} />
              )}
              {isEngaged && !isArchived && (
                <LifecycleChip label="Engaged" tone="emerald" />
              )}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-ink-subtle">{row.email}</div>

            {/* Meta chips */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <MetaChip>
                <CalendarClock className="h-2.5 w-2.5" strokeWidth={1.75} />
                {row.totalBookings} {row.totalBookings === 1 ? "booking" : "bookings"}
              </MetaChip>
              {row.completed > 0 && (
                <MetaChip tone="emerald">
                  {row.completed} completed
                </MetaChip>
              )}
              <MetaChip tone="subtle">
                Last · {lastSeen}
              </MetaChip>
              {row.tags?.slice(0, 2).map((t) => (
                <MetaChip key={t} tone="violet">{t}</MetaChip>
              ))}
              {row.tags && row.tags.length > 2 && (
                <span className="text-[9px] font-medium text-ink-subtle">+{row.tags.length - 2}</span>
              )}
            </div>
          </div>

          <div className="hidden items-center gap-2 sm:flex">
            <ArrowRight className="h-3.5 w-3.5 text-ink-subtle transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
          </div>
        </div>
      </div>
    </li>
  );
}

function LifecycleChip({
  label,
  tone,
}: {
  label: string;
  tone: "brand" | "emerald" | "amber";
}) {
  const cls =
    tone === "brand"   ? "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15"
    : tone === "emerald" ? "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40"
    : "bg-amber-50/80 text-amber-700 ring-1 ring-amber-200/40";
  const dot =
    tone === "brand"   ? "bg-brand-accent"
    : tone === "emerald" ? "bg-emerald-500"
    : "bg-amber-500";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", cls)}>
      <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", dot)} />
      {label}
    </span>
  );
}

function MetaChip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "subtle" | "emerald" | "violet";
}) {
  const cls =
    tone === "emerald" ? "bg-emerald-50/70 text-emerald-700 ring-1 ring-emerald-200/30"
    : tone === "violet" ? "bg-violet-50/80 text-violet-700 ring-1 ring-violet-200/30"
    : tone === "subtle" ? "bg-surface-inset/80 text-ink-subtle"
    : "bg-surface-inset text-ink-muted";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", cls)}>
      {children}
    </span>
  );
}

// ─── Empty states ──────────────────────────────────────────────────

function PremiumEmptyState({
  canManage,
  onAdd,
  onImport,
}: {
  canManage: boolean;
  onAdd: () => void;
  onImport: () => void;
}) {
  return (
    <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/35 via-surface to-brand-subtle/20">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/40 to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 bottom-0 h-56 w-56 rounded-full bg-brand-accent/8 blur-3xl"
      />
      {/* Subtle relationship-network dot grid pattern — implies an
          intelligent CRM lattice without obvious illustrations. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(53,157,243,0.10) 1px, transparent 0)",
          backgroundSize: "22px 22px",
          maskImage:
            "radial-gradient(ellipse at center, rgba(0,0,0,1) 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, rgba(0,0,0,1) 30%, transparent 75%)",
        }}
      />

      <div className="relative flex flex-col items-center justify-center px-4 py-12 text-center">
        <div className="zm-pulse-glow mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Users className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          Get started
        </div>
        <h3 className="mt-1 text-[18px] font-semibold tracking-tight text-ink">
          Build your customer network
        </h3>
        <p className="mt-1 max-w-[440px] text-[12px] leading-relaxed text-ink-muted">
          Customers are added automatically when someone books — or manually for proactive
          relationship management before the first appointment.
        </p>
        {canManage && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
              Add customer
            </button>
            <button
              type="button"
              onClick={onImport}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
            >
              <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
              Import CSV
            </button>
          </div>
        )}
      </div>
    </PremiumCard>
  );
}

function FilteredEmptyState({ filter, search }: { filter: Filter; search: string }) {
  let title = "No customers match";
  let body = "Try a different filter or clear your search.";
  if (search) {
    title = `No matches for "${search}"`;
    body = "Try a different name or email.";
  } else if (filter === "vip") {
    title = "No VIP customers yet";
    body = "Mark a customer as VIP from their profile to see them here.";
  } else if (filter === "archived") {
    title = "Nothing archived";
    body = "Archived customers will appear here.";
  } else if (filter === "recent") {
    title = "No activity in the last 30 days";
    body = "Customers with recent bookings will surface here.";
  } else if (filter === "active") {
    title = "No active customers";
    body = "Customers with status \"active\" will appear here.";
  }
  return (
    <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/20 via-surface to-surface">
      <div className="flex items-start gap-3 px-2 py-4">
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <FilterIcon className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
    </PremiumCard>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="relative h-16 overflow-hidden rounded-2xl border border-border bg-surface-subtle zm-shimmer" />
      ))}
    </div>
  );
}

// ─── New customer drawer ──────────────────────────────────────────

function NewCustomerDrawer({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [status, setStatus] = React.useState<CustomerStatus>("active");
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagDraft, setTagDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (open) { setName(""); setEmail(""); setPhone(""); setNotes(""); setStatus("active"); setTags([]); setTagDraft(""); }
  }, [open]);

  function addTag() {
    const t = tagDraft.trim().toLowerCase();
    if (!t || tags.includes(t)) { setTagDraft(""); return; }
    setTags([...tags, t]);
    setTagDraft("");
  }
  function removeTag(t: string) {
    setTags(tags.filter((x) => x !== t));
  }

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    if (!email.trim()) { toast("Email is required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
          notes: notes.trim() || null,
          status,
          tags,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? "Failed");
      }
      toast("Customer added", "success");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Add customer"
            className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-md flex-col bg-surface shadow-2xl"
            initial={reduced ? { x: 0 } : { x: "100%" }}
            animate={{ x: 0 }}
            exit={reduced ? { x: 0 } : { x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-brand-subtle/55 via-surface to-surface px-5 pt-5 pb-4">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
              />
              <div className="relative flex items-start justify-between">
                <div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-accent">
                    <Sparkles className="h-3 w-3" strokeWidth={2} />
                    Add customer
                  </div>
                  <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-ink">
                    Add a customer to your workspace
                  </h2>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    Create a relationship before the first booking — VIPs, prospects, or returning clients.
                  </p>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="flex-1 space-y-3.5 overflow-y-auto px-5 py-5 text-sm">
              <FadeIn delay={1}>
                <DrawerField label="Full name" required>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Maria González"
                    className={INPUT_CLS}
                    autoFocus
                  />
                </DrawerField>
              </FadeIn>
              <FadeIn delay={2}>
                <DrawerField label="Email" required>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="maria@example.com"
                    className={INPUT_CLS}
                  />
                </DrawerField>
              </FadeIn>
              <FadeIn delay={3}>
                <DrawerField label="Phone (optional)">
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 (555) 123-4567"
                    className={INPUT_CLS}
                  />
                </DrawerField>
              </FadeIn>
              <FadeIn delay={4}>
                <DrawerField label="Relationship tier">
                  <div className="flex">
                    <StatusSelector
                      layoutGroupId="new-customer"
                      value={status}
                      onChange={setStatus}
                    />
                  </div>
                </DrawerField>
              </FadeIn>
              <FadeIn delay={5}>
                <DrawerField label="Tags (optional)">
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {tags.length === 0 && (
                        <span className="text-[11px] text-ink-subtle">No tags yet — add labels like &quot;enterprise&quot;, &quot;referral&quot;, &quot;priority&quot;.</span>
                      )}
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 rounded-full bg-violet-50/80 px-2 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200/40"
                        >
                          {t}
                          <button
                            type="button"
                            onClick={() => removeTag(t)}
                            aria-label={`Remove tag ${t}`}
                            className="text-violet-500 hover:text-red-600"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); addTag(); }
                        }}
                        placeholder="Add a tag…"
                        className={cn(INPUT_CLS, "flex-1")}
                        maxLength={40}
                      />
                      <button
                        type="button"
                        onClick={addTag}
                        disabled={!tagDraft.trim()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-surface"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </DrawerField>
              </FadeIn>

              <FadeIn delay={6}>
                <DrawerField label="Internal notes (optional)">
                  <textarea
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Anything that helps your team remember the context."
                    className={cn(INPUT_CLS, "resize-none")}
                  />
                </DrawerField>
              </FadeIn>
            </div>

            {/* Sticky footer with luxury top divider glow */}
            <div className="relative flex items-center justify-end gap-2 border-t border-border/70 bg-surface-subtle/40 px-5 py-3.5">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-brand-accent/30 to-transparent"
              />
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !name.trim() || !email.trim()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Adding…" : (
                  <>
                    Add customer
                    <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </>
                )}
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

const INPUT_CLS = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-border-strong focus:border-brand-accent focus:ring-4 focus:ring-brand-accent/15";

function DrawerField({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        {label}{required && <span className="text-brand-accent"> *</span>}
      </span>
      {children}
    </label>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function computeStats(rows: Row[]): {
  total: number;
  active30: number;
  repeatRatePct: number;
  vip: number;
} {
  const now = Date.now();
  const thirty = 30 * 86_400_000;
  const total = rows.length;
  const active30 = rows.filter(
    (r) => r.lastAppointmentAt && now - new Date(r.lastAppointmentAt).getTime() <= thirty,
  ).length;
  const repeat = rows.filter((r) => r.totalBookings >= 2).length;
  const bookedAtAll = rows.filter((r) => r.totalBookings >= 1).length;
  const repeatRatePct = bookedAtAll > 0 ? Math.round((repeat / bookedAtAll) * 100) : 0;
  const vip = rows.filter((r) => r.status === "vip").length;
  return { total, active30, repeatRatePct, vip };
}

function applyFilter(rows: Row[], filter: Filter): Row[] {
  switch (filter) {
    case "all":      return rows;
    case "active":   return rows.filter((r) => r.status === "active");
    case "vip":      return rows.filter((r) => r.status === "vip");
    case "prospect": return rows.filter((r) => r.status === "prospect");
    case "archived": return rows.filter((r) => r.status === "archived");
    case "recent": {
      const cutoff = Date.now() - 30 * 86_400_000;
      return rows.filter((r) => r.lastAppointmentAt && new Date(r.lastAppointmentAt).getTime() >= cutoff);
    }
  }
}

function computeCounts(rows: Row[]): Record<Filter, number> {
  const cutoff = Date.now() - 30 * 86_400_000;
  return {
    all:      rows.length,
    active:   rows.filter((r) => r.status === "active").length,
    vip:      rows.filter((r) => r.status === "vip").length,
    prospect: rows.filter((r) => r.status === "prospect").length,
    archived: rows.filter((r) => r.status === "archived").length,
    recent:   rows.filter((r) => r.lastAppointmentAt && new Date(r.lastAppointmentAt).getTime() >= cutoff).length,
  };
}

// ─── Existing customer detail drawer (polished hero) ──────────────

function CustomerDrawer({
  id, onClose, userTimezone, canManage,
}: {
  id: string | null;
  onClose: () => void;
  userTimezone: string;
  canManage: boolean;
}) {
  const [data, setData] = React.useState<CustomerDetail | null>(null);
  const [tab, setTab] = React.useState<DrawerTab>("overview");
  const [savingNotes, setSavingNotes] = React.useState(false);
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!id) { setData(null); return; }
    setData(null);
    setTab("overview");
    fetch(`/api/customers/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setNotes(d?.customer?.notes ?? "");
      })
      .catch(() => toast("Failed to load customer", "error"));
  }, [id]);

  async function saveNotes() {
    if (!id) return;
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast("Notes saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingNotes(false);
    }
  }

  async function setRelationshipStatus(next: CustomerStatus) {
    if (!id || !data) return;
    const previous = data.customer.status as CustomerStatus;
    // Optimistic update
    setData({ ...data, customer: { ...data.customer, status: next } });
    try {
      const res = await fetch(`/api/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? "Failed");
      }
      toast(`Marked as ${next === "active" ? "Standard" : next.charAt(0).toUpperCase() + next.slice(1)}`, "success");
    } catch (e) {
      // Roll back
      setData({ ...data, customer: { ...data.customer, status: previous } });
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  const open = Boolean(id);

  return (
    <Drawer open={open} onClose={onClose} side="right" size="workspace" ariaLabel="Customer">
      {!data ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-6 h-20 w-full" />
        </div>
      ) : (
        <div className="flex h-full flex-col bg-surface">
          {/* Premium hero */}
          <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-brand-subtle/55 via-surface to-surface px-5 pb-5 pt-5">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
            />
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <Avatar name={data.customer.name} size="lg" />
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                    <span className={cn(
                      "inline-flex h-1.5 w-1.5 rounded-full",
                      data.customer.status === "vip" ? "bg-amber-500" :
                      data.customer.status === "archived" ? "bg-slate-400" :
                      data.customer.status === "prospect" ? "bg-slate-500" : "bg-brand-accent",
                    )} />
                    {data.customer.status === "vip" ? "VIP" :
                     data.customer.status === "archived" ? "Archived" :
                     data.customer.status === "prospect" ? "Prospect" : "Active"}
                  </span>
                  <h2 className="mt-1.5 text-[17px] font-semibold tracking-tight text-ink">{data.customer.name}</h2>
                  <a className="text-[12px] text-brand-accent transition-colors hover:text-brand-hover" href={`mailto:${data.customer.email}`}>
                    {data.customer.email}
                  </a>
                  {data.customer.phone && (
                    <div className="mt-0.5 text-[11px] text-ink-muted">{data.customer.phone}</div>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border px-3">
            {DRAWER_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "border-b-2 px-3 py-2 text-[12px] capitalize transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] " +
                  (t === tab ? "border-brand-accent font-semibold text-brand-accent" : "border-transparent text-ink-muted hover:text-ink")
                }
              >
                {t}
              </button>
            ))}
          </div>

          {/* Tab body */}
          <div className="flex-1 overflow-y-auto p-5">
            {tab === "overview" && (
              <div>
                {canManage && (
                  <div className="mb-5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                      Relationship tier
                    </div>
                    <div className="mt-2">
                      <StatusSelector
                        layoutGroupId={`drawer-${data.customer.id}`}
                        value={(["active", "vip", "prospect", "archived"].includes(data.customer.status)
                          ? data.customer.status
                          : "active") as CustomerStatus}
                        onChange={(next) => setRelationshipStatus(next)}
                      />
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Total bookings" value={String(data.history.length)} />
                  <Stat label="Completed" value={String(data.history.filter((h) => h.status === "completed").length)} />
                  <Stat label="Cancelled" value={String(data.history.filter((h) => h.status === "cancelled").length)} />
                  <Stat label="No-shows" value={String(data.history.filter((h) => h.status === "no_show").length)} />
                </div>
                <div className="mt-6">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Tags</div>
                  <TagEditor
                    customerId={data.customer.id}
                    initial={Array.isArray(data.customer.tags) ? data.customer.tags : []}
                    canManage={canManage}
                  />
                </div>
              </div>
            )}

            {tab === "appointments" && (
              <ul className="divide-y divide-border">
                {data.history.length === 0 && (
                  <li className="py-6 text-center text-[12px] text-ink-subtle">No appointments yet.</li>
                )}
                {data.history.map((h) => (
                  <li key={h.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-ink">{h.serviceName}</div>
                      <div className="text-[11px] text-ink-muted">with {h.staffName}</div>
                      <div className="mt-1 text-[11px] text-ink-subtle">
                        {formatInTimeZone(h.startAt, userTimezone, "MMM d, yyyy · h:mm a")}
                      </div>
                    </div>
                    <Badge className={STATUS_BADGE[h.status]}>{STATUS_LABEL[h.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}

            {tab === "notes" && (
              <div>
                <textarea
                  rows={8}
                  value={notes}
                  disabled={!canManage}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Internal notes — visible to your team only."
                  className="w-full rounded-lg border border-border bg-surface p-3 text-[13px] transition-all duration-[180ms] focus:border-brand-accent focus:ring-4 focus:ring-brand-accent/15 disabled:bg-surface-inset"
                />
                {canManage && (
                  <div className="mt-3 flex justify-end">
                    <Button onClick={saveNotes} disabled={savingNotes}>
                      {savingNotes ? "Saving…" : "Save notes"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {tab === "activity" && (
              <ActivityTimeline limit={50} />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface p-3 shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function TagEditor({
  customerId,
  initial,
  canManage,
}: {
  customerId: string;
  initial: string[];
  canManage: boolean;
}) {
  const [tags, setTags] = React.useState<string[]>(initial);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function persist(next: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/customers/${customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      if (Array.isArray(d.tags)) setTags(d.tags as string[]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to save tags", "error");
      setTags(initial);
    } finally {
      setSaving(false);
    }
  }

  function addTag() {
    const t = draft.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) { setDraft(""); return; }
    const next = [...tags, t];
    setTags(next);
    setDraft("");
    persist(next);
  }

  function removeTag(t: string) {
    const next = tags.filter((x) => x !== t);
    setTags(next);
    persist(next);
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 && (
          <span className="text-[11px] text-ink-subtle">No tags yet.</span>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-violet-50/80 px-2 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200/40"
          >
            {t}
            {canManage && (
              <button
                onClick={() => removeTag(t)}
                aria-label={`Remove tag ${t}`}
                disabled={saving}
                className="text-violet-500 hover:text-red-600 disabled:opacity-50"
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {canManage && (
        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="Add a tag (e.g. vip, new, repeat)…"
            className={cn(INPUT_CLS, "flex-1")}
            maxLength={40}
          />
          <Button onClick={addTag} disabled={saving || !draft.trim()}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
