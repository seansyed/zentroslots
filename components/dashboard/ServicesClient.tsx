"use client";

/**
 * ServicesClient — Operational Services Intelligence Center.
 *
 * UI-only refinement. All API contracts preserved byte-identical:
 *   GET  /api/services      (now also supports ?include=all)
 *   POST /api/services
 *   PATCH/DELETE /api/services/[id]
 *
 * All booking, scheduling, routing logic unchanged. No schema
 * migrations. Honest data discipline:
 *
 *   - Per-service department count + names come from the additive
 *     fields in the GET response (derived via staff.departmentId,
 *     same transitive model the Departments page uses).
 *   - Per-service bookingsLast30d comes from the additive GET field.
 *   - "Operational utilization" KPI is explicitly scaffolded as
 *     "Coming soon" — we don't have per-service utilization data
 *     today and won't fabricate it.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  Plus,
  Users,
  CalendarCheck,
  Briefcase,
  Building2,
  Layers,
  Clock,
  Workflow,
  Gauge,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  AlertTriangle,
  CalendarRange,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  AvatarGroup,
  Button,
  Drawer,
  Skeleton,
  toast,
} from "@/components/ui/primitives";
import { PremiumCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import { serviceColor } from "@/lib/status-colors";

// ─── Types (matches /api/services GET shape, additive fields included) ──

type Svc = {
  id: string;
  name: string;
  slug?: string | null;
  description: string | null;
  durationMinutes: number;
  price: number;
  bufferBefore: number;
  bufferAfter: number;
  color: string | null;
  isActive: number;
  videoProvider?: string | null;
  staff: { userId: string; name: string }[];
  // Additive enrichment from the extended GET
  departmentCount?: number;
  departmentNames?: string[];
  bookingsLast30d?: number;
};

const DEFAULT_COLORS = [
  "#359df3", "#7c3aed", "#0d9488", "#ea580c",
  "#db2777", "#65a30d", "#0891b2", "#c026d3",
];

const PROVIDERS = [
  { id: "google_meet", label: "Google Meet",     note: "Auto-creates a Meet link" },
  { id: "zoom",        label: "Zoom",            note: "Manual link · OAuth in a future release" },
  { id: "teams",       label: "Microsoft Teams", note: "Manual link · OAuth in a future release" },
  { id: "none",        label: "No video",        note: "In-person or phone" },
] as const;

// Readiness derivation — honest signal from real fields.
type Readiness = "ready" | "partial" | "inactive";
function deriveReadiness(s: Svc): Readiness {
  if (s.isActive !== 1) return "inactive";
  if (s.staff.length === 0) return "partial";
  return "ready";
}

const READINESS_LABEL: Record<Readiness, string> = {
  ready: "Ready",
  partial: "Partial",
  inactive: "Inactive",
};

// ─── Main client ───────────────────────────────────────────────────

export default function ServicesClient({
  isAdmin,
  allStaff,
  allDepartments,
}: {
  isAdmin: boolean;
  allStaff: { id: string; name: string }[];
  allDepartments: { id: string; name: string; color: string | null }[];
}) {
  const [rows, setRows] = React.useState<Svc[] | null>(null);
  const [openId, setOpenId] = React.useState<string | "new" | null>(null);

  async function reload() {
    // Use ?include=all so the admin services page surfaces inactive
    // services with their readiness state.
    const data = await fetch("/api/services?include=all").then((r) => r.json());
    setRows(Array.isArray(data) ? data : []);
  }
  React.useEffect(() => { reload(); }, []);

  // ── Derived metrics ────────────────────────────────────────────
  const metrics = React.useMemo(() => {
    const list = rows ?? [];
    const total = list.length;
    const active = list.filter((s) => s.isActive === 1).length;
    const withStaff = list.filter((s) => s.staff.length > 0).length;
    const ready = list.filter((s) => deriveReadiness(s) === "ready").length;
    const staffAssignments = list.reduce((sum, s) => sum + s.staff.length, 0);
    const departmentIds = new Set<string>();
    list.forEach((s) => (s.departmentNames ?? []).forEach((_n, _i) => { /* names don't expose ids; track count via departmentCount */ }));
    // For the workspace KPI we use the union of department coverage —
    // services with ANY department coverage. Honest because we have
    // departmentCount per service.
    const servicesWithDepartments = list.filter((s) => (s.departmentCount ?? 0) > 0).length;
    const totalBookings30d = list.reduce((sum, s) => sum + (s.bookingsLast30d ?? 0), 0);
    const avgDuration =
      active > 0
        ? Math.round(
            list.filter((s) => s.isActive === 1).reduce((sum, s) => sum + s.durationMinutes, 0) / active,
          )
        : 0;
    const schedulingReadinessPct =
      active > 0 ? Math.round((withStaff / active) * 100) : 0;
    void departmentIds;
    return {
      total, active, ready, withStaff, staffAssignments,
      servicesWithDepartments, totalBookings30d, avgDuration, schedulingReadinessPct,
    };
  }, [rows]);

  // ── Operational signal ─────────────────────────────────────────
  const signal = React.useMemo(() => deriveSignal(metrics), [metrics]);

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
        <ServicesHero isAdmin={isAdmin} onAdd={() => setOpenId("new")} />
      </FadeIn>

      {/* ── Operational signal ──────────────────────────────── */}
      <FadeIn delay={1}>
        <OperationalSignalStrip text={signal} loading={rows === null} />
      </FadeIn>

      {/* ── KPI grid ─────────────────────────────────────────── */}
      <FadeIn delay={2}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard
            label="Active services"
            value={String(metrics.active)}
            icon={Briefcase}
            tone="brand"
            hint={metrics.active === 0 ? "Awaiting service catalog" : `${metrics.total} total`}
            inactive={metrics.active === 0}
          />
          <KpiCard
            label="Staff assigned"
            value={String(metrics.staffAssignments)}
            icon={Users}
            tone="positive"
            hint={metrics.staffAssignments === 0 ? "Awaiting workforce assignment" : `${metrics.withStaff} of ${metrics.active} active`}
            inactive={metrics.staffAssignments === 0}
          />
          <KpiCard
            label="Department coverage"
            value={String(metrics.servicesWithDepartments)}
            icon={Building2}
            tone="brand"
            hint={metrics.servicesWithDepartments === 0 ? "Departments improve service routing" : `services linked to a dept`}
            inactive={metrics.servicesWithDepartments === 0}
          />
          <KpiCard
            label="Scheduling readiness"
            value={metrics.active === 0 ? "—" : `${metrics.schedulingReadinessPct}%`}
            icon={Workflow}
            tone={metrics.schedulingReadinessPct >= 80 ? "positive" : metrics.schedulingReadinessPct > 0 ? "brand" : "warning"}
            hint={metrics.active === 0 ? "Availability activates after staff assignment" : `${metrics.withStaff} of ${metrics.active} services staffed`}
            inactive={metrics.active === 0}
          />
          <KpiCard
            label="Avg booking duration"
            value={metrics.avgDuration === 0 ? "—" : `${metrics.avgDuration}m`}
            icon={Clock}
            tone="brand"
            hint={metrics.avgDuration === 0 ? "Tracks once services exist" : "Across active services"}
            inactive={metrics.avgDuration === 0}
          />
          <KpiCard
            label="Operational utilization"
            value="—"
            icon={Gauge}
            tone="neutral"
            hint="Coming soon · per-service utilization"
            inactive
          />
        </div>
      </FadeIn>

      {/* ── Service directory ─────────────────────────────── */}
      <FadeIn delay={3}>
        <div>
          <SectionHead
            eyebrow="Service catalog"
            title="Operational services"
            description="Each service is a scheduling unit connected to staff, departments, and booking coverage."
          />

          {rows === null ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-2xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <PremiumActivationState isAdmin={isAdmin} onAdd={() => setOpenId("new")} />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((s, idx) => (
                <li
                  key={s.id}
                  style={{ animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${Math.min(idx, 8) * 50}ms both` }}
                >
                  <ServiceOpCard svc={s} onOpen={() => setOpenId(s.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </FadeIn>

      {/* Drawer — logic preserved byte-identical, just receives extra
          allDepartments prop for future drawer surfaces (currently used
          for the scaffolded "linked departments" indicator). */}
      <ServiceDrawer
        openId={openId}
        onClose={() => setOpenId(null)}
        onSaved={() => { setOpenId(null); reload(); }}
        allStaff={allStaff}
        allDepartments={allDepartments}
        isAdmin={isAdmin}
        existing={rows ?? []}
      />
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────

function ServicesHero({
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
            Service intelligence
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Operational services
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
            Manage service delivery, workforce assignments, scheduling coverage, operational routing, and customer booking experiences.
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-1.5">
            <HeroAction href="/dashboard/availability" icon={CalendarCheck} label="Configure scheduling" tone="ghost" />
            <HeroAction href="/dashboard/staff" icon={Users} label="Assign staff" tone="ghost" />
            <HeroAction onClick={onAdd} icon={Plus} label="Add service" tone="primary" />
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

function OperationalSignalStrip({ text, loading }: { text: string; loading: boolean }) {
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <span aria-hidden className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent" />
        <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <Workflow className="h-4 w-4" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Service signal
            </div>
            <div className="relative mt-0.5 min-h-[1.5em] text-[13px] leading-relaxed text-ink">
              {loading ? (
                <span className="inline-block h-3 w-2/3 animate-pulse rounded bg-surface-inset" />
              ) : (
                <span
                  key={text}
                  className="block"
                  style={{ animation: "zm-row-in 0.55s cubic-bezier(0.16,1,0.3,1) both" }}
                >
                  {text}
                </span>
              )}
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
  active: number;
  ready: number;
  withStaff: number;
  staffAssignments: number;
  servicesWithDepartments: number;
  totalBookings30d: number;
}): string {
  if (m.active === 0) {
    return "No services configured yet. Services power workforce scheduling, routing, customer bookings, and operational intelligence.";
  }
  if (m.withStaff === 0) {
    return "Assign staff to activate operational routing. Services without staff aren't bookable.";
  }
  if (m.ready < m.active) {
    return `${m.ready} of ${m.active} active services are ready for booking. Assigning staff to the remaining ${m.active - m.ready} activates routing.`;
  }
  if (m.servicesWithDepartments < m.active) {
    return `${m.active} active service${m.active === 1 ? "" : "s"} ready for booking. Departments improve service distribution and scheduling coverage.`;
  }
  if (m.totalBookings30d === 0) {
    return `${m.active} active service${m.active === 1 ? "" : "s"} fully staffed and department-connected. Booking flow will populate metrics as customers arrive.`;
  }
  return `${m.ready} services delivering operationally — ${m.staffAssignments} staff assignments, ${m.totalBookings30d} bookings routed in the last 30 days.`;
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

// ─── Service operational card ─────────────────────────────────────

function ServiceOpCard({ svc, onOpen }: { svc: Svc; onOpen: () => void }) {
  const accent = serviceColor(svc.id, svc.color);
  const readiness = deriveReadiness(svc);
  const inactive = svc.isActive !== 1;

  return (
    <button
      onClick={onOpen}
      className={cn(
        "group relative block w-full overflow-hidden rounded-2xl border bg-surface p-4 text-left shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        inactive
          ? "border-border opacity-80 hover:opacity-100"
          : "border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
      )}
    >
      {/* Brand-color glowing left rail */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 rounded-l-2xl"
        style={{ backgroundColor: accent, boxShadow: `0 0 12px ${accent}55` }}
      />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

      <div className="relative pl-2">
        {/* Header — color swatch + name + readiness */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              <Briefcase className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <h3 className="min-w-0 truncate text-[14.5px] font-semibold tracking-tight text-ink">{svc.name}</h3>
          </div>
          <ReadinessChip readiness={readiness} />
        </div>

        {/* Description */}
        {svc.description && (
          <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{svc.description}</p>
        )}

        {/* Duration + price strip */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
          <span className="inline-flex items-center gap-1 rounded-md bg-surface-inset/60 px-2 py-0.5 font-medium text-ink-muted">
            <Clock className="h-3 w-3 text-brand-accent" strokeWidth={2} />
            <span className="tabular-nums text-ink">{svc.durationMinutes}</span> min
          </span>
          {svc.price > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-surface-inset/60 px-2 py-0.5 font-semibold text-ink">
              ${(svc.price / 100).toFixed(0)}
            </span>
          )}
          {svc.bookingsLast30d !== undefined && svc.bookingsLast30d > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50/70 px-2 py-0.5 font-medium text-emerald-700 ring-1 ring-emerald-200/40">
              <CalendarRange className="h-3 w-3" strokeWidth={2} />
              <span className="tabular-nums">{svc.bookingsLast30d}</span> · 30d
            </span>
          )}
        </div>

        {/* Department chips */}
        {svc.departmentNames && svc.departmentNames.length > 0 && (
          <div className="mt-3">
            <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Departments</div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {svc.departmentNames.map((d) => (
                <DepartmentChip key={d} name={d} />
              ))}
              {svc.departmentCount !== undefined && svc.departmentCount > svc.departmentNames.length && (
                <span className="text-[10px] text-ink-subtle">
                  +{svc.departmentCount - svc.departmentNames.length} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Staff + routing footer */}
        <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3 text-[11px]">
          <div className="flex items-center gap-2">
            {svc.staff.length > 0 ? (
              <>
                <AvatarGroup members={svc.staff.map((u) => ({ name: u.name }))} max={3} />
                <span className="text-ink-muted">
                  <span className="font-semibold tabular-nums text-ink">{svc.staff.length}</span>
                  {" "}staff
                </span>
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-ink-subtle">
                <AlertTriangle className="h-3 w-3 text-amber-500" strokeWidth={2} />
                No staff assigned
              </span>
            )}
          </div>
          {readiness === "ready" && (
            <span className="inline-flex items-center gap-1 text-ink-muted">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.40)]" />
              Routing
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function ReadinessChip({ readiness }: { readiness: Readiness }) {
  const cfg =
    readiness === "ready" ? {
      cls: "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40",
      dot: "bg-emerald-500",
      icon: CheckCircle2,
    }
    : readiness === "partial" ? {
      cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40",
      dot: "bg-amber-500",
      icon: CircleDot,
    }
    : {
      cls: "bg-surface-inset text-ink-muted ring-border/50",
      dot: "bg-ink-subtle/40",
      icon: X,
    };

  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1", cfg.cls)}>
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {READINESS_LABEL[readiness]}
    </span>
  );
}

function DepartmentChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
      <Building2 className="h-2.5 w-2.5 text-brand-accent" strokeWidth={2} />
      <span className="truncate max-w-[100px]">{name}</span>
    </span>
  );
}

// ─── Premium activation empty state ───────────────────────────────

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
          <Briefcase className="h-7 w-7" strokeWidth={1.5} />
        </div>
        <h3 className="mt-4 text-[18px] font-semibold tracking-tight text-ink">
          Build your operational service catalog
        </h3>
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
          Services power workforce scheduling, routing, customer bookings, and operational intelligence.
        </p>

        {isAdmin && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              Create your first service
            </button>
          </div>
        )}

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
      title: "Create services",
      description: "Define the offerings customers will book — duration, pricing, and delivery format.",
      icon: Plus,
      action: { kind: "onAdd" },
    },
    {
      key: "assign-departments",
      title: "Assign departments",
      description: "Departments organize service delivery. Services link to a department via the staff that deliver them.",
      icon: Building2,
      action: { kind: "link", href: "/dashboard/departments", label: "Open departments" },
    },
    {
      key: "route-staff",
      title: "Route staff",
      description: "Assign at least one staff member to each service to activate booking routing.",
      icon: Users,
      action: { kind: "link", href: "/dashboard/staff", label: "Open staff" },
    },
    {
      key: "configure-availability",
      title: "Configure availability",
      description: "Set weekly hours and scheduling rules so the booking flow can offer real slots.",
      icon: CalendarCheck,
      action: { kind: "link", href: "/dashboard/availability", label: "Open availability" },
    },
    {
      key: "activate-coverage",
      title: "Activate booking coverage",
      description: "Once services are staffed, the public booking pages start surfacing live availability automatically.",
      icon: Workflow,
      action: { kind: "none" },
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
            Five steps to activate your service catalog
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
            style={{ animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${i * 60}ms both` }}
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
          Add service
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

// ─── ServiceDrawer — logic preserved 100%, chrome refreshed ───────

function ServiceDrawer({
  openId, onClose, onSaved, allStaff, allDepartments, isAdmin, existing,
}: {
  openId: string | "new" | null;
  onClose: () => void;
  onSaved: () => void;
  allStaff: { id: string; name: string }[];
  allDepartments: { id: string; name: string; color: string | null }[];
  isAdmin: boolean;
  existing: Svc[];
}) {
  const isNew = openId === "new";
  const svc = openId && openId !== "new" ? existing.find((s) => s.id === openId) : null;

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [durationMinutes, setDurationMinutes] = React.useState(30);
  const [price, setPrice] = React.useState(0);
  const [bufferBefore, setBufferBefore] = React.useState(0);
  const [bufferAfter, setBufferAfter] = React.useState(0);
  const [color, setColor] = React.useState<string>(DEFAULT_COLORS[0]);
  const [isActive, setIsActive] = React.useState(true);
  const [videoProvider, setVideoProvider] = React.useState<string>("google_meet");
  const [selectedStaff, setSelectedStaff] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (svc) {
      setName(svc.name); setDescription(svc.description ?? "");
      setDurationMinutes(svc.durationMinutes); setPrice(svc.price);
      setBufferBefore(svc.bufferBefore); setBufferAfter(svc.bufferAfter);
      setColor(svc.color ?? DEFAULT_COLORS[0]);
      setIsActive(svc.isActive === 1);
      setVideoProvider(svc.videoProvider ?? "google_meet");
      setSelectedStaff(new Set(svc.staff.map((s) => s.userId)));
    } else if (isNew) {
      setName(""); setDescription(""); setDurationMinutes(30);
      setPrice(0); setBufferBefore(0); setBufferAfter(0);
      setColor(DEFAULT_COLORS[0]); setIsActive(true);
      setVideoProvider("google_meet");
      setSelectedStaff(new Set());
    }
  }, [openId, svc, isNew]);

  function toggleStaff(id: string) {
    setSelectedStaff((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    setBusy(true);
    try {
      const payload = {
        name, description: description || null,
        durationMinutes, price, bufferBefore, bufferAfter, color,
        isActive,
        videoProvider,
        staffUserIds: Array.from(selectedStaff),
      };
      const url = isNew ? "/api/services" : `/api/services/${svc!.id}`;
      const method = isNew ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast(isNew ? "Service created" : "Service updated", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!svc) return;
    if (!window.confirm("Delete this service? Past bookings keep it; future visibility ends.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${svc.id}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast(d.deleted ? "Service deleted" : "Service archived", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  const open = Boolean(openId);
  void allDepartments; // currently surfaced via the GET response's departmentNames; reserved for the future explicit department assignment drawer surface.

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="Service editor">
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-brand-subtle/30 via-surface to-surface p-5">
          <div aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-[0_2px_8px_rgba(15,23,42,0.12)]"
                style={{ backgroundColor: color }}
                aria-hidden
              >
                <Briefcase className="h-5 w-5" strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="text-[17px] font-semibold tracking-tight text-ink">
                  {isNew ? "New service" : svc?.name ?? ""}
                </h2>
                <p className="mt-0.5 text-[11.5px] text-ink-muted">
                  {isNew ? "Set basics, then assign staff to activate routing." : "Edit details and operational assignments."}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          <Field label="Name">
            <input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={description} disabled={!isAdmin} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)">
              <input type="number" min={5} step={5} value={durationMinutes} disabled={!isAdmin} onChange={(e) => setDurationMinutes(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
            <Field label="Price (cents)">
              <input type="number" min={0} step={50} value={price} disabled={!isAdmin} onChange={(e) => setPrice(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
            <Field label="Buffer before">
              <input type="number" min={0} max={240} value={bufferBefore} disabled={!isAdmin} onChange={(e) => setBufferBefore(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
            <Field label="Buffer after">
              <input type="number" min={0} max={240} value={bufferAfter} disabled={!isAdmin} onChange={(e) => setBufferAfter(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
          </div>

          <Field label="Color">
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => isAdmin && setColor(c)}
                  disabled={!isAdmin}
                  aria-label={`Color ${c}`}
                  className={"h-7 w-7 rounded-md border " + (color === c ? "ring-2 ring-offset-2 ring-brand-accent" : "border-border")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </Field>

          <Field label="Video provider">
            <div className="space-y-1.5">
              {PROVIDERS.map((p) => {
                const on = videoProvider === p.id;
                return (
                  <label key={p.id} className={"flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm " + (on ? "ring-1 ring-brand-accent/30" : "")}>
                    <input
                      type="radio"
                      name="videoProvider"
                      value={p.id}
                      checked={on}
                      disabled={!isAdmin}
                      onChange={() => setVideoProvider(p.id)}
                      className="mt-0.5 h-4 w-4 accent-brand-accent"
                    />
                    <span className="flex-1">
                      <span className="block text-ink">{p.label}</span>
                      <span className="block text-[11px] text-ink-subtle">{p.note}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>

          <Field label="Status">
            <label className="inline-flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={isActive} disabled={!isAdmin} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-brand-accent" />
              Active and bookable
            </label>
          </Field>

          <Field label="Staff who deliver this service">
            <div className="space-y-1.5">
              {allStaff.length === 0 && (
                <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-ink-subtle">
                  No staff in workspace yet.
                </div>
              )}
              {allStaff.map((u) => {
                const on = selectedStaff.has(u.id);
                return (
                  <label key={u.id} className={"flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm " + (on ? "ring-1 ring-brand-accent/30" : "")}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!isAdmin}
                      onChange={() => toggleStaff(u.id)}
                      className="h-4 w-4 accent-brand-accent"
                    />
                    <span className="flex-1 text-ink">{u.name}</span>
                  </label>
                );
              })}
            </div>
            {!isNew && svc && svc.departmentNames && svc.departmentNames.length > 0 && (
              <div className="mt-2 rounded-lg border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
                <span className="font-semibold uppercase tracking-wider text-ink-muted">Departments &middot; </span>
                {svc.departmentNames.join(", ")}
                {svc.departmentCount !== undefined && svc.departmentCount > svc.departmentNames.length && (
                  <> +{svc.departmentCount - svc.departmentNames.length} more</>
                )} &nbsp;<span className="text-ink-subtle/80">(derived from assigned staff)</span>
              </div>
            )}
          </Field>

          {/* Scaffolded modules — Phase 8 honest placeholders */}
          {!isNew && (
            <div className="space-y-2">
              <ScaffoldModule
                icon={CalendarRange}
                title="Utilization trends"
                caption="Per-service utilization curves will surface here as the scheduling intelligence layer matures."
              />
              <ScaffoldModule
                icon={Workflow}
                title="Workforce load"
                caption="Distribution of bookings across assigned staff and warning signals for bottlenecks."
              />
              <ScaffoldModule
                icon={Layers}
                title="Department performance"
                caption="Booking conversion and coverage by department, once departments are configured."
              />
            </div>
          )}
        </div>

        {isAdmin && (
          <div className="flex items-center justify-between border-t border-border p-4">
            {!isNew ? (
              <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                {busy ? "…" : "Delete"}
              </Button>
            ) : <span />}
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create service" : "Save changes"}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-muted">{label}</div>
      {children}
    </div>
  );
}

function ScaffoldModule({
  icon: Icon,
  title,
  caption,
}: {
  icon: LucideIcon;
  title: string;
  caption: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border bg-surface-inset/30 p-3">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-3">
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle ring-1 ring-border/40">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</h4>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
              Coming soon
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{caption}</p>
        </div>
      </div>
    </div>
  );
}

