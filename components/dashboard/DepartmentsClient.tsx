"use client";

/**
 * DepartmentsClient — operational architecture center.
 *
 * UI-only refinement. The /api/departments contract is preserved
 * byte-identical (GET returns rows; POST creates a row) — this
 * client only changes how the data is displayed and how the
 * create flow is presented.
 *
 * Honest data discipline: per-department counts (staff, services,
 * bookings) come from the additive GET shape on /api/departments.
 * Metrics we don't have data for today (true scheduling coverage %,
 * routing readiness %, operational utilization %) are either omitted
 * or shown as calm "Coming soon" scaffolds. No fabricated numbers.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  Building2,
  Plus,
  Layers,
  Workflow,
  Users,
  CalendarRange,
  CalendarCheck,
  Gauge,
  ShieldCheck,
  CheckCircle2,
  ArrowUpRight,
  Compass,
  type LucideIcon,
} from "lucide-react";

import { Modal, toast } from "@/components/ui/primitives";
import { PremiumCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

type Dept = {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  staffCount: number;
  serviceCount: number;
  /** Up to 3 directly-owned service names (migration 0032), used to
   *  render assigned-service preview chips on the department card.
   *  Server returns alphabetical; we keep the order as-is. */
  assignedServiceNames?: string[];
  bookingsLast30d: number;
};

const DEFAULT_COLORS = [
  "#359df3", "#7c3aed", "#0d9488", "#ea580c",
  "#db2777", "#65a30d", "#0891b2", "#c026d3",
];

