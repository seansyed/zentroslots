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
  Clock4,
  Bell,
  User,
  FileText,
  RotateCcw,
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
  /** Explicit priority chosen by the user. Null falls back to the
   *  temporal derivation in derivePriority(). New tasks always set
   *  this; legacy rows from before migration 0031 may be null. */
  priority: "urgent" | "high" | "medium" | "low" | null;
  dueAt: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  relatedCustomerId: string | null;
  customerName: string | null;
  relatedBookingId: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Client-only flag set by buildDemoTasks() when a tenant has zero
   *  real tasks. Demo rows never reach the server — toggleStatus and
   *  removeTask short-circuit on it. The flag is never serialized. */
  isDemo?: boolean;
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

  // "N" keyboard shortcut: opens the New task drawer when the user
  // isn't typing in an input / textarea / contenteditable. Mirrors the
  // power-user pattern in Linear / Superhuman. Stays bound regardless
  // of demo state.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (openNew) return;
      if (e.key !== "n" && e.key !== "N") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      setOpenNew(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNew]);

  // Demo population: when a tenant has zero real tasks and hasn't
  // dismissed the preview, the workspace fills with a realistic
  // operational sample so every premium surface (cards, buckets,
  // pulse, insight, filters) has something to render.
  const [demoHidden, setDemoHidden] = React.useState(false);
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem("tasks_demo_hidden") === "1") {
      setDemoHidden(true);
    }
  }, []);

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

  // Once the real fetch resolves with no actionable (open) work, swap
  // in a demo queue so the workspace feels alive. The demo retires the
  // moment a real OPEN task arrives (next reload). Completed-only
  // tenants count as operationally empty — the workspace shouldn't
  // read as abandoned just because there's a record of past work.
  const openRealCount = rows ? rows.filter((t) => t.status === "open").length : 0;
  const isDemoActive = rows !== null && openRealCount === 0 && !demoHidden;
  const effectiveRows: Task[] = React.useMemo(
    () => (isDemoActive ? buildDemoTasks(myUserId, allStaff) : (rows ?? [])),
    [isDemoActive, rows, myUserId, allStaff],
  );

  function dismissDemo() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("tasks_demo_hidden", "1");
    }
    setDemoHidden(true);
  }

  async function toggleStatus(t: Task) {
    // Demo rows never reach the server — toast and update locally.
    if (t.isDemo) {
      toast(
        t.status === "open"
          ? "Preview · Sample task. Your real tasks will complete via the API."
          : "Preview · Sample task.",
        "info",
      );
      return;
    }
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
    if (t.isDemo) {
      toast("Preview · Sample tasks can't be deleted.", "info");
      return;
    }
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

  // Set priority: PATCH /api/tasks/[id] with { priority }.
  async function setTaskPriority(t: Task, priority: Priority) {
    if (t.priority === priority) return;
    if (t.isDemo) {
      toast("Preview · Sample task priority can't be changed.", "info");
      return;
    }
    setRows((cur) => cur?.map((x) => (x.id === t.id ? { ...x, priority } : x)) ?? null);
    try {
      const r = await fetch(`/api/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority }),
      });
      if (!r.ok) throw new Error("Failed");
      toast(`Priority set to ${priority}`, "success");
    } catch {
      toast("Failed to update priority", "error");
      reload();
    }
  }

  // Snooze: shift dueAt forward by `days` (preserving the original
  // local clock hour). PATCH /api/tasks/[id] already accepts dueAt.
  async function snoozeTask(t: Task, days: number) {
    if (t.isDemo) {
      toast("Preview · Sample tasks can't be snoozed.", "info");
      return;
    }
    const base = t.dueAt ? new Date(t.dueAt) : new Date();
    const next = new Date(base.getTime() + days * 86_400_000);
    const nextIso = next.toISOString();
    setRows((cur) => cur?.map((x) => (x.id === t.id ? { ...x, dueAt: nextIso } : x)) ?? null);
    try {
      const r = await fetch(`/api/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueAt: nextIso }),
      });
      if (!r.ok) throw new Error("Failed");
      toast(days === 1 ? "Snoozed until tomorrow" : `Snoozed ${days}d`, "success");
    } catch {
      toast("Failed to snooze task", "error");
      reload();
    }
  }

  // Open task detail drawer. State holds the full row so the drawer
  // can show optimistic edits even after the underlying list reloads.
  const [detailTask, setDetailTask] = React.useState<Task | null>(null);
  function openTask(t: Task) {
    if (t.isDemo) {
      toast("Preview · Sample task. Real tasks open the full detail drawer.", "info");
      return;
    }
    setDetailTask(t);
  }
  // Keep the drawer in sync with optimistic row mutations so completing
  // / snoozing from inside the drawer updates the body live.
  React.useEffect(() => {
    if (!detailTask) return;
    const fresh = rows?.find((x) => x.id === detailTask.id);
    if (fresh && fresh !== detailTask) setDetailTask(fresh);
    if (rows && !rows.find((x) => x.id === detailTask.id)) setDetailTask(null);
  }, [rows, detailTask]);

  const counts = React.useMemo(() => computeCounts(effectiveRows, myUserId), [effectiveRows, myUserId]);
  const visible = React.useMemo(() => applyFilter(effectiveRows, filter, myUserId), [effectiveRows, filter, myUserId]);
  const grouped = React.useMemo(() => groupByBucket(visible, filter), [visible, filter]);
  const pulse = React.useMemo(() => computePulse(effectiveRows, myUserId), [effectiveRows, myUserId]);

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* ── Main timeline ────────────────────────────────────── */}
      <div className="min-w-0 space-y-5">
        {isDemoActive && (
          <FadeIn>
            <SampleTasksBanner onDismiss={dismissDemo} />
          </FadeIn>
        )}

        <FadeIn delay={isDemoActive ? 1 : 0}>
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
          <div className="space-y-6">
            {grouped.map((g, idx) => (
              <FadeIn key={g.bucket} delay={idx}>
                <TaskGroup
                  bucket={g.bucket}
                  tasks={g.tasks}
                  onToggle={toggleStatus}
                  onRemove={removeTask}
                  onSnooze={snoozeTask}
                  onOpen={openTask}
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

      <TaskDetailDrawer
        task={detailTask}
        onClose={() => setDetailTask(null)}
        onToggle={toggleStatus}
        onRemove={removeTask}
        onSnooze={snoozeTask}
        onSetPriority={setTaskPriority}
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
                  className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(53,157,243,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]"
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
        className="group/new inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
        title="New task · press N"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
        New task
        <kbd className="ml-0.5 hidden h-4 min-w-[16px] items-center justify-center rounded border border-white/30 bg-white/15 px-1 font-mono text-[9px] font-semibold text-white/90 transition-colors sm:inline-flex">N</kbd>
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
  onSnooze,
  onOpen,
}: {
  bucket: Bucket;
  tasks: Task[];
  onToggle: (t: Task) => void;
  onRemove: (t: Task) => void;
  onSnooze: (t: Task, days: number) => void;
  onOpen: (t: Task) => void;
}) {
  const meta = BUCKET_LABEL[bucket];
  const reduced = useReducedMotion();
  return (
    <section className="relative">
      {/* Sticky group header — stays in view as you scroll a long
          bucket, with a backdrop-blurred app-bg surface that matches
          the global topbar's translucency rhythm. */}
      <div className="sticky top-16 z-10 -mx-2 mb-2 flex items-baseline gap-2 bg-app-bg/80 px-2 py-1.5 backdrop-blur-md">
        <span
          className={cn(
            "relative inline-block h-2 w-2 rounded-full ring-2 ring-app-bg",
            meta.dotClass,
          )}
          aria-hidden
        />
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {meta.label}
        </h3>
        <span className="text-[10px] font-medium tabular-nums text-ink-subtle">·</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={tasks.length}
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 3 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="text-[10px] font-medium tabular-nums text-ink-subtle"
          >
            {tasks.length}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* Subtle vertical timeline connector — sits behind the cards
          and gives every group the feel of a temporal lane rather
          than a detached list. Hidden on completed bucket. */}
      {bucket !== "completed" && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-2 left-1 top-12 w-px bg-gradient-to-b from-border/70 via-border/30 to-transparent"
        />
      )}

      <ul className="relative space-y-1.5">
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
              <TaskCard task={t} onToggle={onToggle} onRemove={onRemove} onSnooze={onSnooze} onOpen={onOpen} />
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
  onSnooze,
  onOpen,
}: {
  task: Task;
  onToggle: (t: Task) => void;
  onRemove: (t: Task) => void;
  onSnooze: (t: Task, days: number) => void;
  onOpen: (t: Task) => void;
}) {
  const priority = derivePriority(task);
  const dueLabel = formatDue(task.dueAt);
  const isDone = task.status === "done";
  const isOverdue = !isDone && task.dueAt && new Date(task.dueAt).getTime() < Date.now();

  // Completion psychology: when the user toggles open → done, we stage
  // a brief "completing" phase that animates the strike-through and
  // emerald wash before the AnimatePresence layout collapse fires.
  // The PATCH still goes through immediately; this is visual sugar.
  const [completing, setCompleting] = React.useState(false);
  function handleToggle() {
    if (!isDone) {
      setCompleting(true);
      window.setTimeout(() => setCompleting(false), 350);
    }
    onToggle(task);
  }

  function handleCardClick(e: React.MouseEvent) {
    // Ignore clicks on the checkbox / nested buttons / links.
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input")) return;
    onOpen(task);
  }
  function handleCardKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input")) return;
      e.preventDefault();
      onOpen(task);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKey}
      data-completing={completing ? "true" : undefined}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-2xl border bg-surface px-3 py-3 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:px-4 sm:py-3.5",
        "hover:-translate-y-0.5 hover:scale-[1.002] hover:border-border-strong hover:shadow-lift",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
        isDone ? "opacity-70 border-border" : "border-border",
        // Priority-aware hover wash — extremely subtle, only visible on
        // hover so it adds presence without staining the resting state.
        !isDone && !completing && priority === "urgent" && "hover:bg-gradient-to-br hover:from-red-50/40 hover:via-surface hover:to-surface",
        !isDone && !completing && priority === "high"   && "hover:bg-gradient-to-br hover:from-amber-50/40 hover:via-surface hover:to-surface",
        !isDone && !completing && priority === "medium" && "hover:bg-gradient-to-br hover:from-brand-subtle/30 hover:via-surface hover:to-surface",
        completing && "border-emerald-300 bg-gradient-to-br from-emerald-50/60 via-surface to-surface",
      )}
    >
      {/* Priority accent rail — overdue gets a warm glow so the eye
          catches it without needing a loud chip. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 rounded-l-2xl transition-shadow duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
          priorityRail(priority),
          priority === "urgent" && "shadow-[0_0_10px_rgba(239,68,68,0.45)]",
          priority === "high" && "shadow-[0_0_8px_rgba(245,158,11,0.35)]",
        )}
      />

      {/* Tactile inner highlight at rest (suppressed on done) */}
      {!isDone && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
      )}
      {/* Top-edge shimmer sweep on hover — premium tactile signal that
          fades in just at the top of the card. Uses the global
          zm-shimmer keyframe already in globals.css. */}
      {!isDone && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
        >
          <span className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-brand-accent/60 to-transparent zm-shimmer" />
        </span>
      )}

      {/* Hover halo — same language as Appointments / Calendar */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
        style={{
          boxShadow:
            "0 0 0 1px rgba(53,157,243,0.18), 0 10px 28px rgba(53,157,243,0.10)",
        }}
      />

      {/* Floating top-right glass toolbar — icon-first compact actions.
          Hidden until card hover/focus, then fades + slides 4px down
          into view. Glass backdrop, low visual weight. */}
      {!isDone && (
        <div
          className={cn(
            "pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-surface/85 p-0.5 opacity-0 shadow-soft backdrop-blur-md",
            "-translate-y-1 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            "group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100",
            "group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100",
          )}
        >
          <ToolbarButton
            label="Snooze 1 day"
            icon={Bell}
            onClick={(e) => { e.stopPropagation(); onSnooze(task, 1); }}
          />
          {task.relatedCustomerId && (
            <ToolbarLink
              label="Open customer"
              icon={Users}
              href={`/dashboard/customers?focus=${task.relatedCustomerId}`}
            />
          )}
          {task.relatedBookingId && (
            <ToolbarLink
              label="Open booking"
              icon={CalendarIcon}
              href="/dashboard/appointments"
            />
          )}
          <ToolbarButton
            label="Delete"
            icon={Trash2}
            tone="danger"
            onClick={(e) => { e.stopPropagation(); onRemove(task); }}
          />
        </div>
      )}

      <div className="relative flex items-start gap-3 pl-2">
        {/* Custom completion checkbox */}
        <button
          type="button"
          onClick={handleToggle}
          aria-label={isDone ? "Mark open" : "Mark complete"}
          className={cn(
            "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
            (isDone || completing)
              ? "border-emerald-500 bg-emerald-500 text-white shadow-[0_2px_10px_rgba(16,185,129,0.45)]"
              : "border-border-strong bg-surface hover:border-brand-accent hover:bg-brand-subtle hover:scale-110",
          )}
        >
          {(isDone || completing) && <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />}
        </button>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "truncate text-[14px] font-semibold tracking-tight transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                  (isDone || completing) ? "text-ink-muted line-through" : "text-ink",
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

              {/* Floating top-right glass toolbar — icon-first, low
                  opacity until hover. Reveals on hover or
                  focus-within. Hidden on completed cards. */}
              {/* Toolbar rendered separately at the card level (below)
                  so it can sit absolute top-right. Markup intentionally
                  empty here. */}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  onClick,
  tone = "neutral",
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  onClick: (e: React.MouseEvent) => void;
  tone?: "neutral" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-subtle transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        tone === "danger"
          ? "hover:bg-red-50 hover:text-red-600"
          : "hover:bg-surface-inset hover:text-ink",
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
    </button>
  );
}

