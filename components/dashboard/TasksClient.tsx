"use client";

/**
 * TasksClient — premium operational workspace (Phase 4I).
 *
 * STRICTLY PRESERVED:
 *   - Default export name (TasksClient)
 *   - Props { allStaff, allCustomers, myUserId }
 *   - Task type shape (no schema/API change)
 *   - All API calls:
 *       GET    /api/tasks
 *       POST   /api/tasks
 *       PATCH  /api/tasks/[id]   { status }
 *       DELETE /api/tasks/[id]
 *
 * What changed (UI-only):
 *   - 2-col grid: timeline (1fr) + OperationalPulse rail (320px) on lg+.
 *   - SegmentedFilterBar with count badges per filter (All / Open /
 *     Due today / Completed / Mine).
 *   - Tasks grouped by temporal bucket (Overdue / Today / Tomorrow /
 *     This week / Later / No date / Completed). Each group has a
 *     premium header with a dot + count.
 *   - Premium TaskCard with derived-priority accent rail
 *     (overdue=red, today=amber, this-week=brand, later=slate),
 *     hover halo (matches Calendar + Appointments), and quick actions
 *     (Open customer when present, Delete) revealed on hover.
 *   - OperationalPulse rail: tasks due today, overdue count,
 *     completion rate (last 30d), workload insight (assistant tone).
 *   - Premium "New task" drawer with brand-gradient hero, smart
 *     defaults, refined inputs, animated submit.
 *   - Framer Motion AnimatePresence for completion fade-and-collapse.
 *   - Single fetch of all tasks; filter switching is client-side and
 *     instant (no spinner between filters).
 *
 * Easing language: cubic-bezier(0.16, 1, 0.3, 1) — same as Calendar /
 * Appointments. One product, one motion language.
 */
import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Plus,
  Trash2,
  ExternalLink,
  Calendar as CalendarIcon,
  Clock,
  AlertCircle,
  CheckCircle2,
  Sparkles,
  X,
  ListChecks,
  Flame,
  TrendingUp,
  Users,
  ArrowRight,
} from "lucide-react";

import { Avatar, toast } from "@/components/ui/primitives";
import { PremiumCard, InsightCard, SectionHeader } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

type Task = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "done";
  dueAt: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  relatedCustomerId: string | null;
  customerName: string | null;
  relatedBookingId: string | null;
  createdAt: string;
  completedAt: string | null;
};

