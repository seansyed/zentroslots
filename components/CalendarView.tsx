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
  X,
  Ban,
  Building2,
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
  /** True when this row was synthesized by buildDemoBookings() to give
   *  the calendar a populated feel for brand-new tenants. Demo rows are
   *  visually identical to real ones but never open the drawer or hit
   *  reschedule endpoints. The page never serializes this flag — it
   *  only exists in the client when the bookings prop is empty. */
  isDemo?: boolean;
};

/** Phase 17I-2C — operational calendar entries (blocked time + internal
 *  meetings). Painted alongside CalendarBooking but visually distinct.
 *  NEVER customer-facing. Never opens the booking drawer (no
 *  serviceId, no clientEmail, no payment lifecycle). */
export type CalendarEventLite = {
  id: string;
  eventType: "blocked_time" | "internal_meeting";
  title: string;
  startAt: string;
  endAt: string;
  /** Slot owner — blocked_time: the blocked staff; internal_meeting:
   *  the organizer. */
  staffId: string;
  staffName: string;
  /** Other staff invited to internal_meeting. Empty for blocked_time. */
  attendeeNames: string[];
  meetLink?: string | null;
  location?: string | null;
};

/** Phase 17I-3B — customer-facing group sessions (webinars, workshops,
 *  office hours). Distinct entity from CalendarBooking (1:1) AND
 *  CalendarEventLite (operational, non-customer). Rendered with its
 *  own emerald accent + GROUP badge + N/cap attendee counter. */
