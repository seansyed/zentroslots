"use client";

/**
 * CalendarView — premium scheduling workspace (Phase 4).
 *
 * STRICT PRESERVATION:
 *   - Public API unchanged: default export, `CalendarBooking` type,
 *     props `{ timezone, bookings, canManage }`.
 *   - All interactions unchanged: drag-to-reschedule POST + optimistic
 *     rollback, drawer open/onChanged, filters, view state, byDay map.
 *   - No API renames, no route changes, no scheduling-engine touches.
 *
 * What this rewrite does (UI-only):
 *   - Premium segmented toolbar with animated active indicator
 *   - Glass mini-calendar with density bars + active-day glow
 *   - Alternating-shaded hour grid + softer separators
 *   - Brand-color current-time line with glow + pulsing dot
 *   - Elite event cards: service-color accent + status pill +
 *     duration meta + hover lift
 *   - Premium month + agenda views (service-color tinted chips)
 *   - SchedulingPulse left-rail card: today load · next meeting ·
 *     focus blocks · weekly utilization (all derived from bookings)
 *   - Empty-state CTAs when no events match filters
 *   - Subtle Framer Motion (FadeIn) on mount, no bounces
 */
import * as React from "react";
import {
  addDays,
  addMinutes,
  addMonths,
  differenceInMinutes,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Clock4,
  Users,
  Activity,
  Sparkles,
  Video,
  CalendarPlus,
  Link2,
  Settings2,
  Flame,
  Coffee,
  ArrowRight,
  Inbox,
  Plus,
  ExternalLink,
  Move3D,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import AppointmentDrawer, { type DrawerBooking } from "@/components/dashboard/AppointmentDrawer";
import Filters, { FilterPills, type FilterDef, type FilterState } from "@/components/dashboard/Filters";
import { PremiumCard, InsightCard, SectionHeader, EmptyState } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { STATUS_EVENT, STATUS_DOT, STATUS_LABEL, type Status } from "@/lib/status-colors";
import { serviceColor as serviceColorFor } from "@/lib/status-colors";
import { toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export type CalendarBooking = {
  id: string;
  startAt: string;
  endAt: string;
  status: Status;
  serviceId: string;
  serviceName: string;
  serviceColor?: string | null;
  staffId: string;
  staffName: string;
  clientName: string;
  clientEmail: string;
  /** Optional video meeting link. When present, the event surfaces a
   *  "Join" quick action on hover. Provided by the calendar page query;
   *  null when the booking has no meeting attached. */
  meetLink?: string | null;
};

const VIEWS = ["day", "week", "month", "agenda"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { day: "Day", week: "Week", month: "Month", agenda: "Agenda" };

const DAY_START_HOUR = 7;   // 7 AM
const DAY_END_HOUR = 21;    // 9 PM
const PX_PER_HOUR = 56;     // visual scale

// ─── Main component ─────────────────────────────────────────────────

export default function CalendarView({
  timezone,
  bookings,
  canManage = true,
}: {
  timezone: string;
  bookings: CalendarBooking[];
  canManage?: boolean;
}) {
  const [view, setView] = React.useState<View>("week");
  const [anchor, setAnchor] = React.useState(() => startOfDay(new Date()));
  const [drawerBooking, setDrawerBooking] = React.useState<DrawerBooking | null>(null);
  const [bookingState, setBookingState] = React.useState<CalendarBooking[]>(bookings);
  React.useEffect(() => setBookingState(bookings), [bookings]);

  // ─── Filters ──────────────────────────────────────────────────────────
  const filterDefs: FilterDef[] = React.useMemo(() => {
    const services = unique(bookings.map((b) => [b.serviceId, b.serviceName] as const));
    const staff = unique(bookings.map((b) => [b.staffId, b.staffName] as const));
    return [
      {
        key: "status",
        label: "Status",
        options: (["confirmed", "pending", "completed", "cancelled", "no_show"] as Status[]).map((s) => ({
          value: s,
          label: STATUS_LABEL[s],
        })),
      },
      { key: "service", label: "Service", options: services.map(([v, l]) => ({ value: v, label: l })) },
      { key: "staff",   label: "Staff",   options: staff.map(([v, l]) => ({ value: v, label: l })) },
    ];
  }, [bookings]);

  const [filters, setFilters] = React.useState<FilterState>({});
  const filtered = React.useMemo(() => {
    return bookingState.filter((b) => {
      if (filters.status?.length && !filters.status.includes(b.status)) return false;
      if (filters.service?.length && !filters.service.includes(b.serviceId)) return false;
      if (filters.staff?.length && !filters.staff.includes(b.staffId)) return false;
      return true;
    });
  }, [bookingState, filters]);

  const byDay = React.useMemo(() => {
    const m = new Map<string, CalendarBooking[]>();
    for (const b of filtered) {
      const k = formatInTimeZone(b.startAt, timezone, "yyyy-MM-dd");
      const list = m.get(k) ?? [];
      list.push(b);
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return m;
  }, [filtered, timezone]);

  function shift(delta: number) {
    if (view === "day" || view === "agenda") setAnchor((d) => addDays(d, delta));
    else if (view === "week") setAnchor((d) => addDays(d, delta * 7));
    else setAnchor((d) => addMonths(d, delta));
  }

  function headerLabel() {
    if (view === "day") return formatInTimeZone(anchor, timezone, "EEEE, MMM d, yyyy");
    if (view === "agenda") return formatInTimeZone(anchor, timezone, "MMM d, yyyy") + " · 7 days";
    if (view === "week") {
      const s = startOfWeek(anchor);
      const e = endOfWeek(anchor);
      return `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`;
    }
    return format(anchor, "MMMM yyyy");
  }

  // ─── Drag-to-reschedule (Day + Week only) ─────────────────────────────
  async function attemptReschedule(bookingId: string, newStartIso: string) {
    const original = bookingState.find((b) => b.id === bookingId);
    if (!original) return;
    const duration = differenceInMinutes(new Date(original.endAt), new Date(original.startAt));
    const newEnd = addMinutes(new Date(newStartIso), duration).toISOString();
    // Optimistic
    setBookingState((cur) =>
      cur.map((b) => (b.id === bookingId ? { ...b, startAt: newStartIso, endAt: newEnd } : b))
    );
    try {
      const res = await fetch(`/api/bookings/${bookingId}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startAt: newStartIso }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Reschedule failed");
      toast("Booking moved", "success");
    } catch (e) {
      // Roll back
      setBookingState((cur) =>
        cur.map((b) => (b.id === bookingId ? { ...b, startAt: original.startAt, endAt: original.endAt } : b))
      );
      toast(e instanceof Error ? e.message : "Reschedule failed", "error");
    }
  }

  function openBooking(b: CalendarBooking) {
    setDrawerBooking({
      id: b.id,
      startAt: b.startAt,
      endAt: b.endAt,
      status: b.status,
      clientName: b.clientName,
      clientEmail: b.clientEmail,
      serviceName: b.serviceName,
      staffName: b.staffName,
    });
  }

  // ── Intelligence panel data (purely derived from bookings prop) ─
  const pulse = React.useMemo(
    () => computePulse(bookingState, timezone),
    [bookingState, timezone]
  );

  const isFilteredEmpty = filtered.length === 0 && bookings.length > 0;

  return (
    <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[280px,1fr]">
      {/* ── Left rail ─────────────────────────────────────── */}
      <aside className="space-y-4">
        <FadeIn delay={0}>
          <SchedulingPulse pulse={pulse} />
        </FadeIn>
        <FadeIn delay={1}>
          <MiniCalendar
            anchor={anchor}
            onPick={(d) => setAnchor(startOfDay(d))}
            byDay={byDay}
          />
        </FadeIn>
        <FadeIn delay={2}>
          <PremiumCard compact interactive={false}>
            <SectionHeader title="Filters" />
            <Filters defs={filterDefs} value={filters} onChange={setFilters} />
            <div className="mt-2">
              <FilterPills defs={filterDefs} value={filters} onChange={setFilters} />
            </div>
          </PremiumCard>
        </FadeIn>
      </aside>

      {/* ── Main calendar ───────────────────────────────── */}
      <FadeIn className="min-w-0">
        <PremiumCard compact interactive={false} className="overflow-hidden p-0">
          <Toolbar
            view={view}
            onView={setView}
            label={headerLabel()}
            onPrev={() => shift(-1)}
            onNext={() => shift(1)}
            onToday={() => setAnchor(startOfDay(new Date()))}
            timezone={timezone}
          />

          {bookings.length === 0 ? (
            <CalendarEmptyState />
          ) : isFilteredEmpty ? (
            <FilteredEmptyState onClear={() => setFilters({})} />
          ) : (
            <ViewCrossfade viewKey={view}>
              {view === "day"    && <DayView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onReschedule={canManage ? attemptReschedule : undefined} />}
              {view === "week"   && <WeekView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onReschedule={canManage ? attemptReschedule : undefined} />}
              {view === "month"  && <MonthView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onJump={(d) => { setAnchor(startOfDay(d)); setView("day"); }} />}
              {view === "agenda" && <AgendaView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} />}
            </ViewCrossfade>
          )}
        </PremiumCard>
      </FadeIn>

      <AppointmentDrawer
        booking={drawerBooking}
        timezone={timezone}
        canManage={canManage}
        onClose={() => setDrawerBooking(null)}
        onChanged={(next) => {
          setDrawerBooking(next);
          setBookingState((cur) => cur.map((b) => (b.id === next.id ? { ...b, status: next.status } : b)));
        }}
      />

      {/* Mobile floating action button — calmly invites a new service /
          booking flow on small screens. Hidden on lg+ where the topbar
          actions and sidebar are already comfortable. */}
      {canManage && (
        <a
          href="/dashboard/services"
          aria-label="New booking"
          className="fixed bottom-6 right-6 z-30 inline-flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_12px_30px_rgba(53,157,243,0.45)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(53,157,243,0.55)] active:scale-95 lg:hidden"
        >
          <Plus className="h-6 w-6" strokeWidth={2.25} />
        </a>
      )}
    </div>
  );
}

// ─── View crossfade wrapper ────────────────────────────────────────

function ViewCrossfade({
  viewKey,
  children,
}: {
  viewKey: View;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={viewKey}
        initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Toolbar — premium segmented control ────────────────────────────

function Toolbar({
  view, onView, label, onPrev, onNext, onToday, timezone,
}: {
  view: View;
  onView: (v: View) => void;
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  timezone: string;
}) {
  return (
    <div className="relative flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-gradient-to-b from-surface to-surface-subtle/30 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          onClick={onPrev}
          aria-label="Previous"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2} />
        </button>
        <button
          onClick={onToday}
          className="rounded-lg border border-border bg-surface px-3 py-1 text-[12px] font-medium text-ink shadow-soft transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
        >
          Today
        </button>
        <button
          onClick={onNext}
          aria-label="Next"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2} />
        </button>
        <div className="ml-2 min-w-0 truncate text-[14px] font-semibold tracking-tight text-ink">
          {label}
        </div>
        <span className="ml-2 hidden items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-[10px] font-medium text-ink-subtle sm:inline-flex">
          <CalendarIcon className="h-3 w-3" strokeWidth={1.75} />
          {timezone}
        </span>
      </div>

      <SegmentedViewSwitcher view={view} onView={onView} />
    </div>
  );
}

function SegmentedViewSwitcher({ view, onView }: { view: View; onView: (v: View) => void }) {
  const reduced = useReducedMotion();
  return (
    <div className="relative inline-flex rounded-xl border border-border bg-surface-subtle p-0.5 shadow-soft">
      {VIEWS.map((v) => {
        const active = view === v;
        return (
          <button
            key={v}
            onClick={() => onView(v)}
            aria-pressed={active}
            className={cn(
              "relative z-10 inline-flex h-7 items-center justify-center rounded-lg px-3 text-[12px] font-medium transition-colors",
              active ? "text-white" : "text-ink-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId="calendar-view-indicator"
                className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(53,157,243,0.35)]"
                aria-hidden
                transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 350, damping: 30 }}
              />
            )}
            <span className="relative">{VIEW_LABEL[v]}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Scheduling Pulse — left-rail intelligence card ────────────────

type Pulse = {
  todayCount: number;
  todayMinutes: number;
  utilizationPct: number;
  nextUpcoming: CalendarBooking | null;
  focusBlocks: number;
  /** Longest contiguous unbooked window inside business hours today,
   *  rendered as a human label like "2:00 – 4:30pm". null when none. */
  bestFocusWindow: { label: string; minutes: number } | null;
  /** True when any two of today's confirmed bookings touch
   *  (no buffer between end of one and start of the next). */
  backToBack: boolean;
  insight: string | null;
};

function computePulse(
  bookings: CalendarBooking[],
  timezone: string,
): Pulse {
  const now = Date.now();
  const todayKey = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");

  const todays = bookings.filter(
    (b) =>
      b.status === "confirmed" &&
      formatInTimeZone(b.startAt, timezone, "yyyy-MM-dd") === todayKey,
  );
  const todayMinutes = todays.reduce(
    (acc, b) => acc + Math.max(0, (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60_000),
    0,
  );
  // Utilization = booked minutes / business-day minutes (DAY_END - DAY_START hours)
  const businessMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const utilizationPct = Math.min(100, Math.round((todayMinutes / businessMinutes) * 100));

  const nextUpcoming =
    bookings
      .filter((b) => b.status === "confirmed" && new Date(b.startAt).getTime() >= now)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())[0] ?? null;

  // Focus blocks = number of gaps ≥ 60min between today's bookings inside the
  // business window. Cheap heuristic; visual signal, not analytical truth.
  const focusBlocks = countFocusBlocks(todays, timezone);

  // Best (longest) free contiguous window inside business hours today.
  const bestFocusWindow = computeBestFocusWindow(todays, timezone);

  // Back-to-back detection — any pair of bookings where one ends exactly
  // when the next starts (touching or overlapping).
  const sortedToday = [...todays].sort((a, b) => a.startAt.localeCompare(b.startAt));
  let backToBack = false;
  for (let i = 1; i < sortedToday.length; i++) {
    if (new Date(sortedToday[i].startAt).getTime() <= new Date(sortedToday[i - 1].endAt).getTime()) {
      backToBack = true;
      break;
    }
  }

  const insight = chooseInsight({
    todayCount: todays.length,
    utilizationPct,
    focusBlocks,
    bestFocusWindow,
    backToBack,
  });

  return {
    todayCount: todays.length,
    todayMinutes,
    utilizationPct,
    nextUpcoming,
    focusBlocks,
    bestFocusWindow,
    backToBack,
    insight,
  };
}

function computeBestFocusWindow(
  todays: CalendarBooking[],
  timezone: string,
): { label: string; minutes: number } | null {
  const dayStartMin = DAY_START_HOUR * 60;
  const dayEndMin = DAY_END_HOUR * 60;
  const sorted = [...todays].sort((a, b) => a.startAt.localeCompare(b.startAt));

  // Build sorted (start, end) interval list in business-day minutes.
  const ivals = sorted.map((b) => {
    const s = formatInTimeZone(b.startAt, timezone, "HH:mm").split(":").map(Number);
    const e = formatInTimeZone(b.endAt, timezone, "HH:mm").split(":").map(Number);
    return [s[0] * 60 + s[1], e[0] * 60 + e[1]] as const;
  });

  let cursor = dayStartMin;
  let best: [number, number] | null = null;
  for (const [s, e] of ivals) {
    if (s > cursor) {
      const gap = s - cursor;
      if (!best || gap > best[1] - best[0]) best = [cursor, s];
    }
    cursor = Math.max(cursor, e);
  }
  if (dayEndMin > cursor) {
    const gap = dayEndMin - cursor;
    if (!best || gap > best[1] - best[0]) best = [cursor, dayEndMin];
  }
  if (!best) return null;
  const [s, e] = best;
  const minutes = e - s;
  if (minutes < 45) return null; // not a meaningful window
  return { label: `${fmt12(s)} – ${fmt12(e)}`, minutes };
}

function fmt12(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const hh = ((h + 11) % 12) + 1;
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, "0")}${ampm}`;
}

function chooseInsight(args: {
  todayCount: number;
  utilizationPct: number;
  focusBlocks: number;
  bestFocusWindow: { label: string; minutes: number } | null;
  backToBack: boolean;
}): string | null {
  if (args.todayCount === 0) {
    return "Your day is wide open. A good window for deep work or sharing your booking link.";
  }
  if (args.backToBack && args.utilizationPct >= 60) {
    return "Several back-to-back meetings today. A 10-min buffer between calls keeps the day from blurring.";
  }
  if (args.utilizationPct >= 75) {
    return "Heavy day ahead — protect a short break to stay sharp through the afternoon.";
  }
  if (args.bestFocusWindow && args.bestFocusWindow.minutes >= 90) {
    return `Best focus window: ${args.bestFocusWindow.label}. Reserve it before something fills it.`;
  }
  if (args.focusBlocks >= 2) {
    return `${args.focusBlocks} focus windows on your calendar today. Plenty of breathing room.`;
  }
  if (args.utilizationPct <= 25) {
    return "Light schedule — a strong window for outreach or planning.";
  }
  return null;
}

function countFocusBlocks(todays: CalendarBooking[], timezone: string): number {
  if (todays.length === 0) return 1;
  const sorted = [...todays].sort((a, b) => a.startAt.localeCompare(b.startAt));
  let count = 0;
  let cursorMin = DAY_START_HOUR * 60;
  for (const b of sorted) {
    const startLabel = formatInTimeZone(b.startAt, timezone, "HH:mm");
    const endLabel = formatInTimeZone(b.endAt, timezone, "HH:mm");
    const [sh, sm] = startLabel.split(":").map(Number);
    const [eh, em] = endLabel.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin - cursorMin >= 60) count++;
    cursorMin = Math.max(cursorMin, endMin);
  }
  if (DAY_END_HOUR * 60 - cursorMin >= 60) count++;
  return count;
}

function SchedulingPulse({ pulse }: { pulse: Pulse }) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className={cn(
        "relative overflow-hidden",
        "bg-gradient-to-br from-brand-subtle/40 via-surface to-surface",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/10 blur-3xl"
      />
      <div className="relative">
        <div className="flex items-center gap-2">
          <div className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-accent text-white shadow-sm">
            <Activity className="h-3.5 w-3.5" strokeWidth={2} />
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
              Schedule pulse
            </div>
            <div className="text-[13px] font-semibold text-ink">Today at a glance</div>
          </div>
        </div>

        {/* Utilization ring + meta */}
        <div className="mt-3 flex items-center gap-3">
          <UtilizationRing pct={pulse.utilizationPct} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1">
              <span className="text-[20px] font-semibold leading-none tabular-nums text-ink">
                {pulse.todayCount}
              </span>
              <span className="text-[11px] text-ink-muted">bookings</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
              <Clock4 className="h-3 w-3" strokeWidth={1.75} />
              {Math.round(pulse.todayMinutes)}m booked
            </div>
          </div>
        </div>

        {/* Mini meta tiles */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <PulseTile
            icon={Coffee}
            tone="brand"
            label="Focus blocks"
            value={String(pulse.focusBlocks)}
          />
          <PulseTile
            icon={Flame}
            tone={pulse.utilizationPct >= 75 ? "warning" : "neutral"}
            label="Load"
            value={`${pulse.utilizationPct}%`}
          />
        </div>

        {/* Best focus window — only when meaningful (≥45min) */}
        {pulse.bestFocusWindow && (
          <div className="mt-3 rounded-xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/70 to-surface p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700">
                Best focus window
              </span>
              <span className="text-[10px] font-medium tabular-nums text-emerald-700">
                {pulse.bestFocusWindow.minutes}m
              </span>
            </div>
            <div className="mt-0.5 text-[12px] font-semibold tabular-nums text-emerald-900">
              {pulse.bestFocusWindow.label}
            </div>
          </div>
        )}

        {/* Next-up nano card */}
        {pulse.nextUpcoming && (
          <NextUpNano booking={pulse.nextUpcoming} />
        )}

        {pulse.insight && (
          <div className="mt-3">
            <InsightCard title="Pulse">{pulse.insight}</InsightCard>
          </div>
        )}
      </div>
    </PremiumCard>
  );
}

function UtilizationRing({ pct }: { pct: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="relative h-12 w-12 shrink-0" aria-hidden>
      <svg viewBox="0 0 48 48" className="h-12 w-12 -rotate-90">
        <circle cx="24" cy="24" r={r} className="fill-none stroke-surface-inset" strokeWidth="4" />
        <circle
          cx="24"
          cy="24"
          r={r}
          className="fill-none stroke-brand-accent transition-[stroke-dasharray] duration-700 ease-out"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ filter: "drop-shadow(0 0 5px rgba(53,157,243,0.35))" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[10px] font-semibold tabular-nums text-ink">{pct}%</span>
      </div>
    </div>
  );
}

function PulseTile({
  icon: Icon,
  tone,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: "brand" | "warning" | "neutral";
  label: string;
  value: string;
}) {
  const toneClass =
    tone === "brand"
      ? "bg-brand-subtle text-brand-accent ring-brand-accent/15"
      : tone === "warning"
        ? "bg-amber-50 text-amber-600 ring-amber-300/40"
        : "bg-surface-inset text-ink-subtle ring-transparent";
  return (
    <div className="rounded-lg border border-border bg-surface/60 p-2.5 backdrop-blur-sm">
      <div className="flex items-center gap-1.5">
        <div className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md ring-1", toneClass)}>
          <Icon className="h-3 w-3" strokeWidth={1.75} />
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">{label}</span>
      </div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function NextUpNano({ booking }: { booking: CalendarBooking }) {
  const startMs = new Date(booking.startAt).getTime();
  const diffMin = Math.max(0, Math.round((startMs - Date.now()) / 60_000));
  const inWord =
    diffMin === 0
      ? "now"
      : diffMin < 60
        ? `in ${diffMin}m`
        : diffMin < 60 * 24
          ? `in ${Math.round(diffMin / 60)}h`
          : `in ${Math.round(diffMin / 60 / 24)}d`;
  return (
    <div className="mt-3 rounded-xl border border-brand-accent/15 bg-surface/80 p-2.5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-brand-accent">Next up</span>
        <span className="text-[10px] tabular-nums text-ink-subtle">{inWord}</span>
      </div>
      <div className="mt-1 truncate text-[12px] font-semibold text-ink">{booking.serviceName}</div>
      <div className="mt-0.5 truncate text-[10px] text-ink-muted">with {firstName(booking.clientName)}</div>
    </div>
  );
}

// ─── Mini Calendar — premium glass tile with density dots ──────────

function MiniCalendar({
  anchor, onPick, byDay,
}: {
  anchor: Date;
  onPick: (d: Date) => void;
  byDay: Map<string, CalendarBooking[]>;
}) {
  const [month, setMonth] = React.useState(() => startOfMonth(anchor));
  React.useEffect(() => setMonth(startOfMonth(anchor)), [anchor]);
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(monthEnd);
  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

  return (
    <PremiumCard compact interactive={false}>
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={() => setMonth((m) => subMonths(m, 1))}
          aria-label="Previous month"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <div className="text-[13px] font-semibold tracking-tight text-ink">{format(month, "MMMM yyyy")}</div>
        <button
          onClick={() => setMonth((m) => addMonths(m, 1))}
          aria-label="Next month"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
        >
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[9px] font-semibold uppercase tracking-wider text-ink-subtle">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5">
        {days.map((d) => {
          const inMonth = isSameMonth(d, month);
          const isAnchor = isSameDay(d, anchor);
          const isToday = isSameDay(d, new Date());
          const count = byDay.get(format(d, "yyyy-MM-dd"))?.length ?? 0;
          const density = Math.min(3, count); // 0, 1, 2, 3+
          return (
            <button
              key={d.toISOString()}
              onClick={() => onPick(d)}
              className={cn(
                "relative flex h-8 items-center justify-center rounded-lg text-[12px] transition-all duration-150 ease-out",
                "hover:ring-1 hover:ring-brand-accent/25",
                isAnchor
                  ? "bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_10px_rgba(53,157,243,0.35)] hover:ring-0"
                  : isToday
                    ? "bg-brand-subtle/70 font-semibold text-brand-accent ring-1 ring-brand-accent/20"
                    : inMonth
                      ? "text-ink hover:bg-surface-inset"
                      : "text-ink-subtle hover:bg-surface-inset/60",
              )}
              aria-label={`Go to ${format(d, "EEEE MMM d")}`}
            >
              <span className="tabular-nums">{format(d, "d")}</span>
              {density > 0 && (
                <div className={cn(
                  "absolute bottom-0.5 left-1/2 flex -translate-x-1/2 items-center gap-[2px]",
                )} aria-hidden>
                  {Array.from({ length: density }).map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "h-[3px] w-[3px] rounded-full",
                        isAnchor ? "bg-white/80" : "bg-brand-accent",
                      )}
                    />
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// ─── Day View ──────────────────────────────────────────────────────

function DayView({
  anchor, timezone, byDay, onOpen, onReschedule,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
}) {
  const key = format(anchor, "yyyy-MM-dd");
  const list = byDay.get(key) ?? [];
  const today = isSameDay(anchor, new Date());

  return (
    <div className="relative overflow-x-auto">
      <div className="grid min-w-[420px] grid-cols-[68px,1fr]">
        <TimeGutter />
        <DayColumn
          dateKey={key}
          bookings={list}
          timezone={timezone}
          onOpen={onOpen}
          onReschedule={onReschedule}
          isToday={today}
        />
      </div>
      {today && <CurrentTimeLine timezone={timezone} leftPx={68} />}
    </div>
  );
}

// ─── Week View ─────────────────────────────────────────────────────

function WeekView({
  anchor, timezone, byDay, onOpen, onReschedule,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
}) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div className="relative overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="sticky top-0 z-10 grid grid-cols-[68px,repeat(7,minmax(0,1fr))] border-b border-border/70 bg-gradient-to-b from-surface to-surface/95 backdrop-blur-sm">
          <div />
          {days.map((d) => {
            const today = isSameDay(d, new Date());
            return (
              <div key={d.toISOString()} className="border-l border-border/50 px-2 py-2.5 text-center">
                <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  {format(d, "EEE")}
                </div>
                <div
                  className={cn(
                    "mx-auto mt-1 inline-flex h-7 w-7 items-center justify-center rounded-lg text-[13px] font-semibold tabular-nums",
                    today
                      ? "bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_2px_8px_rgba(53,157,243,0.35)]"
                      : "text-ink",
                  )}
                >
                  {format(d, "d")}
                </div>
              </div>
            );
          })}
        </div>
        <div className="relative">
          <div className="grid grid-cols-[68px,repeat(7,minmax(0,1fr))]">
            <TimeGutter />
            {days.map((d) => {
              const key = format(d, "yyyy-MM-dd");
              const today = isSameDay(d, new Date());
              return (
                <DayColumn
                  key={key}
                  dateKey={key}
                  bookings={byDay.get(key) ?? []}
                  timezone={timezone}
                  onOpen={onOpen}
                  onReschedule={onReschedule}
                  isToday={today}
                />
              );
            })}
          </div>
          {days.some((d) => isSameDay(d, new Date())) && <CurrentTimeLine timezone={timezone} leftPx={68} />}
        </div>
      </div>
    </div>
  );
}

// ─── Day Column (shared Day + Week) ────────────────────────────────

function DayColumn({
  dateKey, bookings, timezone, onOpen, onReschedule, isToday = false,
}: {
  dateKey: string;
  bookings: CalendarBooking[];
  timezone: string;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
  /** When true the column carries a faint brand wash to anchor "today"
   *  in week view. Day view sets this whenever the anchor === today. */
  isToday?: boolean;
}) {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const colHeight = totalHours * PX_PER_HOUR;
  const [hoverY, setHoverY] = React.useState<number | null>(null);
  const [hoverHourIdx, setHoverHourIdx] = React.useState<number | null>(null);

  function eventStyle(b: CalendarBooking): React.CSSProperties {
    const localStartLabel = formatInTimeZone(b.startAt, timezone, "HH:mm");
    const localEndLabel = formatInTimeZone(b.endAt, timezone, "HH:mm");
    const [sh, sm] = localStartLabel.split(":").map(Number);
    const [eh, em] = localEndLabel.split(":").map(Number);
    const startMin = Math.max(0, (sh - DAY_START_HOUR) * 60 + sm);
    const endMin = Math.min(totalHours * 60, (eh - DAY_START_HOUR) * 60 + em);
    const top = (startMin / 60) * PX_PER_HOUR;
    const height = Math.max(28, ((endMin - startMin) / 60) * PX_PER_HOUR - 2);
    return { top, height, position: "absolute", left: 4, right: 4 };
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!onReschedule) return;
    e.preventDefault();
    setHoverY(null);
    const id = e.dataTransfer.getData("text/booking-id");
    if (!id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const minutes = Math.round((offsetY / PX_PER_HOUR) * 60 / 15) * 15;
    const hour = DAY_START_HOUR + Math.floor(minutes / 60);
    const minute = minutes % 60;
    const local = `${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
    const newStart = fromZonedTime(local, timezone).toISOString();
    onReschedule(id, newStart);
  }

  function handleMove(e: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setHoverHourIdx(Math.max(0, Math.min(totalHours - 1, Math.floor(y / PX_PER_HOUR))));
  }

  return (
    <div
      className={cn(
        "relative border-l border-border/50 transition-colors duration-200",
        isToday && "bg-gradient-to-b from-brand-subtle/15 via-transparent to-transparent",
      )}
      style={{ height: colHeight }}
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverHourIdx(null)}
      onDragOver={(e) => {
        if (!onReschedule) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setHoverY(e.clientY - rect.top);
      }}
      onDragLeave={() => setHoverY(null)}
      onDrop={handleDrop}
    >
      {/* Hour grid background with alternating shading + business-hour wash */}
      {Array.from({ length: totalHours }).map((_, i) => {
        const hour = DAY_START_HOUR + i;
        const isBusinessHour = hour >= 9 && hour < 17;
        const isHovered = hoverHourIdx === i;
        return (
          <React.Fragment key={i}>
            <div
              className={cn(
                "absolute inset-x-0 transition-colors duration-150",
                i % 2 === 0 ? "bg-transparent" : "bg-surface-inset/15",
                isBusinessHour && i % 2 === 0 && "bg-brand-subtle/[0.04]",
                isHovered && "bg-brand-subtle/20",
              )}
              style={{ top: i * PX_PER_HOUR, height: PX_PER_HOUR }}
              aria-hidden
            />
            <div
              className="absolute inset-x-0 border-t border-border/30"
              style={{ top: i * PX_PER_HOUR }}
              aria-hidden
            />
            {/* Half-hour ticks (very subtle) */}
            <div
              className="absolute inset-x-0 border-t border-dashed border-border/15"
              style={{ top: i * PX_PER_HOUR + PX_PER_HOUR / 2 }}
              aria-hidden
            />
          </React.Fragment>
        );
      })}

      {/* Drag-to-create hint line */}
      {hoverY !== null && (
        <div
          className="pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-brand-accent/70 shadow-[0_0_6px_rgba(53,157,243,0.45)]"
          style={{ top: hoverY - 1 }}
          aria-hidden
        />
      )}

      {bookings.map((b) => (
        <EventBlock
          key={b.id}
          booking={b}
          timezone={timezone}
          style={eventStyle(b)}
          onOpen={() => onOpen(b)}
          draggable={Boolean(onReschedule)}
        />
      ))}
    </div>
  );
}

function EventBlock({
  booking, timezone, style, onOpen, draggable,
}: {
  booking: CalendarBooking;
  timezone: string;
  style: React.CSSProperties;
  onOpen: () => void;
  draggable: boolean;
}) {
  const accent = serviceColorFor(booking.serviceId, booking.serviceColor);
  const durationMin = Math.max(0, Math.round((new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime()) / 60_000));
  const isMuted = booking.status === "cancelled" || booking.status === "refunded";
  const start = formatInTimeZone(booking.startAt, timezone, "h:mm a");
  const initials = customerInitials(booking.clientName);
  const isShort = durationMin < 30;

  // Read the explicit height from `style.height` so we can decide
  // whether the hover-expansion quick-actions row should fit inside.
  // The grid math passes height in pixels.
  const heightPx = typeof style.height === "number" ? style.height : 0;
  const canExpand = !isMuted && heightPx >= 50; // ≥ ~30min slot

  return (
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
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/booking-id", booking.id)}
      className={cn(
        "group/event relative flex flex-col items-start overflow-hidden rounded-lg border bg-surface/90 px-2.5 py-1.5 pl-3 text-left text-[11px] shadow-soft backdrop-blur-sm transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:scale-[1.012] hover:shadow-lift hover:border-border-strong hover:z-20",
        isMuted ? "opacity-60" : "",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        "border-border/70",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
      )}
      style={{
        ...style,
        background: `linear-gradient(135deg, ${hexAlpha(accent, 0.10)} 0%, var(--color-surface) 60%)`,
      }}
      aria-label={`${booking.serviceName} with ${booking.clientName}`}
      title={`${booking.serviceName} · ${booking.clientName} · ${start} · ${durationMin}m`}
    >
      {/* Service-color accent bar */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-1 rounded-full"
        style={{ background: accent }}
      />
      {/* Soft hover-glow halo */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-lg opacity-0 transition-opacity duration-200 group-hover/event:opacity-100"
        style={{ boxShadow: `0 0 0 1px ${hexAlpha(accent, 0.35)}, 0 8px 22px ${hexAlpha(accent, 0.18)}` }}
      />

      <div className="relative flex w-full items-center gap-1.5">
        <span className="font-semibold tabular-nums text-ink">{start}</span>
        <span className="text-ink-subtle">·</span>
        <span className="text-[10px] text-ink-muted">{durationMin}m</span>
        <div className="ml-auto flex items-center gap-1">
          {booking.meetLink && (
            <Video
              className="h-2.5 w-2.5 text-ink-subtle group-hover/event:text-brand-accent"
              strokeWidth={1.75}
              aria-label="Has meeting link"
            />
          )}
          <StatusPill status={booking.status} />
        </div>
      </div>

      <div className={cn("relative mt-0.5 line-clamp-1 font-medium", isMuted ? "line-through text-ink-muted" : "text-ink")}>
        {booking.serviceName}
      </div>

      <div className="relative mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-muted">
        <AvatarChip initials={initials} accent={accent} />
        <span className="line-clamp-1">{booking.clientName}</span>
      </div>

      {/* Hover-expansion: quick actions reveal on hover when the block has
          enough vertical room. The actions stop propagation so they
          don't double-trigger onOpen. */}
      {canExpand && (
        <div
          className={cn(
            "relative mt-1.5 hidden items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/event:flex group-hover/event:opacity-100",
            isShort && "group-hover/event:hidden",
          )}
        >
          <EventAction
            icon={ExternalLink}
            label="Open"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          />
          {booking.meetLink && (
            <EventAction
              icon={Video}
              label="Join"
              href={booking.meetLink}
            />
          )}
          {draggable && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-surface-inset/70 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-subtle">
              <Move3D className="h-2.5 w-2.5" strokeWidth={1.75} />
              Drag
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function EventAction({
  icon: Icon,
  label,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  href?: string;
}) {
  const cls =
    "inline-flex items-center gap-1 rounded-md border border-border/70 bg-surface px-1.5 py-0.5 text-[9px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        className={cls}
      >
        <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
        {label}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
      {label}
    </button>
  );
}

function AvatarChip({ initials, accent }: { initials: string; accent: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold uppercase tracking-wider text-white shadow-sm"
      style={{ background: `linear-gradient(135deg, ${accent} 0%, ${shade(accent, -12)} 100%)` }}
    >
      {initials}
    </span>
  );
}

function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Darken/lighten a hex color by `pct` percentage points. Returns the
 *  original string when the input isn't parseable. */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(parseInt(h.slice(0, 2), 16) * (1 + pct / 100));
  const g = clamp(parseInt(h.slice(2, 4), 16) * (1 + pct / 100));
  const b = clamp(parseInt(h.slice(4, 6), 16) * (1 + pct / 100));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function StatusPill({ status, className }: { status: Status; className?: string }) {
  // Compact dot-only indicator — keeps blocks dense without noisy text.
  return (
    <span className={cn("inline-flex h-1.5 w-1.5 rounded-full", STATUS_DOT[status], className)} aria-label={STATUS_LABEL[status]} />
  );
}

// ─── Time Gutter (left labels) ─────────────────────────────────────

function TimeGutter() {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  return (
    <div className="relative" style={{ height: totalHours * PX_PER_HOUR }} aria-hidden>
      {Array.from({ length: totalHours }).map((_, i) => {
        const hour = DAY_START_HOUR + i;
        const label = hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
        return (
          <div
            key={i}
            className="absolute right-2 -translate-y-1/2 text-[10px] font-medium tabular-nums text-ink-subtle"
            style={{ top: i * PX_PER_HOUR }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}

// ─── Current Time indicator — premium brand glow ───────────────────

function CurrentTimeLine({ timezone, leftPx }: { timezone: string; leftPx: number }) {
  const [now, setNow] = React.useState(new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const local = formatInTimeZone(now, timezone, "HH:mm");
  const [h, m] = local.split(":").map(Number);
  if (h < DAY_START_HOUR || h >= DAY_END_HOUR) return null;
  const top = ((h - DAY_START_HOUR) * 60 + m) / 60 * PX_PER_HOUR;
  const label = formatInTimeZone(now, timezone, "h:mm a");
  return (
    <div
      className="pointer-events-none absolute right-0 z-20 flex items-center gap-1.5"
      style={{ top, left: leftPx }}
      aria-label="Current time"
    >
      <div className="relative -ml-1.5">
        <div className="h-3 w-3 rounded-full bg-brand-accent shadow-[0_0_10px_rgba(53,157,243,0.6)]" />
        <div className="absolute inset-0 h-3 w-3 animate-ping rounded-full bg-brand-accent/40" />
      </div>
      {/* Floating "Now · h:mm" pill — rides alongside the dot so the
          time of the indicator is always legible at a glance. */}
      <div className="shrink-0">
        <div className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_10px_rgba(53,157,243,0.35)]">
          <span className="h-1 w-1 rounded-full bg-white/90" />
          Now · {label}
        </div>
      </div>
      <div
        className="h-px flex-1"
        style={{
          background:
            "linear-gradient(to right, var(--color-accent, #359df3) 0%, rgba(53,157,243,0.55) 40%, rgba(53,157,243,0) 100%)",
        }}
      />
    </div>
  );
}

// ─── Month View ────────────────────────────────────────────────────

function MonthView({
  anchor, timezone, byDay, onOpen, onJump,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  onOpen: (b: CalendarBooking) => void;
  onJump: (d: Date) => void;
}) {
  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(monthEnd);
  const cells: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) cells.push(d);
  const weeks: Date[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border/60 bg-surface-subtle/40 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="px-2 py-2">{d}</div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7 border-b border-border/60 last:border-b-0">
          {week.map((d) => {
            const key = format(d, "yyyy-MM-dd");
            const list = byDay.get(key) ?? [];
            const outside = !isSameMonth(d, anchor);
            const today = isSameDay(d, new Date());
            return (
              <button
                key={key}
                onClick={() => onJump(d)}
                className={cn(
                  "group relative min-h-[120px] cursor-pointer border-r border-border/60 p-2 text-left transition-colors last:border-r-0",
                  outside ? "bg-surface-subtle/30 text-ink-subtle" : "bg-surface text-ink hover:bg-surface-inset/30",
                )}
              >
                <div className="flex items-center justify-between">
                  <div
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-lg text-[11px] font-semibold tabular-nums",
                      today
                        ? "bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_2px_6px_rgba(53,157,243,0.35)]"
                        : outside ? "text-ink-subtle" : "text-ink",
                    )}
                  >
                    {format(d, "d")}
                  </div>
                  {list.length > 0 && (
                    <span className="text-[9px] font-medium tabular-nums text-ink-subtle">
                      {list.length}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 space-y-1">
                  {list.slice(0, 3).map((b) => {
                    const accent = serviceColorFor(b.serviceId, b.serviceColor);
                    const muted = b.status === "cancelled" || b.status === "refunded";
                    return (
                      <div
                        key={b.id}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onOpen(b); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpen(b);
                          }
                        }}
                        className={cn(
                          "flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[10px] transition-colors hover:bg-surface-inset",
                          muted ? "opacity-60" : "",
                        )}
                        style={{
                          borderLeft: `2px solid ${accent}`,
                          background: `linear-gradient(90deg, ${hexAlpha(accent, 0.08)} 0%, transparent 80%)`,
                        }}
                      >
                        <span className="font-semibold tabular-nums text-ink">
                          {formatInTimeZone(b.startAt, timezone, "h:mma")}
                        </span>
                        <span className={cn("truncate", muted ? "line-through" : "")}>{b.serviceName}</span>
                      </div>
                    );
                  })}
                  {list.length > 3 && (
                    <div className="text-[10px] font-medium text-brand-accent">+{list.length - 3} more</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Agenda View ───────────────────────────────────────────────────

function AgendaView({
  anchor, timezone, byDay, onOpen,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  onOpen: (b: CalendarBooking) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  return (
    <div className="divide-y divide-border/60">
      {days.map((d) => {
        const key = format(d, "yyyy-MM-dd");
        const list = byDay.get(key) ?? [];
        const today = isSameDay(d, new Date());
        return (
          <div key={key} className="grid grid-cols-[110px,1fr] gap-3 px-5 py-4">
            <div>
              <div className={cn("text-[11px] font-semibold uppercase tracking-wider", today ? "text-brand-accent" : "text-ink-subtle")}>
                {format(d, "EEE")}
              </div>
              <div className={cn("mt-0.5 text-[20px] font-semibold tracking-tight tabular-nums", today ? "text-brand-accent" : "text-ink")}>
                {format(d, "d")}
              </div>
              <div className="mt-0.5 text-[11px] text-ink-muted">{format(d, "MMM yyyy")}</div>
              {list.length > 0 && (
                <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-[10px] font-medium text-ink-subtle">
                  {list.length} {list.length === 1 ? "booking" : "bookings"}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              {list.length === 0 && (
                <div className="rounded-lg border border-dashed border-border/50 px-3 py-3 text-[11px] text-ink-subtle">
                  No bookings — open availability.
                </div>
              )}
              {list.map((b) => {
                const accent = serviceColorFor(b.serviceId, b.serviceColor);
                const muted = b.status === "cancelled" || b.status === "refunded";
                return (
                  <button
                    key={b.id}
                    onClick={() => onOpen(b)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-xl border border-border/70 bg-surface px-3 py-2.5 text-left shadow-soft transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
                      muted ? "opacity-60" : "",
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-9 w-1 shrink-0 rounded-full"
                      style={{ background: accent }}
                    />
                    <div className="w-32 shrink-0">
                      <div className="text-[12px] font-semibold tabular-nums text-ink">
                        {formatInTimeZone(b.startAt, timezone, "h:mm a")}
                      </div>
                      <div className="text-[10px] text-ink-muted">
                        {formatInTimeZone(b.endAt, timezone, "h:mm a")}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-[13px] font-semibold", muted ? "text-ink-muted line-through" : "text-ink")}>
                        {b.serviceName}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-muted">
                        <Users className="h-3 w-3" strokeWidth={1.75} />
                        <span className="truncate">{b.clientName}</span>
                        <span>·</span>
                        <span className="truncate">{b.staffName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn("inline-flex h-2 w-2 rounded-full", STATUS_DOT[b.status])} aria-label={STATUS_LABEL[b.status]} />
                      <ArrowRight className="h-3.5 w-3.5 text-ink-subtle transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Empty states ─────────────────────────────────────────────────

function CalendarEmptyState() {
  return (
    <div className="px-6 py-12">
      <div className="mx-auto max-w-md">
        <EmptyState
          icon={Sparkles}
          title="Your schedule is wide open"
          body="Share your booking page to start filling your calendar — or block focus time to protect deep work."
        />
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <a
            href="/dashboard/services"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[12px] font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md"
          >
            <CalendarPlus className="h-3.5 w-3.5" strokeWidth={2} />
            Create a service
          </a>
          <a
            href="/dashboard/settings/branding"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
          >
            <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Share booking page
          </a>
          <a
            href="/dashboard/availability"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
          >
            <Clock4 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Set availability
          </a>
          <a
            href="/dashboard/settings/integrations"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
          >
            <Settings2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Connect calendar
          </a>
        </div>
      </div>
    </div>
  );
}

function FilteredEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <div className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface-subtle text-ink-subtle">
        <Inbox className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <div className="mt-3 text-[13px] font-semibold text-ink">No matches for the current filters</div>
      <p className="mt-1 text-[11px] text-ink-muted">Try clearing filters to see your full schedule.</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
      >
        Clear filters
      </button>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────

function unique<K, V>(rows: readonly (readonly [K, V])[]): [K, V][] {
  const seen = new Map<K, V>();
  for (const [k, v] of rows) if (!seen.has(k)) seen.set(k, v);
  return Array.from(seen.entries());
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

/** Convert "#RRGGBB" or "rgb()" to an rgba string with the given alpha.
 *  Falls back to the input string when the parse fails. */
function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
