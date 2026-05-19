/**
 * DashboardHero — premium greeting + AI insight + quick actions row.
 *
 * Server component. No client JS — all conditional logic resolves at
 * render time. The greeting picks a time-of-day appropriate phrase
 * from the user's timezone.
 */
import Link from "next/link";
import {
  CalendarPlus,
  UserPlus,
  Clock4,
  Sparkles,
  ArrowRight,
  Plug,
} from "lucide-react";

export default function DashboardHero(props: {
  userName: string;
  userRole: string;
  tenantName: string;
  timezone: string;
  todayCount: number;
  weekCount: number;
  utilizationPct: number;
  showGoogleConnect: boolean;
}) {
  const greeting = greetingFor(new Date(), props.timezone);
  const todayCopy =
    props.todayCount === 0
      ? "No bookings scheduled today."
      : props.todayCount === 1
        ? "1 booking scheduled today."
        : `${props.todayCount} bookings scheduled today.`;

  const aiInsight = deriveInsight({
    today: props.todayCount,
    week: props.weekCount,
    utilization: props.utilizationPct,
  });

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6 shadow-xs sm:p-8">
      {/* Soft brand glow in the corner */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gradient-to-br from-brand-subtle to-transparent blur-3xl"
      />

      <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            {props.tenantName}
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">
            {greeting}, {firstName(props.userName)}
          </h2>
          <p className="mt-1.5 text-[14px] text-ink-muted">
            {todayCopy}{" "}
            <span className="text-ink-subtle">·</span>{" "}
            <span className="text-ink-muted">{formatDate(new Date(), props.timezone)}</span>
          </p>

          {aiInsight && (
            <div className="mt-5 inline-flex max-w-2xl items-start gap-3 rounded-xl border border-brand-accent/20 bg-gradient-to-br from-brand-subtle/60 to-transparent px-4 py-3 text-[13px]">
              <Sparkles
                className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent"
                strokeWidth={1.75}
              />
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-accent">
                  AI Insight
                </div>
                <p className="mt-0.5 text-ink">{aiInsight}</p>
              </div>
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2 lg:flex-nowrap">
          <QuickAction href="/dashboard/calendar" icon={CalendarPlus} label="New booking" primary />
          <QuickAction href="/dashboard/customers" icon={UserPlus} label="Add customer" />
          <QuickAction href="/dashboard/availability/overrides" icon={Clock4} label="Block time" />
          {props.showGoogleConnect && (
            <QuickAction href="/api/google/connect" icon={Plug} label="Connect Google" />
          )}
        </div>
      </div>
    </section>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  primary,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        "group inline-flex h-10 items-center gap-2 rounded-lg px-3.5 text-[13px] font-medium transition-all duration-150 " +
        (primary
          ? "bg-brand-accent text-white shadow-sm hover:bg-brand-hover hover:shadow"
          : "border border-border bg-surface text-ink-muted hover:border-border-strong hover:bg-surface-inset hover:text-ink")
      }
    >
      <Icon
        className={
          "h-4 w-4 transition-transform group-hover:scale-105 " +
          (primary ? "text-white" : "text-ink-subtle group-hover:text-ink")
        }
        strokeWidth={1.75}
      />
      <span>{label}</span>
      {primary && (
        <ArrowRight
          className="h-3.5 w-3.5 text-white/80 transition-transform group-hover:translate-x-0.5"
          strokeWidth={2}
        />
      )}
    </Link>
  );
}

// ─── Pure helpers ────────────────────────────────────────────────────

function firstName(full: string): string {
  return full.split(" ")[0] ?? full;
}

function greetingFor(now: Date, timezone: string): string {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(now)
    );
    if (hour < 5) return "Working late";
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    if (hour < 21) return "Good evening";
    return "Hello";
  } catch {
    return "Hello";
  }
}

function formatDate(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: timezone,
    }).format(now);
  } catch {
    return now.toDateString();
  }
}

function deriveInsight(args: { today: number; week: number; utilization: number }): string | null {
  // Deterministic insight derivation — never AI text, always rules.
  if (args.today === 0 && args.week === 0) {
    return "You don't have any bookings this week. Share your booking page to start filling your calendar.";
  }
  if (args.today === 0 && args.week > 0) {
    return `Quiet day ahead. ${args.week} booking${args.week === 1 ? "" : "s"} this week — use the open time for prep or outreach.`;
  }
  if (args.utilization >= 80) {
    return `${args.utilization}% utilization this week — consider opening more availability or adding staff to absorb demand.`;
  }
  if (args.utilization >= 50) {
    return `${args.utilization}% utilization is a healthy week. Keep an eye on no-shows to protect revenue.`;
  }
  if (args.utilization > 0 && args.utilization < 30) {
    return `Utilization is ${args.utilization}%. Promoting your booking page or running a follow-up campaign could fill open slots.`;
  }
  return null;
}
