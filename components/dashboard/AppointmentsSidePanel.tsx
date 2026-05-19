/**
 * AppointmentsSidePanel — productivity assistant on /dashboard/appointments.
 *
 * Server component. Three stacked cards derived purely from the visible
 * rows (no extra DB query):
 *   1. Schedule health  — today / next-7 / no-show signals as compact
 *      stat tiles + one rules-derived insight
 *   2. Next up           — the next upcoming confirmed booking with a
 *      countdown and meet link if present
 *   3. Follow-ups needed — confirmed past-end bookings still marked
 *      "confirmed" (need to be moved to completed or no-show)
 */
import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import {
  Activity,
  Clock4,
  Video,
  Sparkles,
  AlertCircle,
  ArrowRight,
} from "lucide-react";

import { PremiumCard, SectionHeader, InsightCard, EmptyState } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

export type SidePanelRow = {
  id: string;
  startAt: string;
  endAt: string;
  status:
    | "pending"
    | "confirmed"
    | "cancelled"
    | "completed"
    | "no_show"
    | "pending_payment"
    | "payment_failed"
    | "refunded";
  clientName: string;
  serviceName: string;
  meetLink: string | null;
};

export default function AppointmentsSidePanel({
  rows,
  timezone,
}: {
  rows: SidePanelRow[];
  timezone: string;
}) {
  const now = Date.now();
  const in7Days = now + 7 * 24 * 60 * 60_000;
  const last30Days = now - 30 * 24 * 60 * 60_000;

  const todayCount = rows.filter(
    (r) =>
      r.status === "confirmed" &&
      formatInTimeZone(r.startAt, timezone, "yyyy-MM-dd") ===
        formatInTimeZone(new Date(), timezone, "yyyy-MM-dd")
  ).length;

  const next7Count = rows.filter(
    (r) =>
      r.status === "confirmed" &&
      new Date(r.startAt).getTime() >= now &&
      new Date(r.startAt).getTime() <= in7Days
  ).length;

  const noShow30 = rows.filter(
    (r) => r.status === "no_show" && new Date(r.startAt).getTime() >= last30Days
  ).length;

  const nextUpcoming = rows
    .filter((r) => r.status === "confirmed" && new Date(r.startAt).getTime() >= now)
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())[0];

  const followups = rows.filter(
    (r) => r.status === "confirmed" && new Date(r.endAt).getTime() < now
  );

  const insight = deriveInsight({ today: todayCount, next7: next7Count, noShow30 });

  return (
    <aside className="space-y-5">
      {/* ── Schedule health ─────────────────────────────────────── */}
      <PremiumCard compact>
        <SectionHeader
          eyebrow="Pulse"
          title="Schedule health"
          href="/dashboard/analytics"
          hrefLabel="Analytics"
        />
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Today" value={todayCount} tone={todayCount > 0 ? "positive" : "neutral"} />
          <Stat label="Next 7d" value={next7Count} tone="brand" />
          <Stat label="No-shows" value={noShow30} tone={noShow30 > 2 ? "warning" : "neutral"} />
        </div>
        {insight && (
          <div className="mt-3">
            <InsightCard title="Schedule signal">{insight}</InsightCard>
          </div>
        )}
      </PremiumCard>

      {/* ── Next up ───────────────────────────────────────────── */}
      <PremiumCard compact>
        <SectionHeader title="Next up" />
        {nextUpcoming ? (
          <NextUp row={nextUpcoming} timezone={timezone} />
        ) : (
          <EmptyState
            icon={Sparkles}
            title="Clear ahead"
            body="No upcoming confirmed bookings. A good window for outreach."
          />
        )}
      </PremiumCard>

      {/* ── Follow-ups needed ──────────────────────────────────── */}
      <PremiumCard compact>
        <SectionHeader
          title="Follow-ups needed"
          description="Past appointments still marked as confirmed"
        />
        {followups.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="All accounted for"
            body="Every past booking has been resolved. Nice."
          />
        ) : (
          <ul className="-mx-1 divide-y divide-border/50">
            {followups.slice(0, 5).map((r) => (
              <li
                key={r.id}
                className="flex items-start gap-2.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-inset/60"
              >
                <div className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                  <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-ink">{r.serviceName}</div>
                  <div className="mt-0.5 text-[10px] text-ink-muted">
                    {formatInTimeZone(r.startAt, timezone, "MMM d, h:mm a")} · {firstName(r.clientName)}
                  </div>
                </div>
              </li>
            ))}
            {followups.length > 5 && (
              <li className="px-2 py-1.5 text-[11px] text-ink-subtle">
                +{followups.length - 5} more to resolve
              </li>
            )}
          </ul>
        )}
      </PremiumCard>
    </aside>
  );
}

// ─── Next-up card ───────────────────────────────────────────────────

function NextUp({ row, timezone }: { row: SidePanelRow; timezone: string }) {
  const startMs = new Date(row.startAt).getTime();
  const diffMin = Math.max(0, Math.round((startMs - Date.now()) / 60_000));
  const inWord =
    diffMin === 0
      ? "Starting now"
      : diffMin < 60
        ? `in ${diffMin}m`
        : diffMin < 60 * 24
          ? `in ${Math.round(diffMin / 60)}h`
          : `in ${Math.round(diffMin / 60 / 24)}d`;

  return (
    <div className="rounded-xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-accent">
          {inWord}
        </span>
        <span className="text-[10px] tabular-nums text-ink-subtle">
          {formatInTimeZone(row.startAt, timezone, "EEE, MMM d · h:mm a")}
        </span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold text-ink">{row.serviceName}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
        <Clock4 className="h-3 w-3" strokeWidth={1.75} />
        with {firstName(row.clientName)}
      </div>
      {row.meetLink && (
        <a
          href={row.meetLink}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[11px] font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow"
        >
          <Video className="h-3.5 w-3.5" strokeWidth={1.75} />
          Join meeting
          <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
        </a>
      )}
    </div>
  );
}

// ─── Stat tile ──────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "positive" | "warning" | "neutral" | "brand";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600"
      : tone === "warning"
        ? "text-amber-600"
        : tone === "brand"
          ? "text-brand-accent"
          : "text-ink";
  return (
    <div className="rounded-xl border border-border bg-surface-subtle p-3 transition-colors">
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className={cn("mt-1 text-[20px] font-semibold leading-none tabular-nums", toneClass)}>
        {value}
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

function deriveInsight(args: {
  today: number;
  next7: number;
  noShow30: number;
}): string | null {
  if (args.today === 0 && args.next7 === 0) {
    return "Your week is open. Sharing your booking page in a quick email is the fastest way to fill it.";
  }
  if (args.today >= 4) {
    return `${args.today} bookings today — a focused day. Consider buffer time between meetings.`;
  }
  if (args.noShow30 >= 3) {
    return `${args.noShow30} no-shows in the last 30 days. Reminder emails 24h + 1h before tend to cut this in half.`;
  }
  if (args.next7 >= 10) {
    return `${args.next7} confirmed in the next 7 days — strong week. Make sure your calendar sync is healthy.`;
  }
  return null;
}
