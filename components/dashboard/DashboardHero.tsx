/**
 * DashboardHero — premium scheduling workspace centerpiece (Phase 2).
 *
 * Server component. Layered glass + soft brand gradient + animated AI
 * badge + larger pill quick-actions. Mini schedule slot (optional)
 * lives in the footer of the hero so the user sees today's day in one
 * glance without scrolling.
 *
 * Insight derivation is rules-based (deterministic) — never fake AI.
 */
import Link from "next/link";
import {
  CalendarPlus,
  UserPlus,
  Clock4,
  ArrowRight,
  Plug,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { InsightCard } from "@/components/ui/Card";

export default function DashboardHero(props: {
  userName: string;
  userRole: string;
  tenantName: string;
  timezone: string;
  todayCount: number;
  weekCount: number;
  utilizationPct: number;
  showGoogleConnect: boolean;
  /** Optional slot — typically MiniSchedule rendered by the page. */
  miniSchedule?: React.ReactNode;
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
    <section
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border bg-surface shadow-soft",
        "bg-hero-glow"
      )}
    >
      {/* Soft brand glow in the corner — layered on top of bg-hero-glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -top-32 h-80 w-80 rounded-full bg-gradient-to-br from-brand-accent/20 via-brand-accent/8 to-transparent blur-3xl"
      />
      {/* Faint grid texture for depth without noise */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(15 23 42) 1px, transparent 1px), linear-gradient(90deg, rgb(15 23 42) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div className="relative p-6 sm:p-8">
        <div className="grid gap-7 lg:grid-cols-[1fr_auto] lg:items-end">
          {/* Left — greeting + AI insight */}
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-accent" />
              {props.tenantName}
            </div>
            <h2 className="mt-3 text-[26px] font-semibold tracking-tight text-ink sm:text-[32px]">
              {greeting},{" "}
              <span className="bg-gradient-to-br from-ink to-ink/70 bg-clip-text text-transparent">
                {firstName(props.userName)}
              </span>
            </h2>
            <p className="mt-1.5 text-[14px] text-ink-muted">
              {todayCopy}{" "}
              <span className="text-ink-subtle">·</span>{" "}
              <span className="text-ink-muted">{formatDate(new Date(), props.timezone)}</span>
            </p>

            {aiInsight && (
              <div className="mt-5 max-w-2xl">
                <InsightCard>{aiInsight}</InsightCard>
              </div>
            )}
          </div>

          {/* Right — quick actions, stacked vertically on lg+ */}
          <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch lg:gap-2">
            <QuickAction
              href="/dashboard/calendar"
              icon={CalendarPlus}
              label="New booking"
              primary
            />
            <QuickAction href="/dashboard/customers" icon={UserPlus} label="Add customer" />
            <QuickAction href="/dashboard/availability/overrides" icon={Clock4} label="Block time" />
            {props.showGoogleConnect && (
              <QuickAction href="/api/google/connect" icon={Plug} label="Connect Google" />
            )}
          </div>
        </div>

        {/* Mini schedule footer slot — only shown when provided */}
        {props.miniSchedule && (
          <div className="relative mt-7 border-t border-border/60 pt-6">
            {props.miniSchedule}
          </div>
        )}
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
  icon: LucideIcon;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex h-11 items-center gap-2.5 rounded-xl px-4 text-[13px] font-medium transition-all duration-200 ease-out",
        primary
          ? "bg-brand-accent text-white shadow-soft hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-glow"
          : "border border-border bg-surface/70 text-ink-muted backdrop-blur-sm hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface hover:text-ink hover:shadow-soft"
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 transition-transform duration-200 group-hover:scale-110",
          primary ? "text-white" : "text-ink-subtle group-hover:text-ink"
        )}
        strokeWidth={1.75}
      />
      <span>{label}</span>
      {primary && (
        <ArrowRight
          className="h-3.5 w-3.5 text-white/80 transition-transform duration-200 group-hover:translate-x-0.5"
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
