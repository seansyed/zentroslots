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
import { formatInTimeZone } from "date-fns-tz";
import {
  Video,
  Clock,
  Sparkles,
  CalendarPlus,
  Link as LinkIcon,
  Plug,
} from "lucide-react";

import AppointmentDrawer, { type DrawerBooking } from "@/components/dashboard/AppointmentDrawer";
import { STATUS_BADGE, STATUS_LABEL, type Status } from "@/lib/status-colors";
import { Avatar } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import SegmentedControl from "@/components/ui/SegmentedControl";
import MiniDateStrip from "@/components/ui/MiniDateStrip";
import { EmptyState, PremiumCard, SectionHeader } from "@/components/ui/Card";

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
  React.useEffect(() => setRows(initialRows), [initialRows]);
  const [drawer, setDrawer] = React.useState<DrawerBooking | null>(null);

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

  return (
    <div className="mt-6">
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
            {grouped.map((g) => (
              <DateSection
                key={g.dateKey}
                dateKey={g.dateKey}
                dateLabel={g.dateLabel}
                relativeLabel={g.relativeLabel}
                rows={g.rows}
                timezone={timezone}
                onOpen={openRow}
              />
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
}: {
  dateKey: string;
  dateLabel: string;
  relativeLabel: string | null;
  rows: Row[];
  timezone: string;
  onOpen: (r: Row) => void;
}) {
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
                ? "bg-brand-accent text-white"
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
        {rows.map((r) => (
          <li key={r.id}>
            <AppointmentCard row={r} timezone={timezone} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </section>
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

  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className={cn(
        "group relative w-full overflow-hidden rounded-2xl border bg-surface px-4 py-3.5 text-left shadow-soft transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
        isHighlighted
          ? "border-brand-accent/20 bg-gradient-to-br from-brand-subtle/20 via-surface to-surface"
          : "border-border"
      )}
    >
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
                <h4 className="truncate text-[14px] font-semibold tracking-tight text-ink">
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
            </div>

            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                STATUS_BADGE[row.status]
              )}
            >
              {STATUS_LABEL[row.status]}
            </span>
          </div>
        </div>
      </div>
    </button>
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
