"use client";

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

import AppointmentDrawer, { type DrawerBooking } from "@/components/dashboard/AppointmentDrawer";
import Filters, { FilterPills, type FilterDef, type FilterState } from "@/components/dashboard/Filters";
import { STATUS_EVENT, STATUS_DOT, type Status, STATUS_LABEL } from "@/lib/status-colors";
import { toast } from "@/components/ui/primitives";

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
};

const VIEWS = ["day", "week", "month", "agenda"] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = { day: "Day", week: "Week", month: "Month", agenda: "Agenda" };

const DAY_START_HOUR = 7;   // 7 AM
const DAY_END_HOUR = 21;    // 9 PM
const PX_PER_HOUR = 56;     // visual scale

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
        key: "status", label: "Status", options: (["confirmed", "pending", "completed", "cancelled", "no_show"] as Status[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
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

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[260px,1fr]">
      {/* Left rail: mini-calendar + filters */}
      <aside className="space-y-4">
        <MiniCalendar
          anchor={anchor}
          onPick={(d) => setAnchor(startOfDay(d))}
          byDay={byDay}
          timezone={timezone}
        />
        <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Filters</div>
          <Filters defs={filterDefs} value={filters} onChange={setFilters} />
          <FilterPills defs={filterDefs} value={filters} onChange={setFilters} />
        </div>
      </aside>

      {/* Main calendar */}
      <div className="min-w-0 rounded-xl border border-border bg-surface shadow-xs">
        <Toolbar
          view={view}
          onView={setView}
          label={headerLabel()}
          onPrev={() => shift(-1)}
          onNext={() => shift(1)}
          onToday={() => setAnchor(startOfDay(new Date()))}
          timezone={timezone}
        />

        {view === "day"    && <DayView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onReschedule={canManage ? attemptReschedule : undefined} />}
        {view === "week"   && <WeekView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onReschedule={canManage ? attemptReschedule : undefined} />}
        {view === "month"  && <MonthView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} onJump={(d) => { setAnchor(startOfDay(d)); setView("day"); }} />}
        {view === "agenda" && <AgendaView anchor={anchor} timezone={timezone} byDay={byDay} onOpen={openBooking} />}
      </div>

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
    </div>
  );
}

// ─── Toolbar ─────────────────────────────────────────────────────────────