const FILTERS = ["all", "open", "today", "done", "mine"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABEL: Record<Filter, string> = {
  all:   "All",
  open:  "Open",
  today: "Due today",
  done:  "Completed",
  mine:  "Mine",
};

// Priority is derived purely from temporal signal — no schema change.
type Priority = "urgent" | "high" | "medium" | "low";

// Temporal bucket — drives both grouping and the section dot colour.
type Bucket = "overdue" | "today" | "tomorrow" | "thisWeek" | "later" | "noDate" | "completed";

// ─── Main component ────────────────────────────────────────────────

export default function TasksClient({
  allStaff,
  allCustomers,
  myUserId,
}: {
  allStaff: { id: string; name: string }[];
  allCustomers: { id: string; name: string }[];
  myUserId: string;
}) {
  const sp = useSearchParams();
  const [filter, setFilter] = React.useState<Filter>("open");
  const [rows, setRows] = React.useState<Task[] | null>(null);
  const [openNew, setOpenNew] = React.useState(sp.get("new") === "1");

  // Single fetch of all tasks — filters are applied client-side so
  // switching is instant and the count badges are honest.
  const reload = React.useCallback(async () => {
    try {
      const r = await fetch("/api/tasks", { cache: "no-store" });
      const d = await r.json();
      setRows(Array.isArray(d) ? (d as Task[]) : []);
    } catch {
      setRows([]);
    }
  }, []);
  React.useEffect(() => { reload(); }, [reload]);

  async function toggleStatus(t: Task) {
    const next: Task["status"] = t.status === "open" ? "done" : "open";
    const completedAt = next === "done" ? new Date().toISOString() : null;
    setRows((cur) => cur?.map((x) => (x.id === t.id ? { ...x, status: next, completedAt } : x)) ?? null);
    try {
      const r = await fetch(`/api/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error("Failed");
      toast(next === "done" ? "Task completed" : "Task reopened", "success");
    } catch {
      toast("Failed to update task", "error");
      reload();
    }
  }

  async function removeTask(t: Task) {
    if (!window.confirm("Delete this task?")) return;
    setRows((cur) => cur?.filter((x) => x.id !== t.id) ?? null);
    try {
      const r = await fetch(`/api/tasks/${t.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Failed");
      toast("Task deleted", "success");
    } catch {
      toast("Failed to delete task", "error");
      reload();
    }
  }

  const counts = React.useMemo(() => computeCounts(rows ?? [], myUserId), [rows, myUserId]);
  const visible = React.useMemo(() => applyFilter(rows ?? [], filter, myUserId), [rows, filter, myUserId]);
  const grouped = React.useMemo(() => groupByBucket(visible, filter), [visible, filter]);
  const pulse = React.useMemo(() => computePulse(rows ?? [], myUserId), [rows, myUserId]);

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* ── Main timeline ────────────────────────────────────── */}
      <div className="min-w-0 space-y-5">
        <FadeIn>
          <SegmentedFilterBar
            filter={filter}
            onChange={setFilter}
            counts={counts}
            onAddTask={() => setOpenNew(true)}
          />
        </FadeIn>

        {rows === null ? (
          <LoadingSkeleton />
        ) : visible.length === 0 ? (
          <FadeIn>
            <FilterEmptyState filter={filter} onAddTask={() => setOpenNew(true)} />
          </FadeIn>
        ) : (
          <div className="space-y-7">
            {grouped.map((g, idx) => (
              <FadeIn key={g.bucket} delay={idx}>
                <TaskGroup
                  bucket={g.bucket}
                  tasks={g.tasks}
                  onToggle={toggleStatus}
                  onRemove={removeTask}
                />
              </FadeIn>
            ))}
          </div>
        )}
      </div>

      {/* ── Operational rail ──────────────────────────────── */}
      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <FadeIn delay={1}>
          <OperationalPulse pulse={pulse} onSeeOverdue={() => setFilter("open")} />
        </FadeIn>
      </aside>

      <NewTaskDrawer
        open={openNew}
        onClose={() => setOpenNew(false)}
        allStaff={allStaff}
        allCustomers={allCustomers}
        defaultAssigneeId={myUserId}
        onCreated={() => { setOpenNew(false); reload(); }}
      />
    </div>
  );
}

// ─── Filter bar ────────────────────────────────────────────────────

function SegmentedFilterBar({
  filter,
  onChange,
  counts,
  onAddTask,
}: {
  filter: Filter;
  onChange: (f: Filter) => void;
  counts: Record<Filter, number>;
  onAddTask: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="relative inline-flex rounded-xl border border-border bg-surface-subtle p-0.5 shadow-soft">
        {FILTERS.map((f) => {
          const active = filter === f;
          const n = counts[f];
          return (
            <button
              key={f}
              onClick={() => onChange(f)}
              aria-pressed={active}
              className={cn(
                "relative z-10 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors duration-150",
                active ? "text-white" : "text-ink-muted hover:text-ink",
              )}
            >
              {active && (
                <motion.span
                  layoutId="tasks-filter-indicator"
                  className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(53,157,243,0.35)]"
                  aria-hidden
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              <span className="relative">{FILTER_LABEL[f]}</span>
              {n > 0 && (
                <span
                  className={cn(
                    "relative inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                    active ? "bg-white/25 text-white" : "bg-surface-inset text-ink-subtle",
                  )}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onAddTask}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
        New task
      </button>
    </div>
  );
}

// ─── Task group ────────────────────────────────────────────────────

const BUCKET_LABEL: Record<Bucket, { label: string; dotClass: string }> = {
  overdue:    { label: "Overdue",      dotClass: "bg-red-500" },
  today:      { label: "Today",        dotClass: "bg-amber-500" },
  tomorrow:   { label: "Tomorrow",     dotClass: "bg-brand-accent" },
  thisWeek:   { label: "This week",    dotClass: "bg-brand-accent" },
  later:      { label: "Later",        dotClass: "bg-slate-400" },
  noDate:     { label: "No due date",  dotClass: "bg-slate-300" },
  completed:  { label: "Completed",    dotClass: "bg-emerald-500" },
};

function TaskGroup({
  bucket,
  tasks,
  onToggle,
  onRemove,
}: {
  bucket: Bucket;
  tasks: Task[];
  onToggle: (t: Task) => void;
  onRemove: (t: Task) => void;
}) {
  const meta = BUCKET_LABEL[bucket];
  const reduced = useReducedMotion();
  return (
    <section>
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", meta.dotClass)} aria-hidden />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {meta.label}
        </h3>
        <span className="text-[10px] font-medium tabular-nums text-ink-subtle">·</span>
        <span className="text-[10px] font-medium tabular-nums text-ink-subtle">{tasks.length}</span>
      </div>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {tasks.map((t) => (
            <motion.li
              key={t.id}
              layout
              initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, height: 0, marginTop: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              style={{ overflow: "hidden" }}
            >
              <TaskCard task={t} onToggle={onToggle} onRemove={onRemove} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

// ─── Task card ─────────────────────────────────────────────────────

function TaskCard({
  task,
  onToggle,
  onRemove,
}: {
  task: Task;
  onToggle: (t: Task) => void;
  onRemove: (t: Task) => void;
}) {
  const priority = derivePriority(task);
  const dueLabel = formatDue(task.dueAt);
  const isDone = task.status === "done";
  const isOverdue = !isDone && task.dueAt && new Date(task.dueAt).getTime() < Date.now();

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-surface px-4 py-3.5 shadow-soft transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-0.5 hover:scale-[1.004] hover:border-border-strong hover:shadow-lift",
        isDone ? "opacity-70 border-border" : "border-border",
      )}
    >
      {/* Priority accent rail */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 rounded-l-2xl",
          priorityRail(priority),
        )}
      />

      {/* Tactile inner highlight at rest (suppressed on done) */}
      {!isDone && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
      )}

      {/* Hover halo — same language as Appointments / Calendar */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
        style={{
          boxShadow:
            "0 0 0 1px rgba(53,157,243,0.18), 0 10px 28px rgba(53,157,243,0.10)",
        }}
      />

      <div className="relative flex items-start gap-3 pl-2">
        {/* Custom completion checkbox */}
        <button
          type="button"
          onClick={() => onToggle(task)}
          aria-label={isDone ? "Mark open" : "Mark complete"}
          className={cn(
            "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
            isDone
              ? "border-emerald-500 bg-emerald-500 text-white shadow-[0_2px_8px_rgba(16,185,129,0.35)]"
              : "border-border-strong bg-surface hover:border-brand-accent hover:bg-brand-subtle",
          )}
        >
          {isDone && <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />}
        </button>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "truncate text-[14px] font-semibold tracking-tight",
                  isDone ? "text-ink-muted line-through" : "text-ink",
                )}
              >
                {task.title}
              </div>
              {task.description && (
                <p
                  className={cn(
                    "mt-0.5 line-clamp-2 text-[12px] leading-relaxed",
                    isDone ? "text-ink-subtle" : "text-ink-muted",
                  )}
                >
                  {task.description}
                </p>
              )}

              {/* Meta chips */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {task.assignedName && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-inset px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                    <Avatar name={task.assignedName} size="sm" className="!h-4 !w-4 !text-[8px]" />
                    {task.assignedName}
                  </span>
                )}
                {task.customerName && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200/60">
                    <Users className="h-2.5 w-2.5" strokeWidth={1.75} />
                    {task.customerName}
                  </span>
                )}
                {dueLabel && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                      isOverdue
                        ? "bg-red-50 text-red-700 ring-1 ring-red-200/60"
                        : "bg-surface-inset text-ink-muted",
                    )}
                  >
                    {isOverdue ? (
                      <AlertCircle className="h-2.5 w-2.5" strokeWidth={2} />
                    ) : (
                      <Clock className="h-2.5 w-2.5" strokeWidth={1.75} />
                    )}
                    {dueLabel}
                  </span>
                )}
                <PriorityChip priority={priority} isDone={isDone} />
              </div>

              {/* Hover-reveal quick actions */}
              <div className="pointer-events-none mt-2.5 flex items-center gap-1.5 opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:pointer-events-auto group-hover:opacity-100">
                {task.relatedCustomerId && (
                  <Link
                    href={`/dashboard/customers?focus=${task.relatedCustomerId}`}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                  >
                    <ExternalLink className="h-2.5 w-2.5" strokeWidth={1.75} />
                    Open customer
                  </Link>
                )}
                {task.relatedBookingId && (
                  <Link
                    href="/dashboard/appointments"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                  >
                    <CalendarIcon className="h-2.5 w-2.5" strokeWidth={1.75} />
                    Open booking
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(task)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-subtle shadow-soft transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                >
                  <Trash2 className="h-2.5 w-2.5" strokeWidth={1.75} />
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PriorityChip({ priority, isDone }: { priority: Priority; isDone: boolean }) {
  if (isDone) return null;
  if (priority === "low") return null; // restrained — only show ≥ medium
  const map: Record<Priority, { label: string; cls: string }> = {
    urgent: { label: "Urgent",  cls: "bg-red-50 text-red-700 ring-1 ring-red-200/60" },
    high:   { label: "High",    cls: "bg-amber-50 text-amber-800 ring-1 ring-amber-200/60" },
    medium: { label: "Medium",  cls: "bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/15" },
    low:    { label: "Low",     cls: "" },
  };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", map[priority].cls)}>
      {map[priority].label}
    </span>
  );
}

function priorityRail(priority: Priority): string {
  switch (priority) {
    case "urgent": return "bg-red-500";
    case "high":   return "bg-amber-500";
    case "medium": return "bg-brand-accent";
    case "low":    return "bg-slate-300";
  }
}

// ─── Operational pulse rail ─────────────────────────────────────────

type Pulse = {
  dueToday: number;
  overdue: number;
  /** Open tasks that aren't due today and aren't overdue — used to
   *  build the "open total" tile without recomputing. */
  openOther: number;
  completionRatePct: number; // last 30d
  insight: string;
};

function OperationalPulse({
  pulse,
  onSeeOverdue,
}: {
  pulse: Pulse;
  onSeeOverdue: () => void;
}) {
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
        <SectionHeader
          eyebrow="Operational pulse"
          title="Workload at a glance"
        />

        <div className="grid grid-cols-2 gap-2">
          <PulseTile
            icon={CalendarIcon}
            tone="brand"
            label="Due today"
            value={String(pulse.dueToday)}
          />
          <PulseTile
            icon={Flame}
            tone={pulse.overdue > 0 ? "warning" : "neutral"}
            label="Overdue"
            value={String(pulse.overdue)}
            onClick={pulse.overdue > 0 ? onSeeOverdue : undefined}
          />
          <PulseTile
            icon={TrendingUp}
            tone="positive"
            label="Completion · 30d"
            value={`${pulse.completionRatePct}%`}
          />
          <PulseTile
            icon={ListChecks}
            tone="neutral"
            label="Open total"
            value={String(pulse.dueToday + pulse.overdue + pulse.openOther)}
          />
        </div>

        <div className="mt-3">
          <InsightCard title="Workload">{pulse.insight}</InsightCard>
        </div>
      </div>
    </PremiumCard>
  );
}

function PulseTile({
  icon: Icon,
  tone,
  label,
  value,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: "brand" | "warning" | "neutral" | "positive";
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const toneClass =
    tone === "brand"
      ? "bg-brand-subtle text-brand-accent ring-brand-accent/15"
      : tone === "warning"
        ? "bg-amber-50 text-amber-600 ring-amber-300/40"
        : tone === "positive"
          ? "bg-emerald-50 text-emerald-600 ring-emerald-300/40"
          : "bg-surface-inset text-ink-subtle ring-transparent";
  const Wrap = onClick ? "button" : "div";
  return (
    <Wrap
      onClick={onClick}
      className={cn(
        "w-full rounded-lg border border-border bg-surface/60 p-2.5 text-left backdrop-blur-sm transition-all",
        onClick ? "cursor-pointer hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft" : "",
      )}
    >
      <div className="flex items-center gap-1.5">
        <div className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md ring-1", toneClass)}>
          <Icon className="h-3 w-3" strokeWidth={1.75} />
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">{label}</span>
      </div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums text-ink">{value}</div>
    </Wrap>
  );
}

// ─── Empty states ──────────────────────────────────────────────────

function FilterEmptyState({ filter, onAddTask }: { filter: Filter; onAddTask: () => void }) {
  const config: Record<Filter, { eyebrow: string; title: string; body: string; cta?: string }> = {
    all: {
      eyebrow: "Clear",
      title: "Your queue is empty",
      body: "Create a task to track a follow-up, confirm a booking, or chase a payment.",
      cta: "Create a task",
    },
    open: {
      eyebrow: "All clear",
      title: "Your queue is under control",
      body: "No open tasks right now. A calm window for outreach, planning, or deep work.",
    },
    today: {
      eyebrow: "Calm",
      title: "Nothing due today",
      body: "Your day is well-paced. The next task ahead is on its own time.",
    },
    done: {
      eyebrow: "Quiet",
      title: "No completed tasks yet",
      body: "Completed work will appear here as a record of what's been resolved.",
    },
    mine: {
      eyebrow: "Light load",
      title: "Nothing assigned to you",
      body: "Your personal queue is clear. A good window to take on a new follow-up.",
    },
  };
  const c = config[filter];
  return (
    <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/30 via-surface to-surface">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/10 blur-3xl"
      />
      <div className="relative flex items-start gap-3">
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Sparkles className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            {c.eyebrow}
          </div>
          <h3 className="mt-0.5 text-[16px] font-semibold tracking-tight text-ink">{c.title}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{c.body}</p>
          {c.cta && (
            <button
              type="button"
              onClick={onAddTask}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
              {c.cta}
            </button>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="relative h-20 overflow-hidden rounded-2xl border border-border bg-surface-subtle zm-shimmer"
        />
      ))}
    </div>
  );
}

// ─── New task drawer ──────────────────────────────────────────────

function NewTaskDrawer({
  open, onClose, allStaff, allCustomers, defaultAssigneeId, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  allStaff: { id: string; name: string }[];
  allCustomers: { id: string; name: string }[];
  defaultAssigneeId: string;
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [assignedUserId, setAssignedUserId] = React.useState(defaultAssigneeId);
  const [relatedCustomerId, setRelatedCustomerId] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (open) {
      setTitle(""); setDescription(""); setDueAt("");
      setAssignedUserId(defaultAssigneeId);
      setRelatedCustomerId("");
    }
  }, [open, defaultAssigneeId]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && open) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function save() {
    if (!title.trim()) { toast("Title is required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || null,
          dueAt: dueAt ? new Date(dueAt + "T00:00:00").toISOString() : null,
          assignedUserId: assignedUserId || null,
          relatedCustomerId: relatedCustomerId || null,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? "Failed");
      }
      toast("Task created", "success");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="New task"
            className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-md flex-col bg-surface shadow-2xl"
            initial={reduced ? { x: 0 } : { x: "100%" }}
            animate={{ x: 0 }}
            exit={reduced ? { x: 0 } : { x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* Hero */}
            <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-brand-subtle/55 via-surface to-surface px-5 pt-5 pb-4">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
              />
              <div className="relative flex items-start justify-between">
                <div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-accent">
                    <Sparkles className="h-3 w-3" strokeWidth={2} />
                    New task
                  </div>
                  <h2 className="mt-2 text-[17px] font-semibold tracking-tight text-ink">
                    Capture an operational follow-up
                  </h2>
                  <p className="mt-0.5 text-[12px] text-ink-muted">
                    A call to make, a payment to chase, a booking to confirm.
                  </p>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
                >
                  <X className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
            </div>

            {/* Form */}
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5 text-sm">
              <Field label="Title" required>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Follow up with Maria about Q1 plan"
                  className={INPUT_CLS}
                  autoFocus
                />
              </Field>
              <Field label="Notes (optional)">
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Anything that helps you remember the context."
                  className={cn(INPUT_CLS, "resize-none")}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Due date">
                  <input
                    type="date"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                    className={INPUT_CLS}
                  />
                </Field>
                <Field label="Assigned to">
                  <select
                    value={assignedUserId}
                    onChange={(e) => setAssignedUserId(e.target.value)}
                    className={INPUT_CLS}
                  >
                    {allStaff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Linked customer (optional)">
                <select
                  value={relatedCustomerId}
                  onChange={(e) => setRelatedCustomerId(e.target.value)}
                  className={INPUT_CLS}
                >
                  <option value="">— None —</option>
                  {allCustomers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-border/70 bg-surface-subtle/40 px-5 py-3.5">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !title.trim()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Creating…" : (
                  <>
                    Create task
                    <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
                  </>
                )}
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

const INPUT_CLS = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] outline-none transition-colors focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20";

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
        {label}{required && <span className="text-brand-accent"> *</span>}
      </span>
      {children}
    </label>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function applyFilter(rows: Task[], filter: Filter, myUserId: string): Task[] {
  switch (filter) {
    case "all":   return rows;
    case "open":  return rows.filter((t) => t.status === "open");
    case "done":  return rows.filter((t) => t.status === "done");
    case "mine":  return rows.filter((t) => t.assignedUserId === myUserId);
    case "today": {
      const todayKey = dayKey(new Date());
      return rows.filter(
        (t) => t.status === "open" && t.dueAt && dayKey(new Date(t.dueAt)) === todayKey,
      );
    }
  }
}

function computeCounts(rows: Task[], myUserId: string): Record<Filter, number> {
  return {
    all: rows.length,
    open: rows.filter((t) => t.status === "open").length,
    today: applyFilter(rows, "today", myUserId).length,
    done: rows.filter((t) => t.status === "done").length,
    mine: rows.filter((t) => t.assignedUserId === myUserId).length,
  };
}

function groupByBucket(
  tasks: Task[],
  filter: Filter,
): Array<{ bucket: Bucket; tasks: Task[] }> {
  // For "done" filter, just show a single "completed" group.
  if (filter === "done") {
    return tasks.length === 0 ? [] : [{ bucket: "completed", tasks }];
  }

  const buckets: Record<Bucket, Task[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    later: [],
    noDate: [],
    completed: [],
  };

  const now = Date.now();
  const todayKey = dayKey(new Date());
  const tomorrowKey = dayKey(new Date(now + 86_400_000));
  const weekEnd = now + 7 * 86_400_000;

  for (const t of tasks) {
    if (t.status === "done") {
      buckets.completed.push(t);
      continue;
    }
    if (!t.dueAt) {
      buckets.noDate.push(t);
      continue;
    }
    const dueMs = new Date(t.dueAt).getTime();
    const dueKey = dayKey(new Date(dueMs));
    if (dueMs < now && dueKey !== todayKey) {
      buckets.overdue.push(t);
    } else if (dueKey === todayKey) {
      buckets.today.push(t);
    } else if (dueKey === tomorrowKey) {
      buckets.tomorrow.push(t);
    } else if (dueMs < weekEnd) {
      buckets.thisWeek.push(t);
    } else {
      buckets.later.push(t);
    }
  }

  // Sort each bucket by due date ascending (no-date last by createdAt).
  for (const k of Object.keys(buckets) as Bucket[]) {
    buckets[k].sort((a, b) => {
      const aMs = a.dueAt ? new Date(a.dueAt).getTime() : new Date(a.createdAt).getTime();
      const bMs = b.dueAt ? new Date(b.dueAt).getTime() : new Date(b.createdAt).getTime();
      return aMs - bMs;
    });
  }

  const order: Bucket[] = ["overdue", "today", "tomorrow", "thisWeek", "later", "noDate", "completed"];
  return order
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ bucket: k, tasks: buckets[k] }));
}

function derivePriority(t: Task): Priority {
  if (t.status === "done") return "low";
  if (!t.dueAt) return "low";
  const dueMs = new Date(t.dueAt).getTime();
  const now = Date.now();
  if (dueMs < now) return "urgent";
  const hours = (dueMs - now) / 3_600_000;
  if (hours <= 24) return "high";
  if (hours <= 24 * 7) return "medium";
  return "low";
}

function formatDue(due: string | null): string | null {
  if (!due) return null;
  const ms = new Date(due).getTime();
  const now = Date.now();
  const dayMs = 86_400_000;
  const diff = ms - now;
  const absDays = Math.round(Math.abs(diff) / dayMs);
  const todayKey = dayKey(new Date());
  const dueKey = dayKey(new Date(ms));
  if (dueKey === todayKey) return "Today";
  if (dueKey === dayKey(new Date(now + dayMs))) return "Tomorrow";
  if (dueKey === dayKey(new Date(now - dayMs))) return "Yesterday";
  if (diff < 0) return `${absDays}d overdue`;
  if (absDays <= 6) return `In ${absDays}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayKey(d: Date): string {
  // Local-day key as YYYY-MM-DD using the runtime's timezone. The
  // /api/tasks endpoint already returns ISO strings in UTC, so this
  // bucket comparison stays consistent with the user's clock.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computePulse(rows: Task[], myUserId: string): Pulse {
  const todayKey = dayKey(new Date());
  const now = Date.now();
  const dueToday = rows.filter(
    (t) => t.status === "open" && t.dueAt && dayKey(new Date(t.dueAt)) === todayKey,
  ).length;
  const overdue = rows.filter(
    (t) => t.status === "open" && t.dueAt && new Date(t.dueAt).getTime() < now && dayKey(new Date(t.dueAt)) !== todayKey,
  ).length;
  const openTotal = rows.filter((t) => t.status === "open").length;
  const openOther = Math.max(0, openTotal - dueToday - overdue);

  // Completion rate in last 30 days.
  const thirtyAgo = now - 30 * 86_400_000;
  const recentDone = rows.filter(
    (t) => t.status === "done" && t.completedAt && new Date(t.completedAt).getTime() >= thirtyAgo,
  ).length;
  const recentCreated = rows.filter((t) => new Date(t.createdAt).getTime() >= thirtyAgo).length;
  const completionRatePct = recentCreated > 0 ? Math.round((recentDone / recentCreated) * 100) : 0;

  // Assistant-toned workload insight.
  const mineOpen = rows.filter((t) => t.status === "open" && t.assignedUserId === myUserId).length;
  let insight: string;
  if (overdue > 0) {
    insight = `${overdue} overdue task${overdue === 1 ? "" : "s"} to resolve. Clearing these first protects the rest of the day.`;
  } else if (dueToday >= 5) {
    insight = `${dueToday} tasks due today. Consider batching the quick ones together.`;
  } else if (dueToday > 0) {
    insight = `${dueToday} task${dueToday === 1 ? "" : "s"} due today. A focused hour should clear them.`;
  } else if (mineOpen === 0 && openTotal === 0) {
    insight = "Your queue is clear. A good window for outreach, planning, or deep work.";
  } else if (openTotal > 0) {
    insight = "You're clear this afternoon. A calm window to chip into the upcoming queue.";
  } else {
    insight = "Workload looks balanced. Nothing urgent in front of you.";
  }

  return { dueToday, overdue, openOther, completionRatePct, insight };
}
