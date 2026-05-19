/**
 * DashboardSidePanel — the right column of the dashboard grid.
 *
 * Three stacked cards:
 *   1. Pending tasks (per-row badges, overdue tint)
 *   2. Top services (last 30 days, with bookings + revenue)
 *   3. Workspace summary (plan, total bookings)
 *
 * Server component. Premium spacing + rounded-2xl cards. Empty states
 * are friendly + actionable instead of "nothing here".
 */
import Link from "next/link";
import {
  ListTodo,
  Sparkles,
  Box,
  ArrowUpRight,
  CalendarClock,
  Plus,
  PieChart,
} from "lucide-react";
import { cn } from "@/lib/cn";

type PendingTask = { id: string; title: string; dueAt: string | null };
type TopService = { id: string; name: string; bookings: number; revenueCents: number };

export default function DashboardSidePanel(props: {
  pendingTasks: PendingTask[];
  topServices: TopService[];
  totalBookings: number;
  plan: string;
}) {
  return (
    <aside className="space-y-6">
      {/* ── Pending tasks ─────────────────────────────────────── */}
      <Card
        title="Pending tasks"
        href="/dashboard/tasks"
        hrefLabel="View all"
        icon={ListTodo}
      >
        {props.pendingTasks.length === 0 ? (
          <EmptyState
            icon={ListTodo}
            title="You're all caught up"
            body="No open tasks. Nice work."
            ctaHref={null}
          />
        ) : (
          <ul className="-mx-1 space-y-0.5">
            {props.pendingTasks.map((t) => {
              const overdue = t.dueAt ? new Date(t.dueAt).getTime() < Date.now() : false;
              return (
                <li
                  key={t.id}
                  className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-inset"
                >
                  <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{t.title}</div>
                    {t.dueAt && (
                      <div
                        className={cn(
                          "mt-0.5 text-[11px]",
                          overdue ? "text-red-600" : "text-ink-muted"
                        )}
                      >
                        {overdue ? "Overdue · " : "Due "}
                        {new Date(t.dueAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ── Top services ──────────────────────────────────────── */}
      <Card
        title="Top services (30d)"
        href="/dashboard/services"
        hrefLabel="Manage"
        icon={Box}
      >
        {props.topServices.length === 0 ? (
          <EmptyState
            icon={Box}
            title="No bookings yet"
            body="Create your first service to start filling your calendar."
            ctaHref="/dashboard/services"
            ctaLabel="Create a service"
          />
        ) : (
          <ul className="-mx-1 space-y-0.5">
            {props.topServices.map((s, i) => {
              const totalBookings = props.topServices.reduce((acc, x) => acc + x.bookings, 0);
              const pct = totalBookings > 0 ? Math.round((s.bookings / totalBookings) * 100) : 0;
              return (
                <li
                  key={s.id}
                  className="rounded-lg px-2 py-2 transition-colors hover:bg-surface-inset"
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
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-inset">
                      <div
                        className="h-full rounded-full bg-brand-accent transition-all"
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
      </Card>

      {/* ── Workspace summary ─────────────────────────────────── */}
      <Card title="Workspace" icon={PieChart}>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Plan" value={props.plan} tone="brand" />
          <Stat label="Bookings total" value={String(props.totalBookings)} />
        </div>
        <div className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-brand-accent/20 bg-gradient-to-br from-brand-subtle/60 to-transparent px-3 py-2 text-[11px]">
          <Sparkles className="h-3.5 w-3.5 text-brand-accent" strokeWidth={1.75} />
          <span className="text-ink-muted">
            Need more capacity?{" "}
            <Link href="/dashboard/billing" className="font-medium text-brand-accent hover:underline">
              Compare plans
            </Link>
          </span>
        </div>
      </Card>
    </aside>
  );
}

// ─── Building blocks ────────────────────────────────────────────────

function Card({
  title,
  href,
  hrefLabel,
  icon: Icon,
  children,
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-xs transition-shadow hover:shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && (
            <Icon
              className="h-4 w-4 text-ink-subtle"
              strokeWidth={1.75}
            />
          )}
          <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        </div>
        {href && hrefLabel && (
          <Link
            href={href}
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand-accent transition-colors hover:text-brand-hover"
          >
            {hrefLabel}
            <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function EmptyState(props: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
  ctaHref: string | null;
  ctaLabel?: string;
}) {
  const Icon = props.icon;
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface-subtle px-4 py-6 text-center">
      <div className="mb-2 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-subtle text-brand-accent">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <div className="text-[13px] font-medium text-ink">{props.title}</div>
      <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-ink-muted">{props.body}</p>
      {props.ctaHref && props.ctaLabel && (
        <Link
          href={props.ctaHref}
          className="mt-3 inline-flex h-7 items-center gap-1 rounded-lg bg-brand-accent px-2.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-brand-hover"
        >
          <Plus className="h-3 w-3" strokeWidth={2.25} />
          {props.ctaLabel}
        </Link>
      )}
    </div>
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
    <div className="rounded-xl border border-border bg-surface-subtle p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-lg font-semibold tracking-tight",
          tone === "brand" ? "capitalize text-brand-accent" : "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Suppress unused-import warning for icons reserved for future cards.
void CalendarClock;
