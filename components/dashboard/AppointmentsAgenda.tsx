"use client";

/**
 * AppointmentsAgenda — premium scheduling workspace (Phase 3).
 *
 * Replaces the old AppointmentsTable with an agenda-timeline UI:
 *   - Segmented control for status filtering (animated indicator)
 *   - Mini date strip for visual context (purely UI — doesn't refetch)
 *   - Bookings grouped by date with sticky date headers
 *   - Each booking is a rich AppointmentCard (avatar, time, duration,
 *     service, staff, meet icon, status, notes preview)
 *   - Tap a card → existing AppointmentDrawer slide-over (untouched)
 *   - Premium scheduling empty state
 *
 * Preserves: AppointmentDrawer behavior, cursor-based pagination, the
 * Row data shape, the `?status=` URL param contract.
 */
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addDays, addMinutes, startOfWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  Video,
  Clock,
  Sparkles,
  CalendarPlus,
  Link as LinkIcon,
  Plug,
  ExternalLink,
  ArrowRight,
  X,
} from "lucide-react";

import AppointmentDrawer, { type DrawerBooking } from "@/components/dashboard/AppointmentDrawer";
import { STATUS_BADGE, STATUS_DOT, STATUS_LABEL, type Status } from "@/lib/status-colors";
import { Avatar, toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import SegmentedControl from "@/components/ui/SegmentedControl";
import MiniDateStrip from "@/components/ui/MiniDateStrip";
import { EmptyState, PremiumCard, SectionHeader } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";

export type Row = {
  id: string;
  startAt: string;
  endAt: string;
  status: Status;
  clientName: string;
  clientEmail: string;
  meetLink: string | null;
  notes: string | null;
  serviceId: string;
  serviceName: string;
  staffId: string;
  staffName: string;
  /** Set only by the client when a tenant has no real bookings and the
   *  preview schedule is rendered to keep the page alive. Server never
   *  emits this. Demo rows never open the drawer. */
  isDemo?: boolean;
};

const STATUS_TABS = [
  { value: "",          label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "pending",   label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show",   label: "No-show" },
];

export default function AppointmentsAgenda({
  rows: initialRows,
  timezone,
  canManage,
  canCancel,
  currentStatus,
  nextCursor,
}: {
  rows: Row[];
  timezone: string;
  canManage: boolean;
  canCancel?: boolean;
  currentStatus: string;
  nextCursor: string | null;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [rows, setRows] = React.useState(initialRows);
  const [drawer, setDrawer] = React.useState<DrawerBooking | null>(null);

  // Demo population: when a tenant has no real bookings and isn't
  // filtering, the page fills with a realistic preview timeline so the
  // entire premium agenda surface feels actively used. Mode flips off
  // automatically the moment a real booking arrives.
  const [demoHidden, setDemoHidden] = React.useState(false);
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem("appointments_demo_hidden") === "1") {
      setDemoHidden(true);
    }
  }, []);
  const isDemoActive = initialRows.length === 0 && !currentStatus && !demoHidden;
  React.useEffect(() => {
    if (isDemoActive) {
      setRows(buildDemoAppointments(new Date(), timezone));
    } else {
      setRows(initialRows);
    }
  }, [initialRows, isDemoActive, timezone]);

  function dismissDemo() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("appointments_demo_hidden", "1");
    }
    setDemoHidden(true);
  }

  function setStatusFilter(s: string) {
    const url = new URL(window.location.href);
    if (s) url.searchParams.set("status", s);
    else url.searchParams.delete("status");
    url.searchParams.delete("cursor");
    router.push(url.pathname + (url.search || ""));
  }

  function goNext() {
    if (!nextCursor) return;
    const url = new URL(window.location.href);
    url.searchParams.set("cursor", nextCursor);
    router.push(url.pathname + url.search);
  }

  function goFirst() {
    const url = new URL(window.location.href);
    url.searchParams.delete("cursor");
    router.push(url.pathname + (url.search || ""));
  }

  function openRow(r: Row) {
    if (r.isDemo) {
      toast(
        "Preview · Sample appointment. Real bookings open the full detail drawer.",
        "info",
      );
      return;
    }
    setDrawer({
      id: r.id,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status,
      clientName: r.clientName,
      clientEmail: r.clientEmail,
      notes: r.notes,
      meetLink: r.meetLink,
      serviceName: r.serviceName,
      staffName: r.staffName,
    });
  }

  // Group rows by date key (YYYY-MM-DD in caller timezone).
  const grouped = React.useMemo(() => groupByDate(rows, timezone), [rows, timezone]);
  const datesWithBookings = React.useMemo(
    () => new Set(grouped.map((g) => g.dateKey)),
    [grouped]
  );

  const todayKey = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");

  return (
    <div className="mt-6">
      {isDemoActive && <SampleAppointmentsBanner onDismiss={dismissDemo} />}

      {/* Controls row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          items={STATUS_TABS}
          value={currentStatus}
          onChange={setStatusFilter}
          layoutGroupId="appointments-status"
        />
        <div className="hidden md:block">
          <MiniDateStrip timezone={timezone} datesWithBookings={datesWithBookings} />
        </div>
      </div>

      {/* Mobile date strip */}
      <div className="mt-3 md:hidden">
        <MiniDateStrip timezone={timezone} datesWithBookings={datesWithBookings} />
      </div>

      {/* Agenda */}
      <div className="mt-6">
        {rows.length === 0 ? (
          <EmptyAgenda hasFilter={Boolean(currentStatus)} />
        ) : (
          <div className="space-y-7">
            {grouped.map((g, idx) => (
              <FadeIn key={g.dateKey} delay={idx}>
                <DateSection
                  dateKey={g.dateKey}
                  dateLabel={g.dateLabel}
                  relativeLabel={g.relativeLabel}
                  rows={g.rows}
                  timezone={timezone}
                  onOpen={openRow}
                  isToday={g.dateKey === todayKey}
                />
              </FadeIn>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-6 flex items-center justify-between text-[11px]">
        <div className="text-ink-subtle">{rows.length} shown</div>
        <div className="flex gap-2">
          {sp.get("cursor") && (
            <button
              onClick={goFirst}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[11px] font-medium text-ink-muted transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
            >
              ← Back to start
            </button>
          )}
          {nextCursor && (
            <button
              onClick={goNext}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[11px] font-medium text-ink-muted transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
            >
              Next page →
            </button>
          )}
        </div>
      </div>

      <AppointmentDrawer
        booking={drawer}
        timezone={timezone}
        canManage={canManage}
        canCancel={canCancel !== false}
        onClose={() => setDrawer(null)}
        onChanged={(next) => {
          setDrawer(next);
          setRows((cur) => cur.map((r) => (r.id === next.id ? { ...r, status: next.status } : r)));
        }}
      />
    </div>
  );
}

// ─── Date section ───────────────────────────────────────────────────

function DateSection({
  dateKey,
  dateLabel,
  relativeLabel,
  rows,
  timezone,
  onOpen,
  isToday = false,
}: {
  dateKey: string;
  dateLabel: string;
  relativeLabel: string | null;
  rows: Row[];
  timezone: string;
  onOpen: (r: Row) => void;
  isToday?: boolean;
}) {
  // For today, insert a "Now" marker line between past and upcoming
  // bookings. Computed once per render with a live refresh every minute
  // so the marker drifts naturally through the day.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [isToday]);

  const nowMs = Date.now();
  // Index of the first upcoming booking (start >= now). When all rows
  // are in the past, nowInsertAt === rows.length so the marker sits
  // below the list. When all are upcoming, it sits above.
  const nowInsertAt = isToday
    ? rows.findIndex((r) => new Date(r.startAt).getTime() >= nowMs)
    : -1;

  return (
    <section id={`agenda-${dateKey}`}>
      {/* Sticky date header */}
      <div className="sticky top-16 z-10 -mx-2 mb-3 flex items-baseline gap-2.5 border-b border-border/60 bg-app-bg/80 px-2 py-2 backdrop-blur-md">
        <div className="text-[15px] font-semibold tracking-tight text-ink">{dateLabel}</div>
        {relativeLabel && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              relativeLabel === "Today"
                ? "zm-pulse-glow bg-gradient-to-r from-brand-accent to-brand-hover text-white shadow-[0_3px_10px_rgba(53,157,243,0.32)]"
                : "bg-surface-inset text-ink-subtle"
            )}
          >
            {relativeLabel}
          </span>
        )}
        <span className="ml-1 text-[11px] text-ink-subtle">
          {rows.length} booking{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <ul className="space-y-2.5">
        {isToday && nowInsertAt === 0 && <NowMarker timezone={timezone} />}
        {rows.map((r, idx) => (
          <React.Fragment key={r.id}>
            <li>
              <AppointmentCard row={r} timezone={timezone} onOpen={onOpen} />
            </li>
            {isToday && idx + 1 === nowInsertAt && <NowMarker timezone={timezone} />}
          </React.Fragment>
        ))}
        {/* All-past case: marker below the last row */}
        {isToday && nowInsertAt === -1 && rows.length > 0 && <NowMarker timezone={timezone} />}
      </ul>
    </section>
  );
}

// ─── Now marker ────────────────────────────────────────────────────

function NowMarker({ timezone }: { timezone: string }) {
  const [label, setLabel] = React.useState(() => formatInTimeZone(new Date(), timezone, "h:mm a"));
  React.useEffect(() => {
    const t = setInterval(
      () => setLabel(formatInTimeZone(new Date(), timezone, "h:mm a")),
      60_000,
    );
    return () => clearInterval(t);
  }, [timezone]);
  return (
    <li className="relative flex items-center gap-2.5 px-1" aria-label="Current time" role="separator">
      {/* Pulsing dot */}
      <div className="relative">
        <div className="h-2.5 w-2.5 rounded-full bg-brand-accent shadow-[0_0_8px_rgba(53,157,243,0.55)]" />
        <div className="absolute inset-0 h-2.5 w-2.5 animate-ping rounded-full bg-brand-accent/40" />
      </div>
      {/* Now pill */}
      <span className="zm-pulse-glow inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_10px_rgba(53,157,243,0.3)]">
        <span className="h-1 w-1 rounded-full bg-white/90" />
        Now · {label}
      </span>
      {/* Gradient line trailing right */}
      <div
        className="h-px flex-1 rounded-full"
        style={{
          background:
            "linear-gradient(to right, var(--color-accent, #359df3) 0%, rgba(53,157,243,0.45) 35%, rgba(53,157,243,0) 100%)",
        }}
      />
    </li>
  );
}

// ─── AppointmentCard ────────────────────────────────────────────────

function AppointmentCard({
  row,
  timezone,
  onOpen,
}: {
  row: Row;
  timezone: string;
  onOpen: (r: Row) => void;
}) {
  const start = formatInTimeZone(row.startAt, timezone, "h:mm a");
  const end = formatInTimeZone(row.endAt, timezone, "h:mm a");
  const durationMin = Math.max(
    0,
    Math.round((new Date(row.endAt).getTime() - new Date(row.startAt).getTime()) / 60_000)
  );

  const startsInFuture = new Date(row.startAt).getTime() > Date.now();
  const isHighlighted = row.status === "confirmed" && startsInFuture;
  const isMuted = row.status === "cancelled" || row.status === "refunded";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(row);
        }
      }}
      className={cn(
        "group relative w-full cursor-pointer overflow-hidden rounded-2xl border bg-surface px-4 py-3.5 text-left shadow-soft transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-0.5 hover:scale-[1.004] hover:border-border-strong hover:shadow-lift",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
        isMuted && "opacity-70",
        isHighlighted
          ? "border-brand-accent/20 bg-gradient-to-br from-brand-subtle/20 via-surface to-surface"
          : "border-border",
      )}
    >
      {/* Soft tactile hover halo — brand-tinted ring + glow that fades
          in on hover. Same language as the calendar event card so the
          two surfaces feel like one product. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
        style={{
          boxShadow:
            "0 0 0 1px rgba(53,157,243,0.18), 0 10px 28px rgba(53,157,243,0.10)",
        }}
      />
      {/* Subtle inner top highlight — 1px white hairline that lifts the
          card off the canvas at rest. Disabled on muted rows. */}
      {!isMuted && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
      )}
      {/* Accent rail on the left for confirmed/upcoming */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 rounded-l-2xl transition-colors",
          row.status === "confirmed"
            ? "bg-brand-accent"
            : row.status === "completed"
              ? "bg-emerald-400"
              : row.status === "cancelled"
                ? "bg-slate-300"
                : row.status === "no_show"
                  ? "bg-red-400"
                  : row.status === "pending"
                    ? "bg-amber-400"
                    : "bg-slate-200"
        )}
      />

      <div className="flex items-start gap-4 pl-2">
        {/* Time column */}
        <div className="flex w-20 shrink-0 flex-col items-start pt-0.5">
          <div className={cn(
            "text-[14px] font-semibold leading-none tabular-nums",
            isHighlighted ? "text-brand-accent" : "text-ink"
          )}>
            {start}
          </div>
          <div className="mt-1 text-[10px] tabular-nums text-ink-subtle">
            {end}
          </div>
          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-medium text-ink-muted">
            <Clock className="h-2.5 w-2.5" strokeWidth={2} />
            {durationMin}m
          </div>
        </div>

        {/* Main info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h4 className={cn(
                  "truncate text-[14px] font-semibold tracking-tight",
                  isMuted ? "text-ink-muted line-through" : "text-ink",
                )}>
                  {row.serviceName}
                </h4>
                {row.meetLink && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-subtle px-1.5 py-0.5 text-[9px] font-medium text-brand-accent"
                    title="Video call"
                  >
                    <Video className="h-2.5 w-2.5" strokeWidth={2} />
                    Meet
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Avatar name={row.clientName} size="sm" className="!h-5 !w-5 !text-[9px]" />
                  <span className="truncate font-medium text-ink">{row.clientName}</span>
                </span>
                <span className="text-ink-subtle">·</span>
                <span className="truncate">with {firstName(row.staffName)}</span>
              </div>
              {row.notes && (
                <div className="mt-2 line-clamp-1 text-[11px] text-ink-subtle">
                  <span className="font-medium text-ink-muted">Note:</span> {row.notes}
                </div>
              )}

              {/* Hover-reveal quick actions */}
              <div className="pointer-events-none mt-2.5 flex items-center gap-1.5 opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:pointer-events-auto group-hover:opacity-100">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpen(row); }}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                >
                  <ExternalLink className="h-2.5 w-2.5" strokeWidth={1.75} />
                  Open
                </button>
                {row.meetLink && (
                  <a
                    href={row.meetLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md border border-brand-accent/25 bg-brand-subtle/40 px-2 py-0.5 text-[10px] font-semibold text-brand-accent shadow-soft transition-colors hover:bg-brand-subtle/70"
                  >
                    <Video className="h-2.5 w-2.5" strokeWidth={2} />
                    Join
                    <ArrowRight className="h-2.5 w-2.5" strokeWidth={2.25} />
                  </a>
                )}
              </div>
            </div>

            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                STATUS_BADGE[row.status]
              )}
            >
              <span className={cn("inline-flex h-1.5 w-1.5 rounded-full", STATUS_DOT[row.status])} aria-hidden />
              {STATUS_LABEL[row.status]}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────