function ToolbarLink({
  label,
  icon: Icon,
  href,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  href: string;
}) {
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      title={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-subtle transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface-inset hover:text-ink"
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
    </Link>
  );
}

function PrioritySelector({
  value,
  onChange,
  size = "md",
  layoutGroupId,
}: {
  /** Currently selected priority — null means "no explicit priority" */
  value: Priority | null;
  onChange: (next: Priority) => void;
  size?: "sm" | "md";
  /** Distinct layoutId per place this selector renders so Framer
   *  doesn't try to animate the indicator across drawers. */
  layoutGroupId: string;
}) {
  const reduced = useReducedMotion();
  const options: Array<{ value: Priority; label: string; dot: string }> = [
    { value: "urgent", label: "Urgent", dot: "bg-red-500" },
    { value: "high",   label: "High",   dot: "bg-amber-500" },
    { value: "medium", label: "Medium", dot: "bg-brand-accent" },
    { value: "low",    label: "Low",    dot: "bg-slate-400" },
  ];
  return (
    <div
      className={cn(
        "relative inline-flex rounded-lg border border-border bg-surface-subtle p-0.5 shadow-soft",
        size === "sm" ? "" : "",
      )}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              "relative z-10 inline-flex items-center gap-1 rounded-md font-medium transition-colors duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              size === "sm" ? "h-6 px-2 text-[10px]" : "h-7 px-2.5 text-[11px]",
              active ? "text-white" : "text-ink-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId={`priority-indicator-${layoutGroupId}`}
                className="absolute inset-0 rounded-md bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(53,157,243,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]"
                aria-hidden
                transition={reduced ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
            <span aria-hidden className={cn("relative inline-block h-1.5 w-1.5 rounded-full", active ? "bg-white/85" : opt.dot)} />
            <span className="relative">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PriorityChip({ priority, isDone }: { priority: Priority; isDone: boolean }) {
  if (isDone) return null;
  if (priority === "low") return null; // restrained — only show ≥ medium
  const map: Record<Priority, { label: string; cls: string; dot: string }> = {
    urgent: { label: "Urgent",  cls: "bg-red-50/80 text-red-700 ring-1 ring-red-200/50",          dot: "bg-red-500" },
    high:   { label: "High",    cls: "bg-amber-50/80 text-amber-800 ring-1 ring-amber-200/50",    dot: "bg-amber-500" },
    medium: { label: "Medium",  cls: "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15", dot: "bg-brand-accent" },
    low:    { label: "Low",     cls: "",                                                          dot: "" },
  };
  const m = map[priority];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]", m.cls)}>
      <span className={cn("inline-block h-1 w-1 rounded-full", m.dot)} aria-hidden />
      {m.label}
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
  const reduced = useReducedMotion();
  const toneClass =
    tone === "brand"
      ? "bg-brand-subtle text-brand-accent ring-brand-accent/15"
      : tone === "warning"
        ? "bg-amber-50 text-amber-600 ring-amber-300/40"
        : tone === "positive"
          ? "bg-emerald-50 text-emerald-600 ring-emerald-300/40"
          : "bg-surface-inset text-ink-subtle ring-transparent";
  // Subtle tonal under-bar — a 2px footer stripe that picks up the
  // tile's tone and adds a quiet sense of depth without becoming a
  // sparkline (no analytics, just tactile breathing).
  const barClass =
    tone === "brand"    ? "bg-brand-accent/30"
    : tone === "warning"  ? "bg-amber-400/40"
    : tone === "positive" ? "bg-emerald-400/40"
    :                       "bg-ink-subtle/15";
  const Wrap = onClick ? "button" : "div";
  return (
    <Wrap
      onClick={onClick}
      className={cn(
        "group/tile relative w-full overflow-hidden rounded-lg border border-border bg-surface/70 p-2.5 text-left backdrop-blur-md transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        onClick
          ? "cursor-pointer hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface/85 hover:shadow-soft"
          : "hover:-translate-y-px hover:border-border-strong hover:bg-surface/80",
      )}
    >
      <div className="flex items-center gap-1.5">
        <div className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md ring-1 transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/tile:scale-110", toneClass)}>
          <Icon className="h-3 w-3" strokeWidth={1.75} />
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider text-ink-subtle">{label}</span>
      </div>
      {/* Animated value transitions — number swap fades + rises 3px so
          stat changes feel deliberate without being distracting. */}
      <div className="relative mt-1 h-[20px] overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={value}
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="text-[16px] font-semibold tabular-nums text-ink"
          >
            {value}
          </motion.div>
        </AnimatePresence>
      </div>
      {/* Tonal under-bar */}
      <span aria-hidden className={cn("absolute inset-x-2 bottom-1 h-0.5 rounded-full", barClass)} />
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
        <div className="zm-pulse-glow inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
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
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [busy, setBusy] = React.useState(false);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (open) {
      setTitle(""); setDescription(""); setDueAt("");
      setAssignedUserId(defaultAssigneeId);
      setRelatedCustomerId("");
      setPriority("medium");
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
          priority,
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
              <Field label="Priority">
                <div className="flex">
                  <PrioritySelector
                    layoutGroupId="new-task"
                    value={priority}
                    onChange={setPriority}
                  />
                </div>
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

// ─── Task detail drawer ──────────────────────────────────────────

function TaskDetailDrawer({
  task,
  onClose,
  onToggle,
  onRemove,
  onSnooze,
  onSetPriority,
}: {
  task: Task | null;
  onClose: () => void;
  onToggle: (t: Task) => void;
  onRemove: (t: Task) => void;
  onSnooze: (t: Task, days: number) => void;
  onSetPriority: (t: Task, priority: Priority) => void;
}) {
  const reduced = useReducedMotion();

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && task) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onClose]);

  return (
    <AnimatePresence>
      {task && (
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
            aria-label="Task details"
            className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-md flex-col bg-surface shadow-2xl"
            initial={reduced ? { x: 0 } : { x: "100%" }}
            animate={{ x: 0 }}
            exit={reduced ? { x: 0 } : { x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <TaskDetailBody task={task} onClose={onClose} onToggle={onToggle} onRemove={onRemove} onSnooze={onSnooze} onSetPriority={onSetPriority} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function TaskDetailBody({
  task,
  onClose,
  onToggle,
  onRemove,
  onSnooze,
  onSetPriority,
}: {
  task: Task;
  onClose: () => void;
  onToggle: (t: Task) => void;
  onRemove: (t: Task) => void;
  onSnooze: (t: Task, days: number) => void;
  onSetPriority: (t: Task, priority: Priority) => void;
}) {
  const priority = derivePriority(task);
  const isDone = task.status === "done";
  const dueLabel = formatDue(task.dueAt);
  const isOverdue = !isDone && task.dueAt && new Date(task.dueAt).getTime() < Date.now();
  const relLabel = formatRelative(task.dueAt);

  return (
    <div className="flex h-full flex-col">
      {/* Hero */}
      <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-brand-subtle/55 via-surface to-surface px-5 pb-5 pt-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
        />
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* Status pill */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              <span className={cn("inline-flex h-1.5 w-1.5 rounded-full", isDone ? "bg-emerald-500" : "bg-brand-accent")} />
              {isDone ? "Completed" : "Open"}
            </span>
            <h2 className={cn("mt-2 text-[17px] font-semibold tracking-tight text-ink", isDone && "line-through text-ink-muted")}>
              {task.title}
            </h2>
            {/* Relative time chip */}
            {relLabel && !isDone && (
              <div className="mt-2 inline-flex items-center gap-1.5 flex-wrap">
                <span
                  className={cn(
                    "zm-pulse-glow inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_10px_rgba(53,157,243,0.3)]",
                    isOverdue
                      ? "bg-gradient-to-r from-red-500 to-red-600"
                      : "bg-gradient-to-r from-brand-accent to-brand-hover",
                  )}
                >
                  <span className="h-1 w-1 rounded-full bg-white/90" />
                  {relLabel}
                </span>
                {priority !== "low" && <PriorityChip priority={priority} isDone={isDone} />}
              </div>
            )}
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

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {/* Priority — editable inline. Hides on completed tasks since
            priority no longer drives any rendering for them. */}
        {!isDone && (
          <DetailMetaCard icon={Flame} title="Priority">
            <PrioritySelector
              layoutGroupId={`drawer-${task.id}`}
              value={task.priority ?? priority}
              onChange={(next) => onSetPriority(task, next)}
            />
          </DetailMetaCard>
        )}

        {/* Description */}
        {task.description && (
          <DetailMetaCard icon={FileText} title="Notes">
            <p className="whitespace-pre-line text-[12px] leading-relaxed text-ink">{task.description}</p>
          </DetailMetaCard>
        )}

        {/* When */}
        {task.dueAt && (
          <DetailMetaCard icon={CalendarIcon} title="Due">
            <div className="text-[13px] font-semibold text-ink">
              {new Date(task.dueAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-muted">
              <Clock4 className="h-3 w-3" strokeWidth={1.75} />
              {new Date(task.dueAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              {dueLabel && <><span className="text-ink-subtle">·</span><span>{dueLabel}</span></>}
            </div>
          </DetailMetaCard>
        )}

        {/* Assignee */}
        {task.assignedName && (
          <DetailMetaCard icon={User} title="Assigned to">
            <div className="flex items-center gap-3">
              <div
                aria-hidden
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-[12px] font-semibold uppercase tracking-wider text-white shadow-sm"
              >
                {(task.assignedName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("") || "?").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{task.assignedName}</div>
              </div>
            </div>
          </DetailMetaCard>
        )}

        {/* Customer */}
        {task.customerName && (
          <DetailMetaCard icon={Users} title="Customer">
            <div className="flex items-center gap-3">
              <Avatar name={task.customerName} size="sm" className="!h-9 !w-9 !text-[11px]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{task.customerName}</div>
                {task.relatedCustomerId && (
                  <Link
                    href={`/dashboard/customers?focus=${task.relatedCustomerId}`}
                    className="inline-flex items-center gap-1 text-[11px] text-brand-accent transition-colors hover:text-brand-hover"
                  >
                    Open profile
                    <ArrowRight className="h-2.5 w-2.5" strokeWidth={2.25} />
                  </Link>
                )}
              </div>
            </div>
          </DetailMetaCard>
        )}

        {/* Linked booking */}
        {task.relatedBookingId && (
          <DetailMetaCard icon={CalendarIcon} title="Linked appointment">
            <Link
              href="/dashboard/appointments"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-accent transition-colors hover:text-brand-hover"
            >
              <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
              View in appointments
            </Link>
          </DetailMetaCard>
        )}

        {/* AI summary placeholder */}
        <InsightCard title="AI summary">
          {isDone
            ? "Task is complete. A short summary of any context will appear here once activity is logged."
            : "Once you've made progress, a short AI summary of related activity (emails, calls, notes) will appear here."}
        </InsightCard>
      </div>

      {/* Action footer */}
      <div className="border-t border-border/70 bg-surface-subtle/40 px-5 py-3.5">
        {isDone ? (
          <button
            type="button"
            onClick={() => onToggle(task)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
            Reopen task
          </button>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onToggle(task)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
              >
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                Mark complete
              </button>
              <button
                type="button"
                onClick={() => onSnooze(task, 1)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
              >
                <Bell className="h-3.5 w-3.5" strokeWidth={1.75} />
                Snooze 1d
              </button>
              <button
                type="button"
                onClick={() => onSnooze(task, 7)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
              >
                Snooze 1w
              </button>
            </div>
            <button
              type="button"
              onClick={() => { onRemove(task); onClose(); }}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-md"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailMetaCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-3.5 shadow-soft">
      <div className="mb-2 flex items-center gap-1.5">
        <div className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-surface-inset text-ink-subtle">
          <Icon className="h-3 w-3" strokeWidth={1.75} />
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {title}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function formatRelative(due: string | null): string | null {
  if (!due) return null;
  const ms = new Date(due).getTime();
  const now = Date.now();
  const diff = ms - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  if (min < 1) return "Due now";
  if (min < 60) return diff >= 0 ? `Due in ${min}m` : `${min}m overdue`;
  const hr = Math.round(min / 60);
  if (hr < 24) return diff >= 0 ? `Due in ${hr}h` : `${hr}h overdue`;
  const days = Math.round(hr / 24);
  if (days < 7) return diff >= 0 ? `Due in ${days}d` : `${days}d overdue`;
  const weeks = Math.round(days / 7);
  return diff >= 0 ? `Due in ${weeks}w` : `${weeks}w overdue`;
}

// ─── Sample tasks banner + generator ──────────────────────────────

function SampleTasksBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="relative flex items-center gap-3 rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/55 via-brand-subtle/15 to-transparent px-4 py-3"
      role="status"
    >
      <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-accent text-white shadow-sm">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold tracking-tight text-ink">
          Sample tasks
        </div>
        <div className="mt-0.5 text-[11px] text-ink-muted">
          A preview of how your operational workspace looks when active. None of these are real follow-ups.
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
 * Synthesize a realistic operational queue. ~15 tasks distributed
 * across overdue / today / tomorrow / this-week / later / completed,
 * with a mix of priorities, assignees, and customer linkages.
 *
 * The demo never references real DB rows — relatedCustomerId and
 * relatedBookingId are always null so the hover "Open customer" /
 * "Open booking" chips don't render and the user can't accidentally
 * navigate to a 404. The customerName / assignedName labels still
 * display the chips.
 */
function buildDemoTasks(
  myUserId: string,
  allStaff: { id: string; name: string }[],
): Task[] {
  // Use the real user's name (from allStaff) when assigning to "me",
  // so the Mine filter + assignee chip read naturally.
  const me = allStaff.find((s) => s.id === myUserId);
  const myName = me?.name ?? "You";

  // Three rotating staff names — synthetic IDs so we don't accidentally
  // collide with anyone real.
  const TEAM = [
    { id: "demo-staff-sarah",  name: "Sarah Mitchell" },
    { id: "demo-staff-alex",   name: "Alex Chen" },
    { id: "demo-staff-jordan", name: "Jordan Patel" },
  ];

  const ONE_DAY = 86_400_000;
  const now = Date.now();
  const isoOffset = (days: number, hour = 9): string => {
    const d = new Date(now + days * ONE_DAY);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  type Spec = {
    title: string;
    description?: string;
    daysFromNow: number;          // 0 = today; negative = overdue
    hour?: number;                // local clock hour
    status: "open" | "done";
    completedDaysAgo?: number;    // only when status === "done"
    customerName: string;
    assignedTo: "me" | 0 | 1 | 2; // "me" → current user, else TEAM idx
    priority: Priority;
  };

  const SPECS: Spec[] = [
    // ── Overdue ─────────────────────────────────────────────────
    { title: "Call Maria González about Q1 tax planning", description: "She left a voicemail Friday — needs the updated rate table before her board meeting.", daysFromNow: -2, status: "open", customerName: "Maria González", assignedTo: "me", priority: "urgent" },
    { title: "Send reminder email · David Park", description: "Documents for next week's consultation are still pending.", daysFromNow: -1, hour: 14, status: "open", customerName: "David Park", assignedTo: 0, priority: "high" },

    // ── Today ───────────────────────────────────────────────────
    { title: "Confirm consultation with Emily Roberts", description: "Verify Zoom link and send the intake packet.", daysFromNow: 0, hour: 11, status: "open", customerName: "Emily Roberts", assignedTo: "me", priority: "high" },
    { title: "Review intake form · Marcus Johnson", daysFromNow: 0, hour: 13, status: "open", customerName: "Marcus Johnson", assignedTo: 1, priority: "medium" },
    { title: "Follow up after no-show — Priya Sharma", description: "Offer to reschedule. Apply the no-show fee policy.", daysFromNow: 0, hour: 16, status: "open", customerName: "Priya Sharma", assignedTo: "me", priority: "urgent" },

    // ── Tomorrow ────────────────────────────────────────────────
    { title: "Prepare onboarding packet · Daniel Kim", description: "Include the welcome PDF, brand templates, and the calendar invite.", daysFromNow: 1, hour: 10, status: "open", customerName: "Daniel Kim", assignedTo: 0, priority: "medium" },
    { title: "Verify payment from Ana Silva", daysFromNow: 1, hour: 12, status: "open", customerName: "Ana Silva", assignedTo: "me", priority: "high" },

    // ── This week ───────────────────────────────────────────────
    { title: "Call overdue invoice — Tom Henderson", description: "Net-30 hit yesterday. Soft call first, then a formal email.", daysFromNow: 3, hour: 10, status: "open", customerName: "Tom Henderson", assignedTo: 2, priority: "medium" },
    { title: "Schedule Q2 strategy review · Lisa Wong", daysFromNow: 4, hour: 14, status: "open", customerName: "Lisa Wong", assignedTo: 1, priority: "low" },
    { title: "Prep slides for Sam Taylor demo", description: "Highlight the new automation features and the comparison table.", daysFromNow: 5, hour: 9, status: "open", customerName: "Sam Taylor", assignedTo: "me", priority: "medium" },

    // ── Later ───────────────────────────────────────────────────
    { title: "Send pricing proposal — Olivia Brown", daysFromNow: 9, hour: 11, status: "open", customerName: "Olivia Brown", assignedTo: 0, priority: "low" },
    { title: "Quarterly check-in · Raj Kumar", daysFromNow: 12, hour: 14, status: "open", customerName: "Raj Kumar", assignedTo: 2, priority: "low" },

    // ── Completed ───────────────────────────────────────────────
    { title: "Confirmed booking with Noah Reyes", daysFromNow: 0, hour: 8, status: "done", completedDaysAgo: 0, customerName: "Noah Reyes", assignedTo: "me", priority: "medium" },
    { title: "Sent welcome email to Hannah Webb", daysFromNow: -1, hour: 15, status: "done", completedDaysAgo: 1, customerName: "Hannah Webb", assignedTo: 1, priority: "medium" },
    { title: "Reviewed contract with Sofia Romano", description: "Marked up the SOW addendum and sent for counter-signature.", daysFromNow: -3, hour: 13, status: "done", completedDaysAgo: 3, customerName: "Sofia Romano", assignedTo: 0, priority: "high" },
  ];

  return SPECS.map((s, idx) => {
    const assigned =
      s.assignedTo === "me"
        ? { id: myUserId, name: myName }
        : TEAM[s.assignedTo];
    const createdAt = new Date(now - (Math.max(0, -s.daysFromNow) + 1) * ONE_DAY).toISOString();
    const completedAt =
      s.status === "done" && s.completedDaysAgo !== undefined
        ? new Date(now - s.completedDaysAgo * ONE_DAY).toISOString()
        : null;
    return {
      id: `demo-task-${idx}`,
      title: s.title,
      description: s.description ?? null,
      status: s.status,
      priority: s.priority,
      dueAt: isoOffset(s.daysFromNow, s.hour ?? 9),
      assignedUserId: assigned.id,
      assignedName: assigned.name,
      relatedCustomerId: null, // never link demo customers — see fn doc
      customerName: s.customerName,
      relatedBookingId: null,
      createdAt,
      completedAt,
      isDemo: true,
    };
  });
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
  // Explicit priority always wins. Legacy / unset rows fall back to
  // the temporal heuristic so they never lose their rail / chip.
  if (t.priority) return t.priority;
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

  // Priority-aware counts (uses derivePriority so legacy rows roll up
  // into the temporal heuristic).
  const urgentOpen = rows.filter((t) => t.status === "open" && derivePriority(t) === "urgent").length;
  const highOpen = rows.filter((t) => t.status === "open" && derivePriority(t) === "high").length;

  // Completion rate in last 30 days.
  const thirtyAgo = now - 30 * 86_400_000;
  const recentDone = rows.filter(
    (t) => t.status === "done" && t.completedAt && new Date(t.completedAt).getTime() >= thirtyAgo,
  ).length;
  const recentCreated = rows.filter((t) => new Date(t.createdAt).getTime() >= thirtyAgo).length;
  const completionRatePct = recentCreated > 0 ? Math.round((recentDone / recentCreated) * 100) : 0;

  // Assistant-toned workload insight — priority-aware. Urgency wins
  // over temporal heuristics when there are explicit urgent tasks.
  const mineOpen = rows.filter((t) => t.status === "open" && t.assignedUserId === myUserId).length;
  let insight: string;
  if (urgentOpen > 0) {
    insight = `${urgentOpen} urgent task${urgentOpen === 1 ? "" : "s"} require attention. Clearing these first keeps the day on track.`;
  } else if (overdue > 0) {
    insight = `${overdue} overdue task${overdue === 1 ? "" : "s"} to resolve. Clearing these first protects the rest of the day.`;
  } else if (highOpen >= 3) {
    insight = `${highOpen} high-priority tasks queued. Tackle them in a focused block.`;
  } else if (dueToday >= 5) {
    insight = `${dueToday} tasks due today. Consider batching the quick ones together.`;
  } else if (dueToday > 0) {
    insight = `${dueToday} task${dueToday === 1 ? "" : "s"} due today. A focused hour should clear them.`;
  } else if (highOpen > 0) {
    insight = "High-priority queue is under control. A calm window for proactive work.";
  } else if (mineOpen === 0 && openTotal === 0) {
    insight = "Your queue is clear. A good window for outreach, planning, or deep work.";
  } else if (openTotal > 0) {
    insight = "No urgent operational blockers. A steady afternoon to chip into the upcoming queue.";
  } else {
    insight = "Workload looks balanced. Nothing urgent in front of you.";
  }

  return { dueToday, overdue, openOther, completionRatePct, insight };
}