function Toolbar({
  view, onView, label, onPrev, onNext, onToday, timezone,
}: {
  view: View; onView: (v: View) => void;
  label: string; onPrev: () => void; onNext: () => void; onToday: () => void;
  timezone: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <button onClick={onPrev} aria-label="Previous" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink-muted hover:bg-surface-inset hover:text-ink">‹</button>
        <button onClick={onToday} className="rounded-md border border-border bg-surface px-3 py-1 text-sm text-ink hover:bg-surface-inset">Today</button>
        <button onClick={onNext} aria-label="Next" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-ink-muted hover:bg-surface-inset hover:text-ink">›</button>
        <span className="ml-3 text-sm font-medium text-ink">{label}</span>
        <span className="ml-2 hidden text-xs text-ink-subtle sm:inline">{timezone}</span>
      </div>
      <div className="flex overflow-hidden rounded-md border border-border">
        {VIEWS.map((v) => (
          <button
            key={v}
            onClick={() => onView(v)}
            className={
              "px-3 py-1 text-xs " +
              (v === view ? "bg-brand-accent text-white" : "bg-surface text-ink-muted hover:bg-surface-inset hover:text-ink")
            }
            aria-pressed={v === view}
          >
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Mini Calendar ───────────────────────────────────────────────────────

function MiniCalendar({
  anchor, onPick, byDay, timezone,
}: {
  anchor: Date; onPick: (d: Date) => void;
  byDay: Map<string, CalendarBooking[]>; timezone: string;
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
    <div className="rounded-xl border border-border bg-surface p-3 shadow-xs">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => setMonth((m) => subMonths(m, 1))} aria-label="Previous month" className="rounded p-1 text-ink-muted hover:bg-surface-inset hover:text-ink">‹</button>
        <div className="text-sm font-medium text-ink">{format(month, "MMMM yyyy")}</div>
        <button onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month" className="rounded p-1 text-ink-muted hover:bg-surface-inset hover:text-ink">›</button>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[10px] text-ink-subtle">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5">
        {days.map((d) => {
          const inMonth = isSameMonth(d, month);
          const isAnchor = isSameDay(d, anchor);
          const isToday = isSameDay(d, new Date());
          const has = byDay.get(format(d, "yyyy-MM-dd"))?.length ?? 0;
          return (
            <button
              key={d.toISOString()}
              onClick={() => onPick(d)}
              className={
                "relative flex h-7 items-center justify-center rounded text-xs transition " +
                (isAnchor
                  ? "bg-brand-accent text-white"
                  : isToday
                    ? "bg-brand-subtle text-brand-accent"
                    : inMonth
                      ? "text-ink hover:bg-surface-inset"
                      : "text-ink-subtle hover:bg-surface-inset")
              }
              aria-label={`Go to ${format(d, "EEEE MMM d")}`}
            >
              {format(d, "d")}
              {has > 0 && !isAnchor && (
                <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-brand-accent" aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Day View ────────────────────────────────────────────────────────────

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

  return (
    <div className="relative">
      <div className="grid grid-cols-[64px,1fr]">
        <TimeGutter />
        <DayColumn
          dateKey={key}
          bookings={list}
          timezone={timezone}
          onOpen={onOpen}
          onReschedule={onReschedule}
        />
      </div>
      {isSameDay(anchor, new Date()) && <CurrentTimeLine timezone={timezone} />}
    </div>
  );
}

// ─── Week View ───────────────────────────────────────────────────────────

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
    <div className="relative">
      <div className="sticky top-0 z-10 grid grid-cols-[64px,repeat(7,minmax(0,1fr))] border-b border-border bg-surface">
        <div />
        {days.map((d) => {
          const today = isSameDay(d, new Date());
          return (
            <div key={d.toISOString()} className="border-l border-border px-2 py-2 text-center">
              <div className="text-[10px] uppercase tracking-wider text-ink-subtle">{format(d, "EEE")}</div>
              <div className={"text-sm font-medium " + (today ? "text-brand-accent" : "text-ink")}>{format(d, "d")}</div>
            </div>
          );
        })}
      </div>
      <div className="relative">
        <div className="grid grid-cols-[64px,repeat(7,minmax(0,1fr))]">
          <TimeGutter />
          {days.map((d) => {
            const key = format(d, "yyyy-MM-dd");
            return (
              <DayColumn
                key={key}
                dateKey={key}
                bookings={byDay.get(key) ?? []}
                timezone={timezone}
                onOpen={onOpen}
                onReschedule={onReschedule}
              />
            );
          })}
        </div>
        {days.some((d) => isSameDay(d, new Date())) && <CurrentTimeLine timezone={timezone} />}
      </div>
    </div>
  );
}

// ─── Day Column (shared between Day + Week) ─────────────────────────────

function DayColumn({
  dateKey, bookings, timezone, onOpen, onReschedule,
}: {
  dateKey: string;
  bookings: CalendarBooking[];
  timezone: string;
  onOpen: (b: CalendarBooking) => void;
  onReschedule?: (id: string, newStartIso: string) => void;
}) {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const colHeight = totalHours * PX_PER_HOUR;

  function eventStyle(b: CalendarBooking): React.CSSProperties {
    const localStartLabel = formatInTimeZone(b.startAt, timezone, "HH:mm");
    const localEndLabel = formatInTimeZone(b.endAt, timezone, "HH:mm");
    const [sh, sm] = localStartLabel.split(":").map(Number);
    const [eh, em] = localEndLabel.split(":").map(Number);
    const startMin = Math.max(0, (sh - DAY_START_HOUR) * 60 + sm);
    const endMin = Math.min(totalHours * 60, (eh - DAY_START_HOUR) * 60 + em);
    const top = (startMin / 60) * PX_PER_HOUR;
    const height = Math.max(20, ((endMin - startMin) / 60) * PX_PER_HOUR - 2);
    return { top, height, position: "absolute", left: 4, right: 4 };
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!onReschedule) return;
    e.preventDefault();
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

  return (
    <div
      className="relative border-l border-border"
      style={{ height: colHeight }}
      onDragOver={(e) => onReschedule && e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Hour grid background */}
      {Array.from({ length: totalHours }).map((_, i) => (
        <div
          key={i}
          className="absolute left-0 right-0 border-t border-border/60"
          style={{ top: i * PX_PER_HOUR }}
        />
      ))}
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
  return (
    <button
      onClick={onOpen}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/booking-id", booking.id)}
      className={
        "group flex flex-col items-start overflow-hidden rounded-md border-l-2 px-2 py-1 text-left text-[11px] shadow-xs transition " +
        STATUS_EVENT[booking.status] +
        " hover:shadow-md " +
        (draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer")
      }
      style={style}
      aria-label={`${booking.serviceName} with ${booking.clientName}`}
      title={`${booking.serviceName} · ${booking.clientName}`}
    >
      <div className="truncate font-medium">
        {formatInTimeZone(booking.startAt, timezone, "h:mm a")} {booking.serviceName}
      </div>
      <div className="truncate opacity-80">{booking.clientName}</div>
    </button>
  );
}

// ─── Time Gutter (left labels) ──────────────────────────────────────────

function TimeGutter() {
  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  return (
    <div className="relative" style={{ height: totalHours * PX_PER_HOUR }}>
      {Array.from({ length: totalHours }).map((_, i) => {
        const hour = DAY_START_HOUR + i;
        const label = hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
        return (
          <div
            key={i}
            className="absolute right-2 -translate-y-1/2 text-[10px] text-ink-subtle"
            style={{ top: i * PX_PER_HOUR }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}

// ─── Current Time indicator ─────────────────────────────────────────────

function CurrentTimeLine({ timezone }: { timezone: string }) {
  const [now, setNow] = React.useState(new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const local = formatInTimeZone(now, timezone, "HH:mm");
  const [h, m] = local.split(":").map(Number);
  if (h < DAY_START_HOUR || h >= DAY_END_HOUR) return null;
  const top = ((h - DAY_START_HOUR) * 60 + m) / 60 * PX_PER_HOUR;
  return (
    <div
      className="pointer-events-none absolute left-16 right-0 z-20 flex items-center"
      style={{ top }}
      aria-label="Current time"
    >
      <div className="-ml-1 h-2 w-2 rounded-full bg-red-500" />
      <div className="h-px flex-1 bg-red-500/70" />
    </div>
  );
}

// ─── Month View ─────────────────────────────────────────────────────────

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
    <div className="overflow-hidden rounded-b-xl">
      <div className="grid grid-cols-7 border-b border-border bg-surface-subtle text-[10px] uppercase tracking-wider text-ink-subtle">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="px-2 py-2">{d}</div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7 border-b border-border last:border-b-0">
          {week.map((d) => {
            const key = format(d, "yyyy-MM-dd");
            const list = byDay.get(key) ?? [];
            const outside = !isSameMonth(d, anchor);
            const today = isSameDay(d, new Date());
            return (
              <div
                key={key}
                className={
                  "min-h-[110px] cursor-pointer border-r border-border p-1.5 last:border-r-0 " +
                  (outside ? "bg-surface-subtle/40 text-ink-subtle " : "bg-surface ") +
                  (today ? "ring-1 ring-inset ring-brand-accent " : "")
                }
                onClick={() => onJump(d)}
              >
                <div className={"text-xs font-medium " + (today ? "text-brand-accent" : "")}>{format(d, "d")}</div>
                <div className="mt-1 space-y-0.5">
                  {list.slice(0, 3).map((b) => (
                    <button
                      key={b.id}
                      onClick={(e) => { e.stopPropagation(); onOpen(b); }}
                      className={"flex w-full items-center gap-1 truncate rounded-sm border-l-2 px-1 py-0.5 text-left text-[10px] " + STATUS_EVENT[b.status]}
                    >
                      <span className="font-medium">{formatInTimeZone(b.startAt, timezone, "h:mma")}</span>
                      <span className="truncate">{b.serviceName}</span>
                    </button>
                  ))}
                  {list.length > 3 && <div className="text-[10px] text-ink-subtle">+{list.length - 3} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Agenda View ────────────────────────────────────────────────────────

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
    <div className="divide-y divide-border">
      {days.map((d) => {
        const key = format(d, "yyyy-MM-dd");
        const list = byDay.get(key) ?? [];
        return (
          <div key={key} className="grid grid-cols-[120px,1fr] gap-3 px-4 py-3">
            <div className="text-xs">
              <div className="font-medium text-ink">{format(d, "EEE")}</div>
              <div className="text-ink-muted">{format(d, "MMM d")}</div>
            </div>
            <div className="space-y-1.5">
              {list.length === 0 && <div className="text-xs text-ink-subtle">—</div>}
              {list.map((b) => (
                <button
                  key={b.id}
                  onClick={() => onOpen(b)}
                  className={"flex w-full items-center gap-3 rounded-md border-l-2 px-3 py-2 text-left text-sm transition hover:shadow-md " + STATUS_EVENT[b.status]}
                >
                  <span className={"h-1.5 w-1.5 rounded-full " + STATUS_DOT[b.status]} aria-hidden />
                  <span className="w-28 text-xs font-medium">
                    {formatInTimeZone(b.startAt, timezone, "h:mm a")} – {formatInTimeZone(b.endAt, timezone, "h:mm a")}
                  </span>
                  <span className="flex-1 truncate font-medium">{b.serviceName}</span>
                  <span className="truncate text-xs opacity-80">{b.clientName}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function unique<K, V>(rows: readonly (readonly [K, V])[]): [K, V][] {
  const seen = new Map<K, V>();
  for (const [k, v] of rows) if (!seen.has(k)) seen.set(k, v);
  return Array.from(seen.entries());
}