function EmptyAgenda({ hasFilter }: { hasFilter: boolean }) {
  if (hasFilter) {
    return (
      <PremiumCard interactive={false}>
        <EmptyState
          icon={Sparkles}
          title="No appointments in this view"
          body="Try a different status filter, or clear the filter to see everything."
        />
      </PremiumCard>
    );
  }
  return (
    <PremiumCard interactive={false}>
      <SectionHeader
        eyebrow="Welcome"
        title="Your calendar is open"
        description="Share your booking page to start accepting meetings."
      />
      <div className="grid gap-2.5 sm:grid-cols-3">
        <EmptyCTA
          icon={CalendarPlus}
          title="Create a booking"
          body="Add a manual booking for a customer."
          href="/dashboard/calendar"
        />
        <EmptyCTA
          icon={LinkIcon}
          title="Share booking page"
          body="Send your /u/... link to clients."
          href="/dashboard/settings/branding"
        />
        <EmptyCTA
          icon={Plug}
          title="Connect calendar"
          body="Sync with Google Calendar."
          href="/dashboard/settings/calendar"
        />
      </div>
    </PremiumCard>
  );
}

function EmptyCTA({
  icon: Icon,
  title,
  body,
  href,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <a
      href={href}
      className="group flex flex-col rounded-xl border border-dashed border-border bg-gradient-to-b from-surface-subtle to-surface px-3 py-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-accent/30 hover:bg-surface hover:shadow-soft"
    >
      <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-subtle text-brand-accent transition-transform duration-200 group-hover:scale-105">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <div className="mt-2.5 text-[13px] font-semibold text-ink">{title}</div>
      <div className="mt-0.5 text-[11px] text-ink-muted">{body}</div>
    </a>
  );
}

