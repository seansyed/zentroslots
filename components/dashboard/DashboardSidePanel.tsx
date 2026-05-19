/**
 * DashboardSidePanel (Phase 2) — productivity widgets in the right column.
 *
 * Uses the shared PremiumCard + SectionHeader + EmptyState primitives.
 * Each card has activity-feed feel: subtle row dividers, premium hover,
 * tonal accents per status.
 */
import Link from "next/link";
import {
  ListTodo,
  Box,
  CalendarClock,
  PieChart,
  AlertCircle,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { PremiumCard, SectionHeader, EmptyState } from "@/components/ui/Card";

type PendingTask = { id: string; title: string; dueAt: string | null };
type TopService = { id: string; name: string; bookings: number; revenueCents: number };

export default function DashboardSidePanel(props: {
  pendingTasks: PendingTask[];
  topServices: TopService[];
  totalBookings: number;
  plan: string;
}) {
  return (
    <aside className="space-y-5">
      {/* ── Pending tasks ─────────────────────────────────────── */}
      <PremiumCard compact>
        <SectionHeader
          title="Pending tasks"
          href="/dashboard/tasks"
          hrefLabel="View all"
        />
        {props.pendingTasks.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="You're all caught up"
            body="No open tasks. Use this window for outreach or focus work."
          />
        ) : (
          <ul className="-mx-1 divide-y divide-border/50">
            {props.pendingTasks.map((t) => {
              const overdue = t.dueAt ? new Date(t.dueAt).getTime() < Date.now() : false;
              return (
                <li
                  key={t.id}
                  className="group flex items-start gap-2.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-inset/60"
                >
                  <div
                    className={cn(
                      "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                      overdue
                        ? "bg-red-50 text-red-600"
                        : t.dueAt
                          ? "bg-amber-50 text-amber-600"
                          : "bg-brand-subtle text-brand-accent"
                    )}
                  >
                    {overdue ? (
                      <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                    ) : (
                      <ListTodo className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{t.title}</div>
                    {t.dueAt && (
                      <div
                        className={cn(
                          "mt-0.5 text-[11px] tabular-nums",
                          overdue ? "text-red-600" : "text-ink-muted"
                        )}
                      >
                        {overdue ? "Overdue · " : "Due "}
                        {new Date(t.dueAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PremiumCard>

      {/* ── Top services ──────────────────────────────────────── */}
      <PremiumCard compact>
        <SectionHeader
          eyebrow="Last 30 days"
          title="Top services"
          href="/dashboard/services"
          hrefLabel="Manage"
        />
        {props.topServices.length === 0 ? (
          <EmptyState
            icon={Box}
            title="No bookings yet"
            body="Create your first service to start filling your calendar."
            ctaHref="/dashboard/services"
            ctaLabel="Create a service"
          />
        ) : (
          <ul className="-mx-1 space-y-1">
            {props.topServices.map((s, i) => {
              const totalBookings = props.topServices.reduce((acc, x) => acc + x.bookings, 0);
              const pct = totalBookings > 0 ? Math.round((s.bookings / totalBookings) * 100) : 0;
              return (
                <li
                  key={s.id}
                  className="group rounded-lg px-2 py-2 transition-colors hover:bg-surface-inset/60"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-[10px] font-semibold text-brand-accent">
                        {i + 1}
                      </span>
                      <span className="truncate text-[13px] font-medium text-ink">{s.name}</span>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">
                      ${Math.round(s.revenueCents / 100).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-inset">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-brand-accent to-brand-hover transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-ink-subtle">
                      {s.bookings} bk
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PremiumCard>

      {/* ── Workspace summary ─────────────────────────────────── */}
      <PremiumCard compact>
        <SectionHeader title="Workspace" />
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Plan" value={props.plan} tone="brand" />
          <Stat label="Bookings total" value={String(props.totalBookings)} />
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle/60 to-transparent px-3 py-2.5 text-[11px]">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-accent" strokeWidth={1.75} />
          <span className="text-ink-muted">
            Need more capacity?{" "}
            <Link
              href="/dashboard/billing"
              className="font-medium text-brand-accent transition-colors hover:text-brand-hover"
            >
              Compare plans →
            </Link>
          </span>
        </div>
      </PremiumCard>
    </aside>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "brand";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface-subtle p-3 transition-colors",
        tone === "brand" && "hover:border-brand-accent/30"
      )}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[18px] font-semibold leading-none tracking-tight",
          tone === "brand" ? "capitalize text-brand-accent" : "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Reserved for future widgets — keeps the import set discoverable.
void CalendarClock;
void PieChart;