export type GroupSessionLite = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  /** Host's slot owner (group_sessions.host_user_id). */
  hostId: string;
  hostName: string;
  maxCapacity: number;         // 0 = unlimited
  currentRegistrations: number;
  meetLink?: string | null;
  location?: string | null;
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
  calendarEvents = [],
  groupSessions = [],
  canManage = true,
}: {
  timezone: string;
  bookings: CalendarBooking[];
  /** Phase 17I-2C — operational calendar entries (blocked_time +
   *  internal_meeting). Optional + defaults to [] so existing call
   *  sites that don't supply it keep working. */
  calendarEvents?: CalendarEventLite[];
  /** Phase 17I-3B — customer-facing group sessions. Optional +
   *  defaults to [] for back-compat. */
  groupSessions?: GroupSessionLite[];
  canManage?: boolean;
}) {
  const [view, setView] = React.useState<View>("week");
  const [anchor, setAnchor] = React.useState(() => startOfDay(new Date()));
  const [drawerBooking, setDrawerBooking] = React.useState<DrawerBooking | null>(null);
  const [bookingState, setBookingState] = React.useState<CalendarBooking[]>(bookings);

  // Demo schedule: when the tenant has zero real bookings, populate
  // the visible window with a realistic showcase schedule so the
  // calendar feels alive instead of empty. Demo rows are visually
  // identical but click-locked (no drawer, no API hits). The user can
  // hide samples; preference persists in localStorage.
  const [demoHidden, setDemoHidden] = React.useState(false);
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem("calendar_demo_hidden") === "1") {
      setDemoHidden(true);
    }
  }, []);
  const isDemoActive = bookings.length === 0 && !demoHidden;
  React.useEffect(() => {
    if (isDemoActive) {
      setBookingState(buildDemoBookings(new Date(), timezone));
    } else {
      setBookingState(bookings);
    }
  }, [bookings, isDemoActive, timezone]);

  function dismissDemo() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("calendar_demo_hidden", "1");
    }
    setDemoHidden(true);
  }

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

  // Phase 17I-2C — parallel bucket for calendar_events (blocked_time +
  // internal_meeting). Painted alongside bookings in DayColumn / Agenda
  // but never opens the booking drawer.
  const byDayEvents = React.useMemo(() => {
    const m = new Map<string, CalendarEventLite[]>();
    for (const e of calendarEvents) {
      const k = formatInTimeZone(e.startAt, timezone, "yyyy-MM-dd");
      const list = m.get(k) ?? [];
      list.push(e);
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return m;
  }, [calendarEvents, timezone]);

  // Phase 17I-3B — parallel bucket for group_sessions. Same pattern;
  // distinct rendering. Never opens the booking drawer.
  const byDayGroupSessions = React.useMemo(() => {
    const m = new Map<string, GroupSessionLite[]>();
    for (const g of groupSessions) {
      const k = formatInTimeZone(g.startAt, timezone, "yyyy-MM-dd");
      const list = m.get(k) ?? [];
      list.push(g);
      m.set(k, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return m;
  }, [groupSessions, timezone]);

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
    // Demo rows have synthetic IDs the server doesn't know — never POST
    // them to /api/bookings/[id]/reschedule. Show a calm toast instead.
    if (original.isDemo) {
      toast("Preview · Sample appointments can't be rescheduled.", "info");
      return;
    }
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
    // Demo events never open the real drawer — they would route to a
    // booking ID that doesn't exist on the server, and any cancel /
    // reschedule action would 404. Show a calm toast instead.
    if (b.isDemo) {
      toast(
        "Preview · Sample appointment. Real bookings open the full detail drawer.",
        "info",
      );
      return;
    }
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
          {isDemoActive && <SampleScheduleBanner onDismiss={dismissDemo} />}
          <Toolbar
            view={view}
            onView={setView}
            label={headerLabel()}
            onPrev={() => shift(-1)}
            onNext={() => shift(1)}
            onToday={() => setAnchor(startOfDay(new Date()))}
            timezone={timezone}
          />

          {bookings.length === 0 && demoHidden ? (
            <CalendarEmptyState />
          ) : isFilteredEmpty ? (
            <FilteredEmptyState onClear={() => setFilters({})} />
          ) : (
            <ViewCrossfade viewKey={view}>
              {view === "day"    && <DayView anchor={anchor} timezone={timezone} byDay={byDay} byDayEvents={byDayEvents} byDayGroupSessions={byDayGroupSessions} onOpen={openBooking} onReschedule={canManage ? attemptReschedule : undefined} focusOverlay={pulse.bestFocusWindow} />}
              {view === "week"   && <WeekView anchor={anchor} timezone={timezone} byDay={byDay} byDayEvents={byDayEvents} byDayGroupSessions={byDayGroupSessions} onOpen={openBooking} onReschedule={canManage ? attemptReschedule : undefined} focusOverlay={pulse.bestFocusWindow} />}
              {view === "month"  && <MonthView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onJump={(d) => { setAnchor(startOfDay(d)); setView("day"); }} />}
              {view === "agenda" && <AgendaView anchor={anchor} timezone={timezone} byDay={byDay} byDayEvents={byDayEvents} byDayGroupSessions={byDayGroupSessions} onOpen={openBooking} />}
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
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
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
                transition={reduced ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
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
   *  rendered as a human label like "2:00 – 4:30pm". null when none.
   *  startMin/endMin are minutes-since-midnight for the lane overlay. */
  bestFocusWindow: { label: string; minutes: number; startMin: number; endMin: number } | null;
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
): { label: string; minutes: number; startMin: number; endMin: number } | null {
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
  return { label: `${fmt12(s)} – ${fmt12(e)}`, minutes, startMin: s, endMin: e };
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
                    ? "bg-brand-subtle/70 font-semibold text-brand-accent ring-1 ring-brand-accent/20 zm-pulse-glow"
                    : inMonth
                      ? "text-ink hover:bg-surface-inset"
                      : "text-ink-subtle hover:bg-surface-inset/60",
              )}
              aria-label={`Go to ${format(d, "EEEE MMM d")}`}
            >
              <span className="tabular-nums">{format(d, "d")}</span>
              {density > 0 && (
                <div
                  className="absolute bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-[2px]"
                  aria-hidden
                >
                  {Array.from({ length: density }).map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "h-[2px] w-[4px] rounded-full transition-colors",
                        isAnchor ? "bg-white/85" : "bg-brand-accent/85",
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
  anchor, timezone, byDay, byDayEvents, byDayGroupSessions, onOpen, onReschedule, focusOverlay,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  byDayEvents: Map<string, CalendarEventLite[]>;
  byDayGroupSessions: Map<string, GroupSessionLite[]>;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
  focusOverlay?: Pulse["bestFocusWindow"];
}) {
  const key = format(anchor, "yyyy-MM-dd");
  const list = byDay.get(key) ?? [];
  const events = byDayEvents.get(key) ?? [];
  const sessions = byDayGroupSessions.get(key) ?? [];
  const today = isSameDay(anchor, new Date());

  return (
    <div className="relative overflow-x-auto">
      <div className="grid min-w-[420px] grid-cols-[68px,1fr]">
        <TimeGutter />
        <DayColumn
          dateKey={key}
          bookings={list}
          events={events}
          groupSessions={sessions}
          timezone={timezone}
          onOpen={onOpen}
          onReschedule={onReschedule}
          isToday={today}
          focusOverlay={today ? focusOverlay ?? null : null}
        />
      </div>
      {today && <CurrentTimeLine timezone={timezone} leftPx={68} />}
    </div>
  );
}

// ─── Week View ─────────────────────────────────────────────────────

function WeekView({
  anchor, timezone, byDay, byDayEvents, byDayGroupSessions, onOpen, onReschedule, focusOverlay,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  byDayEvents: Map<string, CalendarEventLite[]>;
  byDayGroupSessions: Map<string, GroupSessionLite[]>;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
  focusOverlay?: Pulse["bestFocusWindow"];
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
                  events={byDayEvents.get(key) ?? []}
                  groupSessions={byDayGroupSessions.get(key) ?? []}
                  timezone={timezone}
                  onOpen={onOpen}
                  onReschedule={onReschedule}
                  isToday={today}
                  focusOverlay={today ? focusOverlay ?? null : null}
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
  dateKey, bookings, events = [], groupSessions = [], timezone, onOpen, onReschedule, isToday = false, focusOverlay = null,
}: {
  dateKey: string;
  bookings: CalendarBooking[];
  /** Phase 17I-2C — operational calendar entries painted below the
   *  EventBlock layer. Optional + defaults to [] so consumers that
   *  don't pass it (none today, but future-proof) keep working. */
  events?: CalendarEventLite[];
  /** Phase 17I-3B — customer-facing group sessions rendered with their
   *  own emerald accent + GROUP badge + N/cap counter. */
  groupSessions?: GroupSessionLite[];
  timezone: string;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
  /** When true the column carries a faint brand wash to anchor "today"
   *  in week view. Day view sets this whenever the anchor === today. */
  isToday?: boolean;
  /** When set, renders a soft emerald focus lane covering the start/end
   *  minute range in this column. Only set for today's column. */
  focusOverlay?: Pulse["bestFocusWindow"] | null;
}) {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const colHeight = totalHours * PX_PER_HOUR;
  const [hoverY, setHoverY] = React.useState<number | null>(null);
  const [hoverHourIdx, setHoverHourIdx] = React.useState<number | null>(null);
  const [dragTime, setDragTime] = React.useState<string | null>(null);

  function eventStyle(b: CalendarBooking): React.CSSProperties {
    return positionStyle(b.startAt, b.endAt);
  }

  // Shared time → pixel projection used by both bookings (above)
  // and the new calendar_events blocks (below). Extracted into a
  // local helper so both code paths stay byte-identical on layout.
  function positionStyle(startIso: string, endIso: string): React.CSSProperties {
    const localStartLabel = formatInTimeZone(startIso, timezone, "HH:mm");
    const localEndLabel = formatInTimeZone(endIso, timezone, "HH:mm");
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
        const y = e.clientY - rect.top;
        setHoverY(y);
        // Compute the proposed time as a label for the drag-preview chip.
        const totalMin = Math.round((y / PX_PER_HOUR) * 60 / 15) * 15;
        const hh = DAY_START_HOUR + Math.floor(totalMin / 60);
        const mm = totalMin % 60;
        setDragTime(fmt12(hh * 60 + mm));
      }}
      onDragLeave={() => { setHoverY(null); setDragTime(null); }}
      onDrop={(e) => { setDragTime(null); handleDrop(e); }}
    >
      {/* Hour grid background with alternating shading + atmosphere */}
      {Array.from({ length: totalHours }).map((_, i) => {
        const hour = DAY_START_HOUR + i;
        const isBusinessHour = hour >= 9 && hour < 17;
        const isLunchHour = hour === 12; // gentle amber wash
        const isMorningEdge = hour < 9;   // soft cool wash before 9am
        const isEveningEdge = hour >= 17; // soft cool wash after 5pm
        const isHovered = hoverHourIdx === i;
        return (
          <React.Fragment key={i}>
            <div
              className={cn(
                "absolute inset-x-0 transition-colors duration-150",
                i % 2 === 0 ? "bg-transparent" : "bg-surface-inset/15",
                isBusinessHour && i % 2 === 0 && "bg-brand-subtle/[0.04]",
                isMorningEdge && "bg-slate-100/30",
                isEveningEdge && "bg-slate-100/20",
                isLunchHour && "bg-amber-50/40",
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

      {/* Focus block overlay — only on today's column when a meaningful
          window exists. Sits behind events (z-0) but above background.
          Subtle dot-texture overlay communicates "protected zone"
          without raising visual noise. */}
      {focusOverlay && (() => {
        const startPx = ((focusOverlay.startMin - DAY_START_HOUR * 60) / 60) * PX_PER_HOUR;
        const heightPx = ((focusOverlay.endMin - focusOverlay.startMin) / 60) * PX_PER_HOUR;
        if (heightPx < 24) return null;
        return (
          <div
            className="pointer-events-none absolute inset-x-1 z-0 overflow-hidden rounded-xl border border-emerald-300/40 bg-gradient-to-b from-emerald-50/70 via-emerald-50/40 to-emerald-50/20 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.08)]"
            style={{ top: startPx, height: heightPx }}
            aria-hidden
          >
            {/* Quiet dot pattern — "protected time" texture. */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, rgba(16,185,129,0.10) 1px, transparent 0)",
                backgroundSize: "14px 14px",
              }}
            />
            <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/95 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-[0_2px_8px_rgba(16,185,129,0.35)]">
              <Coffee className="h-2.5 w-2.5" strokeWidth={2} />
              Focus · {focusOverlay.minutes}m
            </div>
          </div>
        );
      })()}

      {/* Drag-to-create hint line + floating time chip */}
      {hoverY !== null && (
        <>
          <div
            className="pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-brand-accent shadow-[0_0_10px_rgba(53,157,243,0.55)]"
            style={{ top: hoverY - 1 }}
            aria-hidden
          />
          {dragTime && (
            <div
              className="pointer-events-none absolute -translate-y-1/2 right-2 z-30"
              style={{ top: hoverY }}
              aria-hidden
            >
              <div className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-2 py-0.5 text-[10px] font-semibold tabular-nums text-white shadow-[0_4px_12px_rgba(53,157,243,0.45)]">
                <ArrowRight className="h-2.5 w-2.5" strokeWidth={2.25} />
                {dragTime}
              </div>
            </div>
          )}
        </>
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
      {/* Phase 17I-2C — operational calendar entries (blocked time +
          internal meetings). Rendered AFTER bookings so they layer
          underneath any overlapping booking visually; the EXCLUDE
          constraint on calendar_events prevents two events overlapping
          the same staff slot at all, and the availability engine (2D)
          prevents bookings landing on these slots going forward. */}
      {events.map((e) => (
        <CalendarEventBlock
          key={e.id}
          event={e}
          timezone={timezone}
          style={positionStyle(e.startAt, e.endAt)}
        />
      ))}

      {/* Phase 17I-3B — customer-facing group sessions. Distinct
          emerald accent + GROUP badge + attendee counter. The host
          slot is blocked by the availability engine (3B); the
          group_sessions_no_host_overlap EXCLUDE constraint prevents
          two sessions overlapping on the same host. */}
      {groupSessions.map((g) => (
        <GroupSessionBlock
          key={g.id}
          session={g}
          timezone={timezone}
          style={positionStyle(g.startAt, g.endAt)}
        />
      ))}
    </div>
  );
}

/** Visual block for a group_sessions row. NEVER opens the booking
 *  drawer (the entity has no service status, no clientEmail). Emerald
 *  accent + GROUP badge + N/cap attendee counter distinguish it from
 *  bookings and from calendar_events. */
function GroupSessionBlock({
  session,
  timezone,
  style,
}: {
  session: GroupSessionLite;
  timezone: string;
  style: React.CSSProperties;
}) {
  const start = formatInTimeZone(session.startAt, timezone, "h:mm a");
  const durationMin = Math.max(
    0,
    Math.round(
      (new Date(session.endAt).getTime() - new Date(session.startAt).getTime()) /
        60_000,
    ),
  );
  const heightPx = typeof style.height === "number" ? style.height : 0;
  const compact = heightPx < 40;
  const capacityLabel =
    session.maxCapacity > 0
      ? `${session.currentRegistrations}/${session.maxCapacity}`
      : `${session.currentRegistrations}`;
  const tooltip = [
    `GROUP · ${session.title}`,
    `${start} · ${durationMin}m`,
    `Host: ${session.hostName}`,
    session.maxCapacity > 0
      ? `Registrations: ${capacityLabel}`
      : `Registrations: ${capacityLabel} (no cap)`,
    session.location ? `Location: ${session.location}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className="group/grp relative flex flex-col items-start overflow-hidden rounded-xl border border-emerald-300/70 bg-gradient-to-br from-emerald-50 via-white to-white px-2.5 py-1.5 pl-3 text-left text-[11px] text-emerald-900 shadow-soft transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-lift hover:z-20"
      style={style}
      title={tooltip}
      aria-label={tooltip}
    >
      {/* Emerald accent bar */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-1 rounded-full bg-emerald-500"
      />

      <div className="relative flex w-full items-center gap-1.5">
        <Users className="h-3 w-3 text-emerald-500" strokeWidth={2} />
        <span className="font-semibold tabular-nums">{start}</span>
        {!compact && (
          <>
            <span className="text-emerald-400">·</span>
            <span className="text-[10px] opacity-80">{durationMin}m</span>
          </>
        )}
        <span className="ml-auto rounded-full bg-emerald-600 text-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider">
          Group
        </span>
      </div>

      <div className="relative mt-0.5 line-clamp-1 text-[12px] font-semibold tracking-tight">
        {session.title}
      </div>

      {!compact && (
        <div className="relative mt-1 flex items-center gap-1 text-[10px] opacity-80">
          <Users className="h-2.5 w-2.5" strokeWidth={2} />
          <span>{capacityLabel}</span>
          {session.maxCapacity > 0 && (
            <span className="opacity-70">registered</span>
          )}
        </div>
      )}
      {!compact && session.location && (
        <div className="relative mt-0.5 line-clamp-1 text-[10px] opacity-70">
          {session.location}
        </div>
      )}
    </div>
  );
}

/** Visual block for a calendar_events row. NEVER opens the booking
 *  drawer (no serviceId, no clientEmail). Distinct visual treatment
 *  per eventType — slate + lock badge for blocked_time, indigo + team
 *  badge for internal_meeting. */
function CalendarEventBlock({
  event,
  timezone,
  style,
}: {
  event: CalendarEventLite;
  timezone: string;
  style: React.CSSProperties;
}) {
  const isBlocked = event.eventType === "blocked_time";
  const start = formatInTimeZone(event.startAt, timezone, "h:mm a");
  const durationMin = Math.max(
    0,
    Math.round(
      (new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) /
        60_000,
    ),
  );
  const heightPx = typeof style.height === "number" ? style.height : 0;
  const compact = heightPx < 40;

  // Tooltip body: full title + start/end + attendees + location for
  // the native browser tooltip until we ship the dedicated drawer.
  const tooltip = [
    `${isBlocked ? "BLOCKED" : "INTERNAL"} · ${event.title}`,
    `${start} · ${durationMin}m`,
    event.attendeeNames.length > 0
      ? `Attendees: ${event.attendeeNames.join(", ")}`
      : null,
    event.location ? `Location: ${event.location}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className={cn(
        "group/cev relative flex flex-col items-start overflow-hidden rounded-xl border px-2.5 py-1.5 pl-3 text-left text-[11px] shadow-soft transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-lift hover:z-20",
        isBlocked
          ? "border-slate-300/80 bg-gradient-to-br from-slate-100 via-slate-50 to-white text-slate-800"
          : "border-indigo-300/70 bg-gradient-to-br from-indigo-50 via-white to-white text-indigo-900",
      )}
      style={{
        ...style,
        // Diagonal hatched overlay communicates "not bookable" —
        // applied via inline background-image so it composes over the
        // gradient without a second wrapping element.
        backgroundImage: isBlocked
          ? `repeating-linear-gradient(135deg, rgba(100,116,139,0.07) 0 6px, transparent 6px 12px), linear-gradient(135deg, rgba(241,245,249,1) 0%, rgba(255,255,255,1) 60%)`
          : undefined,
      }}
      title={tooltip}
      aria-label={tooltip}
    >
      {/* Type accent bar */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 left-0 w-1 rounded-full",
          isBlocked ? "bg-slate-400" : "bg-indigo-500",
        )}
      />

      <div className="relative flex w-full items-center gap-1.5">
        {isBlocked ? (
          <Ban className="h-3 w-3 text-slate-500" strokeWidth={2} />
        ) : (
          <Building2 className="h-3 w-3 text-indigo-500" strokeWidth={2} />
        )}
        <span className="font-semibold tabular-nums">{start}</span>
        {!compact && (
          <>
            <span className="text-slate-400">·</span>
            <span className="text-[10px] opacity-80">{durationMin}m</span>
          </>
        )}
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
            isBlocked
              ? "bg-slate-700/90 text-white"
              : "bg-indigo-600 text-white",
          )}
        >
          {isBlocked ? "Blocked" : "Internal"}
        </span>
      </div>

      <div className="relative mt-0.5 line-clamp-1 text-[12px] font-semibold tracking-tight">
        {event.title}
      </div>

      {!compact && event.attendeeNames.length > 0 && (
        <div className="relative mt-1 flex items-center gap-1 text-[10px] opacity-80">
          <Users className="h-2.5 w-2.5" strokeWidth={2} />
          <span className="line-clamp-1">
            {event.attendeeNames.length === 1
              ? event.attendeeNames[0]
              : `${event.attendeeNames.length} attendees`}
          </span>
        </div>
      )}

      {!compact && event.location && (
        <div className="relative mt-0.5 line-clamp-1 text-[10px] opacity-70">
          {event.location}
        </div>
      )}
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
        "group/event relative flex flex-col items-start overflow-hidden rounded-xl border bg-surface/90 px-2.5 py-1.5 pl-3 text-left text-[11px] shadow-soft backdrop-blur-sm transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-0.5 hover:scale-[1.008] hover:shadow-lift hover:border-border-strong hover:z-20",
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
        className="pointer-events-none absolute -inset-px rounded-xl opacity-0 transition-opacity duration-200 group-hover/event:opacity-100"
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

      <div className={cn("relative mt-0.5 line-clamp-1 text-[12px] font-semibold tracking-tight", isMuted ? "line-through text-ink-muted" : "text-ink")}>
        {booking.serviceName}
      </div>

      <div className="relative mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
        <AvatarChip initials={initials} accent={accent} />
        <span className="line-clamp-1 font-medium">{booking.clientName}</span>
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
  anchor, timezone, byDay, byDayEvents, byDayGroupSessions, onOpen,
}: {
  anchor: Date;
  timezone: string;
  byDay: Map<string, CalendarBooking[]>;
  byDayEvents: Map<string, CalendarEventLite[]>;
  byDayGroupSessions: Map<string, GroupSessionLite[]>;
  onOpen: (b: CalendarBooking) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  return (
    <div className="divide-y divide-border/60">
      {days.map((d) => {
        const key = format(d, "yyyy-MM-dd");
        const list = byDay.get(key) ?? [];
        const eventsList = byDayEvents.get(key) ?? [];
        const sessionsList = byDayGroupSessions.get(key) ?? [];
        const today = isSameDay(d, new Date());
        // Interleave bookings + calendar_events + group_sessions
        // chronologically. Each row carries a discriminator so the
        // renderer can branch into the right card component.
        const items: Array<
          | { kind: "booking"; row: CalendarBooking }
          | { kind: "event"; row: CalendarEventLite }
          | { kind: "session"; row: GroupSessionLite }
        > = [
          ...list.map((b) => ({ kind: "booking" as const, row: b })),
          ...eventsList.map((e) => ({ kind: "event" as const, row: e })),
          ...sessionsList.map((s) => ({ kind: "session" as const, row: s })),
        ].sort((a, b) => a.row.startAt.localeCompare(b.row.startAt));
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
              {eventsList.length > 0 && (
                <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                  {eventsList.length} {eventsList.length === 1 ? "block" : "blocks"}
                </div>
              )}
              {sessionsList.length > 0 && (
                <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  {sessionsList.length} {sessionsList.length === 1 ? "session" : "sessions"}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              {items.length === 0 && (
                <div className="rounded-lg border border-dashed border-border/50 px-3 py-3 text-[11px] text-ink-subtle">
                  No bookings — open availability.
                </div>
              )}
              {items.map((it) => {
                if (it.kind === "event") {
                  return (
                    <AgendaCalendarEventRow
                      key={`ev-${it.row.id}`}
                      event={it.row}
                      timezone={timezone}
                    />
                  );
                }
                if (it.kind === "session") {
                  return (
                    <AgendaGroupSessionRow
                      key={`gs-${it.row.id}`}
                      session={it.row}
                      timezone={timezone}
                    />
                  );
                }
                const b = it.row;
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

/** Phase 17I-2C — agenda row for a calendar_events entry. Static (no
 *  drawer / no click), styled distinctly from booking rows. */
function AgendaCalendarEventRow({
  event,
  timezone,
}: {
  event: CalendarEventLite;
  timezone: string;
}) {
  const isBlocked = event.eventType === "blocked_time";
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left shadow-soft transition-colors",
        isBlocked
          ? "border-slate-200 bg-slate-50/70"
          : "border-indigo-200 bg-indigo-50/40",
      )}
      title={
        event.attendeeNames.length > 0
          ? `${event.title} · Attendees: ${event.attendeeNames.join(", ")}`
          : event.title
      }
    >
      <span
        aria-hidden
        className={cn(
          "h-9 w-1 shrink-0 rounded-full",
          isBlocked ? "bg-slate-400" : "bg-indigo-500",
        )}
      />
      <div className="w-32 shrink-0">
        <div
          className={cn(
            "text-[12px] font-semibold tabular-nums",
            isBlocked ? "text-slate-800" : "text-indigo-900",
          )}
        >
          {formatInTimeZone(event.startAt, timezone, "h:mm a")}
        </div>
        <div className="text-[10px] text-ink-muted">
          {formatInTimeZone(event.endAt, timezone, "h:mm a")}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
              isBlocked
                ? "bg-slate-700/90 text-white"
                : "bg-indigo-600 text-white",
            )}
          >
            {isBlocked ? "Blocked" : "Internal"}
          </span>
          <span
            className={cn(
              "truncate text-[13px] font-semibold",
              isBlocked ? "text-slate-800" : "text-indigo-900",
            )}
          >
            {event.title}
          </span>
        </div>
        {!isBlocked && event.attendeeNames.length > 0 && (
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-muted">
            <Users className="h-3 w-3" strokeWidth={1.75} />
            <span className="truncate">
              {event.attendeeNames.length === 1
                ? event.attendeeNames[0]
                : `${event.attendeeNames.length} attendees`}
            </span>
          </div>
        )}
        {event.location && (
          <div className="mt-0.5 truncate text-[11px] text-ink-muted">
            {event.location}
          </div>
        )}
      </div>
      {isBlocked ? (
        <Ban className="h-4 w-4 text-slate-500" strokeWidth={1.75} />
      ) : (
        <Building2 className="h-4 w-4 text-indigo-500" strokeWidth={1.75} />
      )}
    </div>
  );
}

/** Phase 17I-3B — agenda row for a group_sessions entry. Static (no
 *  drawer / no click); emerald accent + GROUP badge + capacity. */
function AgendaGroupSessionRow({
  session,
  timezone,
}: {
  session: GroupSessionLite;
  timezone: string;
}) {
  const capacityLabel =
    session.maxCapacity > 0
      ? `${session.currentRegistrations}/${session.maxCapacity}`
      : `${session.currentRegistrations}`;
  return (
    <div
      className="flex w-full items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 px-3 py-2.5 shadow-soft transition-colors"
      title={`${session.title} · Host: ${session.hostName} · ${capacityLabel} registered`}
    >
      <span aria-hidden className="h-9 w-1 shrink-0 rounded-full bg-emerald-500" />
      <div className="w-32 shrink-0">
        <div className="text-[12px] font-semibold tabular-nums text-emerald-900">
          {formatInTimeZone(session.startAt, timezone, "h:mm a")}
        </div>
        <div className="text-[10px] text-ink-muted">
          {formatInTimeZone(session.endAt, timezone, "h:mm a")}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-emerald-600 text-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider">
            Group
          </span>
          <span className="truncate text-[13px] font-semibold text-emerald-900">
            {session.title}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
          <span className="truncate">Host: {session.hostName}</span>
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" strokeWidth={1.75} />
            {capacityLabel}
            {session.maxCapacity > 0 ? "" : " registered"}
          </span>
          {session.location && <span className="truncate">{session.location}</span>}
        </div>
      </div>
      <Users className="h-4 w-4 text-emerald-500" strokeWidth={1.75} />
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

// ─── Sample schedule banner + generator ─────────────────────────

function SampleScheduleBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="relative flex items-center gap-3 border-b border-brand-accent/15 bg-gradient-to-r from-brand-subtle/60 via-brand-subtle/20 to-transparent px-4 py-2.5 sm:px-5"
      role="status"
    >
      <div className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand-accent text-white shadow-sm">
        <Sparkles className="h-3 w-3" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold tracking-tight text-ink">
          Sample schedule
        </div>
        <div className="text-[11px] text-ink-muted">
          A preview of how your calendar will look once customers start booking. None of these are real appointments.
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="hidden h-7 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink sm:inline-flex"
      >
        Hide samples
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Hide samples"
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink sm:hidden"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Synthesize a realistic populated schedule for the current week.
 *
 * - Anchored to the start of the user's local week so the demo always
 *   appears "this week" regardless of when the calendar loads.
 * - Mix of services, durations (15–120 min), statuses, staff, and
 *   meeting links.
 * - One Wednesday overlap shows stacked-density rendering.
 * - Friday afternoon left empty to demonstrate the focus-window
 *   overlay derived by SchedulingPulse.
 * - Saturday/Sunday left mostly clear.
 *
 * The function returns rows shaped identically to CalendarBooking with
 * `isDemo: true` so the UI can opt out of drawer/reschedule actions.
 */
function buildDemoBookings(now: Date, timezone: string): CalendarBooking[] {
  const weekStartDate = startOfWeek(now);

  // Stable pseudo-uuid generator — colors are deterministic via
  // serviceColor(serviceId), which hashes the id.
  const sid = (s: string) => s.padStart(36, "0");
  const SERVICES = {
    discovery:   { id: sid("svc-discovery"),   name: "Discovery call" },
    onboarding:  { id: sid("svc-onboarding"),  name: "Onboarding session" },
    strategy:    { id: sid("svc-strategy"),    name: "Strategy review" },
    quickSync:   { id: sid("svc-quicksync"),   name: "Quick sync" },
    consult:     { id: sid("svc-consult"),     name: "Consultation" },
    standup:     { id: sid("svc-standup"),     name: "Team standup" },
    workshop:    { id: sid("svc-workshop"),    name: "Deep dive workshop" },
    coaching:    { id: sid("svc-coaching"),    name: "1:1 coaching" },
    office:      { id: sid("svc-office"),      name: "Office hours" },
    followup:    { id: sid("svc-followup"),    name: "Follow-up" },
    demo:        { id: sid("svc-demo"),        name: "Product demo" },
    customer:    { id: sid("svc-customer"),    name: "Customer call" },
    roadmap:     { id: sid("svc-roadmap"),     name: "Roadmap sync" },
    planning:    { id: sid("svc-planning"),    name: "Strategy planning" },
    cancelled:   { id: sid("svc-cancelled"),   name: "Coaching session" },
    review:      { id: sid("svc-review"),      name: "Weekly review" },
    pricing:     { id: sid("svc-pricing"),     name: "Pricing discussion" },
    checkin:     { id: sid("svc-checkin"),     name: "Client check-in" },
  };
  const STAFF = [
    { id: sid("staff-sam"),    name: "Sarah Mitchell" },
    { id: sid("staff-alex"),   name: "Alex Chen" },
    { id: sid("staff-jordan"), name: "Jordan Patel" },
  ];
  const CLIENTS = [
    { name: "Maria González",  email: "maria@example.com" },
    { name: "David Park",       email: "david@example.com" },
    { name: "Emily Roberts",    email: "emily@example.com" },
    { name: "Marcus Johnson",   email: "marcus@example.com" },
    { name: "Priya Sharma",     email: "priya@example.com" },
    { name: "Daniel Kim",       email: "daniel@example.com" },
    { name: "Ana Silva",        email: "ana@example.com" },
    { name: "Tom Henderson",    email: "tom@example.com" },
    { name: "Lisa Wong",        email: "lisa@example.com" },
    { name: "Sam Taylor",       email: "sam@example.com" },
    { name: "Olivia Brown",     email: "olivia@example.com" },
    { name: "Raj Kumar",        email: "raj@example.com" },
    { name: "Hannah Webb",      email: "hannah@example.com" },
    { name: "Noah Reyes",       email: "noah@example.com" },
    { name: "Sofia Romano",     email: "sofia@example.com" },
    { name: "Liam Walsh",       email: "liam@example.com" },
  ];

  type DemoSpec = {
    dayOffset: number; // 0 = Sun, 1 = Mon, ...
    startHour: number;
    startMin: number;
    durationMin: number;
    service: keyof typeof SERVICES;
    staff: number;
    client: number;
    status: Status;
    withMeetLink: boolean;
  };

  const specs: DemoSpec[] = [
    // Monday
    { dayOffset: 1, startHour: 9,  startMin: 0,  durationMin: 45,  service: "discovery",  staff: 0, client: 0,  status: "confirmed", withMeetLink: true  },
    { dayOffset: 1, startHour: 11, startMin: 0,  durationMin: 60,  service: "onboarding", staff: 1, client: 1,  status: "confirmed", withMeetLink: true  },
    { dayOffset: 1, startHour: 14, startMin: 0,  durationMin: 90,  service: "strategy",   staff: 0, client: 2,  status: "confirmed", withMeetLink: true  },
    { dayOffset: 1, startHour: 16, startMin: 0,  durationMin: 15,  service: "quickSync",  staff: 2, client: 3,  status: "confirmed", withMeetLink: false },

    // Tuesday
    { dayOffset: 2, startHour: 10, startMin: 0,  durationMin: 60,  service: "consult",    staff: 1, client: 4,  status: "confirmed", withMeetLink: true  },
    { dayOffset: 2, startHour: 13, startMin: 0,  durationMin: 30,  service: "standup",    staff: 0, client: 5,  status: "confirmed", withMeetLink: false },
    { dayOffset: 2, startHour: 15, startMin: 0,  durationMin: 120, service: "workshop",   staff: 2, client: 6,  status: "confirmed", withMeetLink: true  },

    // Wednesday (incl. an overlap demonstrating density)
    { dayOffset: 3, startHour: 9,  startMin: 30, durationMin: 45,  service: "coaching",   staff: 1, client: 7,  status: "confirmed", withMeetLink: true  },
    { dayOffset: 3, startHour: 11, startMin: 0,  durationMin: 60,  service: "office",     staff: 0, client: 8,  status: "pending",   withMeetLink: false },
    { dayOffset: 3, startHour: 13, startMin: 0,  durationMin: 30,  service: "followup",   staff: 2, client: 9,  status: "confirmed", withMeetLink: false },
    { dayOffset: 3, startHour: 14, startMin: 0,  durationMin: 45,  service: "demo",       staff: 1, client: 10, status: "confirmed", withMeetLink: true  },
    { dayOffset: 3, startHour: 14, startMin: 15, durationMin: 60,  service: "customer",   staff: 0, client: 11, status: "confirmed", withMeetLink: true  },
    { dayOffset: 3, startHour: 16, startMin: 30, durationMin: 30,  service: "roadmap",    staff: 2, client: 12, status: "confirmed", withMeetLink: false },

    // Thursday
    { dayOffset: 4, startHour: 10, startMin: 0,  durationMin: 60,  service: "coaching",   staff: 1, client: 13, status: "confirmed", withMeetLink: true  },
    { dayOffset: 4, startHour: 13, startMin: 30, durationMin: 60,  service: "planning",   staff: 0, client: 14, status: "confirmed", withMeetLink: false },
    { dayOffset: 4, startHour: 15, startMin: 0,  durationMin: 60,  service: "cancelled",  staff: 2, client: 15, status: "cancelled", withMeetLink: false },

    // Friday (afternoon left clear so the focus-window overlay engages)
    { dayOffset: 5, startHour: 9,  startMin: 0,  durationMin: 30,  service: "review",     staff: 0, client: 0,  status: "confirmed", withMeetLink: false },
    { dayOffset: 5, startHour: 10, startMin: 30, durationMin: 45,  service: "pricing",    staff: 1, client: 1,  status: "confirmed", withMeetLink: true  },
    { dayOffset: 5, startHour: 13, startMin: 0,  durationMin: 45,  service: "checkin",    staff: 2, client: 2,  status: "completed", withMeetLink: false },
  ];

  return specs.map((s, idx) => {
    const date = addDays(weekStartDate, s.dayOffset);
    const dateKey = format(date, "yyyy-MM-dd");
    const startLocal = `${dateKey}T${pad(s.startHour)}:${pad(s.startMin)}:00`;
    const startIso = fromZonedTime(startLocal, timezone).toISOString();
    const endIso = addMinutes(new Date(startIso), s.durationMin).toISOString();
    const service = SERVICES[s.service];
    const staff = STAFF[s.staff];
    const client = CLIENTS[s.client % CLIENTS.length];
    return {
      id: `demo-${idx}-${dateKey}`,
      startAt: startIso,
      endAt: endIso,
      status: s.status,
      serviceId: service.id,
      serviceName: service.name,
      serviceColor: null,
      staffId: staff.id,
      staffName: staff.name,
      clientName: client.name,
      clientEmail: client.email,
      meetLink: s.withMeetLink ? "https://meet.google.com/sample-preview" : null,
      isDemo: true,
    };
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
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