// ─── Sample appointments banner + generator ─────────────────────────

function SampleAppointmentsBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="relative mb-5 flex items-center gap-3 rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/55 via-brand-subtle/15 to-transparent px-4 py-3"
      role="status"
    >
      <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-accent text-white shadow-sm">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold tracking-tight text-ink">
          Sample timeline
        </div>
        <div className="mt-0.5 text-[11px] text-ink-muted">
          A preview of how your appointments will look once customers start booking. None of these are real.
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
 * Synthesize a realistic appointments timeline spanning the past 6 days
 * and the next 10 days. Mix of statuses (completed / cancelled /
 * no-show in the past; confirmed / pending ahead) demonstrates every
 * visual treatment without faking any backend state.
 *
 * Rows are returned with `isDemo: true` so openRow() and the rest of
 * the page can opt out of drawer / API actions.
 */
function buildDemoAppointments(now: Date, timezone: string): Row[] {
  const weekStartDate = startOfWeek(now);

  const sid = (s: string) => s.padStart(36, "0");
  const SERVICES = {
    discovery:   { id: sid("svc-discovery"),   name: "Discovery call" },
    onboarding:  { id: sid("svc-onboarding"),  name: "Onboarding session" },
    strategy:    { id: sid("svc-strategy"),    name: "Strategy review" },
    consult:     { id: sid("svc-consult"),     name: "Tax consultation" },
    standup:     { id: sid("svc-standup"),     name: "Team standup" },
    workshop:    { id: sid("svc-workshop"),    name: "Planning workshop" },
    coaching:    { id: sid("svc-coaching"),    name: "1:1 coaching" },
    office:      { id: sid("svc-office"),      name: "Office hours" },
    followup:    { id: sid("svc-followup"),    name: "Follow-up call" },
    demo:        { id: sid("svc-demo"),        name: "Product demo" },
    customer:    { id: sid("svc-customer"),    name: "Customer review" },
    roadmap:     { id: sid("svc-roadmap"),     name: "Roadmap sync" },
    pricing:     { id: sid("svc-pricing"),     name: "Pricing discussion" },
    checkin:     { id: sid("svc-checkin"),     name: "Client check-in" },
    quarterly:   { id: sid("svc-quarterly"),   name: "Quarterly review" },
  };
  const STAFF = [
    { id: sid("staff-sarah"),  name: "Sarah Mitchell" },
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
    { name: "Grace O'Brien",    email: "grace@example.com" },
    { name: "Felix Vargas",     email: "felix@example.com" },
  ];

  type DemoSpec = {
    dayOffset: number; // 0 = Sun, 1 = Mon, ... (within the current week,
                       // ±7 days from weekStartDate as needed)
    startHour: number;
    startMin: number;
    durationMin: number;
    service: keyof typeof SERVICES;
    staff: number;
    client: number;
    status: Status;
    withMeetLink: boolean;
    note?: string;
  };

  // 25 events spread across last week → this week → next week.
  // dayOffset 0..6 = current week; -2..-1 = last week; 7..9 = next week.
  const specs: DemoSpec[] = [
    // ── Last 2 days (completed/cancelled/no-show) ────────────────
    { dayOffset: -2, startHour: 10, startMin: 0,  durationMin: 60,  service: "consult",   staff: 0, client: 0,  status: "completed", withMeetLink: true,  note: "Quarterly tax planning — follow-up email sent." },
    { dayOffset: -2, startHour: 13, startMin: 30, durationMin: 45,  service: "followup",  staff: 1, client: 1,  status: "completed", withMeetLink: false },
    { dayOffset: -2, startHour: 15, startMin: 0,  durationMin: 30,  service: "checkin",   staff: 2, client: 2,  status: "no_show",   withMeetLink: false, note: "No-show. Reminder email sent automatically." },
    { dayOffset: -1, startHour: 9,  startMin: 0,  durationMin: 30,  service: "standup",   staff: 0, client: 3,  status: "completed", withMeetLink: false },
    { dayOffset: -1, startHour: 11, startMin: 0,  durationMin: 60,  service: "strategy",  staff: 1, client: 4,  status: "completed", withMeetLink: true },
    { dayOffset: -1, startHour: 14, startMin: 0,  durationMin: 45,  service: "coaching",  staff: 2, client: 5,  status: "cancelled", withMeetLink: true,  note: "Client requested reschedule." },

    // ── This week (mix) ──────────────────────────────────────────
    { dayOffset: 1,  startHour: 9,  startMin: 0,  durationMin: 45,  service: "discovery",  staff: 0, client: 6,  status: "completed", withMeetLink: true },
    { dayOffset: 1,  startHour: 11, startMin: 0,  durationMin: 60,  service: "onboarding", staff: 1, client: 7,  status: "completed", withMeetLink: true },
    { dayOffset: 1,  startHour: 14, startMin: 0,  durationMin: 90,  service: "workshop",   staff: 0, client: 8,  status: "completed", withMeetLink: true,  note: "Project kickoff. Action items shared." },

    { dayOffset: 2,  startHour: 10, startMin: 0,  durationMin: 60,  service: "consult",    staff: 1, client: 9,  status: "confirmed", withMeetLink: true },
    { dayOffset: 2,  startHour: 13, startMin: 0,  durationMin: 30,  service: "standup",    staff: 0, client: 10, status: "confirmed", withMeetLink: false },
    { dayOffset: 2,  startHour: 15, startMin: 0,  durationMin: 60,  service: "demo",       staff: 2, client: 11, status: "confirmed", withMeetLink: true,  note: "Walking through pricing tiers + integrations." },

    { dayOffset: 3,  startHour: 9,  startMin: 30, durationMin: 45,  service: "coaching",   staff: 1, client: 12, status: "confirmed", withMeetLink: true },
    { dayOffset: 3,  startHour: 11, startMin: 0,  durationMin: 60,  service: "office",     staff: 0, client: 13, status: "pending",   withMeetLink: false },
    { dayOffset: 3,  startHour: 14, startMin: 0,  durationMin: 45,  service: "customer",   staff: 1, client: 14, status: "confirmed", withMeetLink: true },

    { dayOffset: 4,  startHour: 10, startMin: 0,  durationMin: 60,  service: "coaching",   staff: 1, client: 15, status: "confirmed", withMeetLink: true },
    { dayOffset: 4,  startHour: 13, startMin: 30, durationMin: 60,  service: "roadmap",    staff: 0, client: 16, status: "confirmed", withMeetLink: false },

    { dayOffset: 5,  startHour: 9,  startMin: 0,  durationMin: 30,  service: "checkin",    staff: 0, client: 17, status: "confirmed", withMeetLink: false },
    { dayOffset: 5,  startHour: 10, startMin: 30, durationMin: 45,  service: "pricing",    staff: 1, client: 0,  status: "confirmed", withMeetLink: true },
    { dayOffset: 5,  startHour: 13, startMin: 0,  durationMin: 45,  service: "quarterly",  staff: 2, client: 1,  status: "confirmed", withMeetLink: false },

    // ── Next week ────────────────────────────────────────────────
    { dayOffset: 8,  startHour: 10, startMin: 0,  durationMin: 60,  service: "discovery",  staff: 0, client: 2,  status: "confirmed", withMeetLink: true },
    { dayOffset: 8,  startHour: 14, startMin: 0,  durationMin: 45,  service: "consult",    staff: 1, client: 3,  status: "confirmed", withMeetLink: true },
    { dayOffset: 9,  startHour: 11, startMin: 0,  durationMin: 60,  service: "strategy",   staff: 2, client: 4,  status: "confirmed", withMeetLink: true },
    { dayOffset: 9,  startHour: 15, startMin: 0,  durationMin: 30,  service: "followup",   staff: 0, client: 5,  status: "pending",   withMeetLink: false },
  ];

  return specs.map((s, idx) => {
    const date = addDays(weekStartDate, s.dayOffset);
    const dateKey = formatInTimeZone(date, timezone, "yyyy-MM-dd");
    const startLocal = `${dateKey}T${pad(s.startHour)}:${pad(s.startMin)}:00`;
    const startIso = fromZonedTime(startLocal, timezone).toISOString();
    const endIso = addMinutes(new Date(startIso), s.durationMin).toISOString();
    const service = SERVICES[s.service];
    const staff = STAFF[s.staff];
    const client = CLIENTS[s.client % CLIENTS.length];
    return {
      id: `demo-appt-${idx}-${dateKey}`,
      startAt: startIso,
      endAt: endIso,
      status: s.status,
      clientName: client.name,
      clientEmail: client.email,
      meetLink: s.withMeetLink ? "https://meet.google.com/sample-preview" : null,
      notes: s.note ?? null,
      serviceId: service.id,
      serviceName: service.name,
      staffId: staff.id,
      staffName: staff.name,
      isDemo: true,
    };
  });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ─── helpers ────────────────────────────────────────────────────────

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

function groupByDate(
  rows: Row[],
  timezone: string
): Array<{ dateKey: string; dateLabel: string; relativeLabel: string | null; rows: Row[] }> {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const key = formatInTimeZone(r.startAt, timezone, "yyyy-MM-dd");
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  const todayKey = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const yesterdayKey = formatInTimeZone(new Date(Date.now() - 86_400_000), timezone, "yyyy-MM-dd");
  const tomorrowKey = formatInTimeZone(new Date(Date.now() + 86_400_000), timezone, "yyyy-MM-dd");

  return Array.from(map.entries())
    .sort(([a], [b]) => (a > b ? -1 : a < b ? 1 : 0))
    .map(([key, list]) => {
      const sample = new Date(list[0].startAt);
      const label = formatInTimeZone(sample, timezone, "EEEE, MMMM d");
      let relative: string | null = null;
      if (key === todayKey) relative = "Today";
      else if (key === yesterdayKey) relative = "Yesterday";
      else if (key === tomorrowKey) relative = "Tomorrow";
      // Sort within a date by start time ascending.
      list.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
      return { dateKey: key, dateLabel: label, relativeLabel: relative, rows: list };
    });
}
