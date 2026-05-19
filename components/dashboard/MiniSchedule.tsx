/**
 * MiniSchedule — compact agenda preview rendered in the hero footer.
 *
 * Server component. Shows the next 4 confirmed bookings starting today
 * as time-pill cards laid out horizontally. Each card displays:
 *   - start time (in caller timezone)
 *   - service name
 *   - customer first name
 *   - duration badge
 *
 * Premium empty state when no bookings: "You're clear today" with a
 * subtle "Schedule a focus block" suggestion.
 */
import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarClock, Video, Clock4, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

type Row = {
  id: string;
  startAt: Date;
  endAt: Date;
  clientName: string;
  serviceName: string;
  meetLink: string | null;
};

export default function MiniSchedule(props: {
  rows: Row[];
  timezone: string;
}) {
  if (props.rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-brand-accent/15 bg-brand-subtle text-brand-accent">
            <Sparkles className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-ink">You&rsquo;re clear today</div>
            <div className="text-[11px] text-ink-muted">
              Great time to prep, follow up with customers, or block focus time.
            </div>
          </div>
        </div>
        <Link
          href="/dashboard/availability/overrides"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface/70 px-3 text-[12px] font-medium text-ink-muted backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:bg-surface hover:text-ink hover:shadow-soft"
        >
          <Clock4 className="h-3.5 w-3.5" strokeWidth={1.75} />
          Block focus time
        </Link>
      </div>
    );
  }

  const visible = props.rows.slice(0, 4);
  const remaining = props.rows.length - visible.length;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Today&rsquo;s schedule
          </span>
        </div>
        <Link
          href="/dashboard/calendar"
          className="text-[11px] font-medium text-brand-accent transition-colors hover:text-brand-hover"
        >
          Open calendar →
        </Link>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {visible.map((r, i) => (
          <ScheduleCard
            key={r.id}
            row={r}
            timezone={props.timezone}
            isNext={i === 0}
          />
        ))}
        {remaining > 0 && (
          <Link
            href="/dashboard/calendar"
            className="group flex items-center justify-center rounded-xl border border-dashed border-border bg-surface/60 px-3 py-3 text-[11px] font-medium text-ink-muted transition-all hover:border-border-strong hover:bg-surface hover:text-ink"
          >
            +{remaining} more today
          </Link>
        )}
      </div>
    </div>
  );
}

function ScheduleCard({
  row,
  timezone,
  isNext,
}: {
  row: Row;
  timezone: string;
  isNext: boolean;
}) {
  const startStr = formatInTimeZone(row.startAt, timezone, "h:mm a");
  const durationMin = Math.max(0, Math.round((row.endAt.getTime() - row.startAt.getTime()) / 60_000));
  const customer = firstName(row.clientName);

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-surface px-3 py-2.5 transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:shadow-soft",
        isNext
          ? "border-brand-accent/30 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface ring-1 ring-brand-accent/10"
          : "border-border hover:border-border-strong"
      )}
    >
      {isNext && (
        <div className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-brand-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-soft">
          <span className="h-1 w-1 rounded-full bg-white" />
          Next
        </div>
      )}
      <div className="flex items-baseline gap-1.5 text-[11px]">
        <span className={cn("font-semibold tabular-nums", isNext ? "text-brand-accent" : "text-ink")}>
          {startStr}
        </span>
        <span className="text-ink-subtle">·</span>
        <span className="text-ink-subtle">{durationMin}m</span>
      </div>
      <div className="mt-1 truncate text-[12px] font-semibold text-ink">{row.serviceName}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="truncate text-[11px] text-ink-muted">with {customer}</span>
        {row.meetLink && (
          <Video
            className="h-3 w-3 shrink-0 text-ink-subtle group-hover:text-brand-accent"
            strokeWidth={1.75}
          />
        )}
      </div>
    </div>
  );
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