export default function DepartmentsClient({
  initial,
  isAdmin,
}: {
  initial: Dept[];
  isAdmin: boolean;
}) {
  const [rows, setRows] = React.useState<Dept[]>(initial);
  const [addOpen, setAddOpen] = React.useState(false);

  // ── Derived workspace metrics ────────────────────────────────
  const metrics = React.useMemo(() => {
    const total = rows.length;
    const totalServices = rows.reduce((s, r) => s + r.serviceCount, 0);
    const totalStaff = rows.reduce((s, r) => s + r.staffCount, 0);
    const totalBookings30d = rows.reduce((s, r) => s + r.bookingsLast30d, 0);
    const routingReady = rows.filter((r) => r.staffCount > 0).length;
    const activeDepartments = rows.filter((r) => r.staffCount > 0 && r.serviceCount > 0).length;
    const distribution = total > 0 && totalBookings30d > 0
      ? rows.filter((r) => r.bookingsLast30d > 0).length
      : 0;
    return {
      total, totalServices, totalStaff, totalBookings30d,
      routingReady, activeDepartments, distribution,
    };
  }, [rows]);

  // ── Operational signal ───────────────────────────────────────
  const signal = React.useMemo(() => deriveSignal(metrics), [metrics]);

  // Refetch after create — keeps the page in sync with what the
  // additive API returns, including per-dept counts.
  const refetch = React.useCallback(async () => {
    try {
      const res = await fetch("/api/departments");
      if (!res.ok) return;
      const next = (await res.json()) as Dept[];
      setRows(Array.isArray(next) ? next : []);
    } catch {
      // leave previous state; toast already shown by caller
    }
  }, []);

  return (
    <div className="relative mt-2 space-y-5">
      {/* Ambient page depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full bg-brand-accent/[0.06] blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-72 -z-10 h-72 w-72 rounded-full bg-emerald-300/[0.04] blur-[120px]"
      />

      {/* ── Hero ──────────────────────────────────────────────── */}
      <FadeIn>
        <DepartmentsHero isAdmin={isAdmin} onAdd={() => setAddOpen(true)} />
      </FadeIn>

      {/* ── AI Operational Intelligence Strip ───────────────── */}
      <FadeIn delay={1}>
        <OperationalSignalStrip text={signal} />
      </FadeIn>

      {/* ── KPI grid ─────────────────────────────────────────── */}
      <FadeIn delay={2}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard
            label="Total departments"
            value={String(metrics.total)}
            icon={Building2}
            tone="brand"
            hint={metrics.total === 0 ? "Awaiting operational structure" : `${metrics.activeDepartments} active`}
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Assigned services"
            value={String(metrics.totalServices)}
            icon={Layers}
            tone="brand"
            hint={metrics.totalServices === 0 ? "Services not assigned yet" : "Across all departments"}
            inactive={metrics.totalServices === 0}
          />
          <KpiCard
            label="Staff coverage"
            value={String(metrics.totalStaff)}
            icon={Users}
            tone="positive"
            hint={metrics.totalStaff === 0 ? "Route staff to departments" : `In ${metrics.routingReady} dept${metrics.routingReady === 1 ? "" : "s"}`}
            inactive={metrics.totalStaff === 0}
          />
          <KpiCard
            label="Routing readiness"
            value={metrics.total === 0 ? "—" : `${metrics.total > 0 ? Math.round((metrics.routingReady / metrics.total) * 100) : 0}%`}
            icon={Workflow}
            tone={metrics.routingReady === 0 ? "warning" : "positive"}
            hint={metrics.total === 0 ? "Routing activates after department setup" : `${metrics.routingReady} of ${metrics.total} departments staffed`}
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Scheduling distribution"
            value={String(metrics.distribution)}
            icon={CalendarRange}
            tone="brand"
            hint={metrics.totalBookings30d === 0 ? "Tracks once bookings flow" : `${metrics.totalBookings30d} bookings (30d)`}
            inactive={metrics.totalBookings30d === 0}
          />
          <KpiCard
            label="Operational utilization"
            value="—"
            icon={Gauge}
            tone="neutral"
            hint="Coming soon · per-dept utilization"
            inactive
          />
        </div>
      </FadeIn>

      {/* ── Directory ────────────────────────────────────────── */}
      <FadeIn delay={3}>
        <div>
          <SectionHead
            eyebrow="Operational architecture"
            title="Departments"
            description="Each department organizes services, workforce routing, and scheduling coverage across your business."
          />

          {rows.length === 0 ? (
            <PremiumActivationState isAdmin={isAdmin} onAdd={() => setAddOpen(true)} />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((d, idx) => (
                <li
                  key={d.id}
                  style={{ animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${Math.min(idx, 8) * 50}ms both` }}
                >
                  <DepartmentCard dept={d} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </FadeIn>

      <AddDepartmentModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={async () => {
          setAddOpen(false);
          await refetch();
        }}
      />
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────

function DepartmentsHero({
  isAdmin,
  onAdd,
}: {
  isAdmin: boolean;
  onAdd: () => void;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div aria-hidden className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.16] blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.32]"
        style={{
          backgroundImage:
            "radial-gradient(800px 220px at 80% 0%, rgba(53,157,243,0.06), transparent 70%), radial-gradient(600px 200px at 0% 100%, rgba(16,185,129,0.05), transparent 70%)",
        }}
      />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
      <span aria-hidden className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent" />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            Operational architecture
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Operational departments
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
            Organize services, workforce routing, scheduling coverage, and operational ownership across your business.
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-1.5">
            <HeroAction href="/dashboard/settings/routing" icon={Workflow} label="Configure routing" tone="ghost" />
            <HeroAction href="/dashboard/services" icon={Layers} label="Assign services" tone="ghost" />
            <HeroAction onClick={onAdd} icon={Plus} label="Add department" tone="primary" />
          </div>
        )}
      </div>
    </PremiumCard>
  );
}

function HeroAction({
  href,
  onClick,
  icon: Icon,
  label,
  tone,
}: {
  href?: string;
  onClick?: () => void;
  icon: LucideIcon;
  label: string;
  tone: "primary" | "ghost";
}) {
  const primaryCls = "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]";
  const ghostCls = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md";
  const cls = tone === "primary" ? primaryCls : ghostCls;
  const iconStroke = tone === "primary" ? 2 : 1.75;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        <Icon className="h-3.5 w-3.5" strokeWidth={iconStroke} />
        {label}
      </button>
    );
  }
  return (
    <Link href={href ?? "/dashboard"} className={cls}>
      <Icon className="h-3.5 w-3.5" strokeWidth={iconStroke} />
      {label}
    </Link>
  );
}

// ─── Operational signal strip ─────────────────────────────────────

function OperationalSignalStrip({ text }: { text: string }) {
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <span aria-hidden className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent" />
        <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <Compass className="h-4 w-4" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Architecture signal
            </div>
            <div
              key={text}
              className="mt-0.5 text-[13px] leading-relaxed text-ink"
              style={{ animation: "zm-row-in 0.55s cubic-bezier(0.16,1,0.3,1) both" }}
            >
              {text}
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-2 py-0.5 text-[10px] font-medium text-ink-muted backdrop-blur-sm sm:inline-flex">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Live
          </div>
        </div>
      </div>
    </div>
  );
}

function deriveSignal(m: {
  total: number;
  activeDepartments: number;
  routingReady: number;
  totalServices: number;
  totalBookings30d: number;
}): string {
  if (m.total === 0) {
    return "No operational departments configured yet. Departments improve service routing and staffing coordination.";
  }
  if (m.activeDepartments === 0) {
    return "Assign services and staff to departments to activate structured scheduling workflows.";
  }
  if (m.routingReady < m.total) {
    return `${m.routingReady} of ${m.total} departments are staffed and ready for routing. Operational segmentation improves workforce visibility.`;
  }
  if (m.totalBookings30d === 0) {
    return `${m.total} departments configured and staffed. Booking flow will route through them as customers arrive.`;
  }
  return `${m.activeDepartments} departments actively delivering with ${m.totalServices} assigned services. ${m.totalBookings30d} bookings routed in the last 30 days.`;
}

// ─── KPI card ─────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  icon,
  tone,
  hint,
  inactive,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning" | "neutral";
  hint: string;
  inactive?: boolean;
}) {
  return (
    <MetricCard
      label={label}
      value={value}
      icon={icon}
      tone={tone}
      muted={inactive}
      sparkline={
        <div className="flex items-center justify-end gap-1.5 text-right text-[10px] font-medium text-ink-subtle">
          {inactive && (
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-brand-accent/40" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-brand-accent/60" />
            </span>
          )}
          <span className={cn(inactive && "italic")}>{hint}</span>
        </div>
      }
    />
  );
}

// ─── Section header ───────────────────────────────────────────────

function SectionHead({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-[12px] text-ink-muted">{description}</p>}
    </header>
  );
}

// ─── Department card ──────────────────────────────────────────────

function DepartmentCard({ dept }: { dept: Dept }) {
  const accent = dept.color ?? "#94a3b8";
  const status = deriveDeptStatus(dept);

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift">
      {/* Brand color left rail */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 rounded-l-2xl"
        style={{ backgroundColor: accent, boxShadow: `0 0 12px ${accent}55` }}
      />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

      <div className="relative pl-2">
        {/* Header — color dot + name + status */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              <Building2 className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink">{dept.name}</h3>
          </div>
          <StatusChip status={status} />
        </div>

        {/* Description */}
        {dept.description && (
          <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{dept.description}</p>
        )}

        {/* Operational counts */}
        <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <DeptStat icon={Users} label="Staff" value={dept.staffCount} tone="brand" />
          <DeptStat icon={Layers} label="Services" value={dept.serviceCount} tone="brand" />
          <DeptStat icon={CalendarRange} label="Bookings 30d" value={dept.bookingsLast30d} tone="positive" />
        </dl>

        {/* Assigned services preview — directly-owned services
            (migration 0032). Surfaces up to 3 names so the operator
            can see at a glance what this department is responsible
            for. Hidden when none are assigned. */}
        {dept.assignedServiceNames && dept.assignedServiceNames.length > 0 && (
          <div className="mt-3">
            <div className="text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Assigned services
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {dept.assignedServiceNames.map((n) => (
                <span
                  key={n}
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-ink-muted"
                >
                  <Layers className="h-2.5 w-2.5 text-brand-accent" strokeWidth={2} />
                  <span className="truncate max-w-[120px]">{n}</span>
                </span>
              ))}
              {dept.serviceCount > dept.assignedServiceNames.length && (
                <span className="text-[10px] text-ink-subtle">
                  +{dept.serviceCount - dept.assignedServiceNames.length} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Routing readiness line */}
        <div className="mt-3 border-t border-border/50 pt-2 text-[11px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            {dept.staffCount > 0 ? (
              <>
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]" />
                Routing ready
              </>
            ) : (
              <>
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.40)]" />
                Awaiting staff assignment
              </>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

type DeptStatus = "active" | "pending" | "empty";

function deriveDeptStatus(d: Dept): DeptStatus {
  if (d.staffCount > 0 && d.serviceCount > 0) return "active";
  if (d.staffCount > 0 || d.serviceCount > 0) return "pending";
  return "empty";
}

function StatusChip({ status }: { status: DeptStatus }) {
  const cfg =
    status === "active" ? { label: "Active",  cls: "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40", dot: "bg-emerald-500" }
    : status === "pending" ? { label: "Pending", cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40",      dot: "bg-amber-500" }
    :                         { label: "Empty",   cls: "bg-surface-inset text-ink-muted ring-border/50",      dot: "bg-ink-subtle/40" };

  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1", cfg.cls)}>
      <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function DeptStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: "brand" | "positive";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-inset/30 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
        <Icon className={cn("h-2.5 w-2.5", tone === "positive" ? "text-emerald-600" : "text-brand-accent")} strokeWidth={2} />
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold leading-none tabular-nums text-ink">{value}</div>
    </div>
  );
}

// ─── Premium activation state ─────────────────────────────────────

function PremiumActivationState({
  isAdmin,
  onAdd,
}: {
  isAdmin: boolean;
  onAdd: () => void;
}) {
  return (
    <PremiumCard
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/40 via-surface to-surface"
    >
      {/* Atmosphere */}
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand-accent/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -left-16 -bottom-16 h-48 w-48 rounded-full bg-emerald-200/20 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.40]"
        style={{
          backgroundImage:
            "radial-gradient(700px 200px at 70% 10%, rgba(53,157,243,0.06), transparent 70%), radial-gradient(500px 180px at 10% 90%, rgba(16,185,129,0.05), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.45]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(53,157,243,0.18) 1px, transparent 0)",
          backgroundSize: "22px 22px",
          maskImage:
            "radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 75%)",
        }}
      />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />

      <div className="relative px-2 py-7 text-center sm:px-6 sm:py-9">
        <div className="zm-pulse-glow mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Building2 className="h-7 w-7" strokeWidth={1.5} />
        </div>
        <h3 className="mt-4 text-[18px] font-semibold tracking-tight text-ink">
          Build your operational structure
        </h3>
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
          Departments organize services, staffing, and scheduling workflows across your organization.
        </p>

        {isAdmin && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Create your first department
            </button>
          </div>
        )}

        {/* Activation checklist */}
        <ActivationChecklist onAdd={onAdd} />
      </div>
    </PremiumCard>
  );
}

type ActivationStep = {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  action:
    | { kind: "onAdd" }
    | { kind: "link"; href: string; label: string }
    | { kind: "none" };
};

function ActivationChecklist({ onAdd }: { onAdd: () => void }) {
  const steps: ActivationStep[] = [
    {
      key: "create",
      title: "Create departments",
      description: "Define the operational business units that organize your service delivery.",
      icon: Plus,
      action: { kind: "onAdd" },
    },
    {
      key: "assign-services",
      title: "Assign services",
      description: "Services connect to departments through the staff that deliver them.",
      icon: Layers,
      action: { kind: "link", href: "/dashboard/services", label: "Open services" },
    },
    {
      key: "route-staff",
      title: "Route staff",
      description: "Assign each staff member's home department on their profile.",
      icon: Users,
      action: { kind: "link", href: "/dashboard/staff", label: "Open staff" },
    },
    {
      key: "scheduling-coverage",
      title: "Configure scheduling coverage",
      description: "Set availability and booking rules so departments cover their service hours.",
      icon: CalendarCheck,
      action: { kind: "link", href: "/dashboard/availability", label: "Open availability" },
    },
    {
      key: "activate-routing",
      title: "Activate operational routing",
      description: "Routing rules direct incoming bookings to the right department automatically.",
      icon: Workflow,
      action: { kind: "link", href: "/dashboard/settings/routing", label: "Configure routing" },
    },
  ];

  return (
    <div className="mt-8 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Operational activation
          </div>
          <div className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Five steps to activate operational architecture
          </div>
        </div>
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-subtle">
          0 of {steps.length} complete
        </span>
      </div>

      <span aria-hidden className="relative mt-2 inline-block h-1 w-full overflow-hidden rounded-full bg-surface-inset/60">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-brand-accent/60 shadow-[0_0_8px_rgba(53,157,243,0.30)] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ width: "4%" }}
        />
      </span>

      <ol className="mt-4 space-y-2">
        {steps.map((step, i) => (
          <li
            key={step.key}
            style={{
              animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${i * 60}ms both`,
            }}
          >
            <ActivationStepCard step={step} index={i + 1} onAdd={onAdd} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ActivationStepCard({
  step,
  index,
  onAdd,
}: {
  step: ActivationStep;
  index: number;
  onAdd: () => void;
}) {
  const Icon = step.icon;

  const Action = () => {
    if (step.action.kind === "onAdd") {
      return (
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
        >
          Add department
          <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
        </button>
      );
    }
    if (step.action.kind === "link") {
      return (
        <Link
          href={step.action.href}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
        >
          {step.action.label}
          <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
        </Link>
      );
    }
    return null;
  };

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-surface/80 p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="relative flex items-center gap-3">
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
          <span className="text-[12px] font-semibold tabular-nums">{index}</span>
        </div>
        <div className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-inset text-ink-muted ring-1 ring-border/40 sm:inline-flex">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[13px] font-semibold tracking-tight text-ink">{step.title}</h4>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{step.description}</p>
        </div>
        <Action />
      </div>
    </div>
  );
}

// ─── Add Department Modal ─────────────────────────────────────────

function AddDepartmentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState(DEFAULT_COLORS[0]);
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setName(""); setColor(DEFAULT_COLORS[0]); setDescription(""); setBusy(false);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color, description: description.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast("Department added", "success");
      await onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a department">
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Departments organize the services and staff that deliver them. Naming the department after the business unit it represents keeps routing and analytics readable later.
        </p>

        {/* Preview card */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand-subtle/30 via-surface to-surface p-3.5">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
          <div className="flex items-center gap-2.5">
            <div
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white shadow-[0_2px_8px_rgba(15,23,42,0.12)]"
              style={{ backgroundColor: color }}
              aria-hidden
            >
              <Building2 className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Preview</div>
              <div className="truncate text-[14px] font-semibold tracking-tight text-ink">
                {name.trim() || "New department"}
              </div>
            </div>
          </div>
        </div>

        {/* Name */}
        <div>
          <label htmlFor="dept-name" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Name
          </label>
          <input
            id="dept-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tax preparation"
            autoFocus
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>

        {/* Color swatches */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Color
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {DEFAULT_COLORS.map((c) => {
              const active = c === color;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  className={cn(
                    "relative h-8 w-8 overflow-hidden rounded-lg border transition-all duration-[180ms]",
                    active
                      ? "scale-110 border-transparent shadow-[0_4px_12px_rgba(15,23,42,0.18)] ring-2 ring-offset-2 ring-brand-accent"
                      : "border-border hover:scale-105 hover:shadow-soft"
                  )}
                  style={{ backgroundColor: c }}
                >
                  {active && <CheckCircle2 className="absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow-sm" strokeWidth={2.5} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="dept-desc" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Description <span className="text-ink-subtle/70">(optional)</span>
          </label>
          <textarea
            id="dept-desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What kind of work this department owns operationally"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>

        {/* Routing readiness note */}
        <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">
            <ShieldCheck className="mr-1 inline-block h-3 w-3" strokeWidth={1.75} /> Next step &middot;{" "}
          </span>
          Assign at least one staff member to this department on their staff profile to activate routing.
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={create}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              busy || !name.trim()
                ? "cursor-not-allowed opacity-50"
                : "hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            )}
          >
            {busy ? (
              <>
                <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Saving…
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                Save department
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

