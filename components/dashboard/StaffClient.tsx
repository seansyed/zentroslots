"use client";

/**
 * StaffClient — Phase 11A Workforce Intelligence Center.
 *
 * UI-only refinement of the staff workspace. All API contracts
 * (`/api/staff` GET, `/api/staff/:id` GET + PATCH, `/api/staff/:id/role`
 * POST) are preserved byte-identical. No backend, schema, or auth
 * changes. Data not present in the existing API is NOT fabricated —
 * future intelligence modules are scaffolded as labelled placeholders
 * in the drawer per Step 8.
 */

import * as React from "react";
import Link from "next/link";
import {
  Sparkles,
  UserPlus,
  Mail,
  Layers,
  Activity,
  Users,
  CalendarRange,
  CalendarCheck,
  Gauge,
  Crown,
  ShieldCheck,
  Search,
  X,
  CheckCircle2,
  Clock,
  TrendingUp,
  CircleDot,
  Workflow,
  MessageSquare,
  CalendarDays,
  StickyNote,
  Infinity as InfinityIcon,
  CreditCard,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";

import {
  Avatar,
  Badge,
  Button,
  Card,
  Drawer,
  Modal,
  Skeleton,
  toast,
} from "@/components/ui/primitives";
import { PremiumCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import ActivityTimeline from "@/components/dashboard/ActivityTimeline";

// ─── Types (matching /api/staff) ────────────────────────────────────

type StaffRow = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  avatarUrl: string | null;
  bio: string | null;
  specialties: string | null;
  googleConnected: boolean;
  upcomingCount: number;
  completedThisMonth: number;
  role?: "staff" | "manager" | "admin";
};

type ServiceItem = { id: string; name: string; durationMinutes: number; color: string | null };

type StaffDetail = {
  staff: StaffRow & { primaryLocationId: string | null; departmentId: string | null; role: "staff" | "manager" };
  assignedServices: { id: string; name: string }[];
  weeklyAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  stats: { completed30d: number; cancelled30d: number };
  upcoming: {
    id: string; startAt: string; endAt: string; status: string;
    clientName: string; clientEmail: string; meetLink: string | null; serviceName: string;
  }[];
};

const TABS = ["overview", "services", "schedule", "activity"] as const;
type Tab = (typeof TABS)[number];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Workforce seats (matches lib/billing/seats.ts → toWorkforceSeatsJson).
// totalSeats / availableSeats arrive as null when the plan is
// unlimited — the `unlimited` flag is the authoritative signal.
type SeatsSnapshot = {
  plan: string;
  planName: string;
  planPriceCents: number | null;
  planInterval: "month" | null;
  planDescription: string;
  includedSeats: number;
  extraSeats: number;
  totalSeats: number | null;
  usedSeats: number;
  availableSeats: number | null;
  unlimited: boolean;
  atCapacity: boolean;
  nearLimit: boolean;
  percent: number;
  level: "healthy" | "warning" | "critical" | "unlimited";
  addOnSupported: boolean;
  hasSoftDeactivation: boolean;
};

// Workload derivation — honest signal from real upcoming count.
type Workload = "available" | "active" | "near-capacity";
function deriveWorkload(upcoming: number): Workload {
  if (upcoming >= 15) return "near-capacity";
  if (upcoming >= 5) return "active";
  return "available";
}

const WORKLOAD_LABEL: Record<Workload, string> = {
  available: "Available",
  active: "Active",
  "near-capacity": "Near capacity",
};

// ─── Main client ────────────────────────────────────────────────────

export default function StaffClient({
  isAdmin,
  canChangeRoles,
  allServices,
  tenantSlug,
  tenantName,
}: {
  userTimezone: string;
  // `isAdmin` here is the legacy name; it now means "admin OR manager" —
  // i.e. who can edit staff records & service assignments.
  isAdmin: boolean;
  // Strictly admin-only: who can promote/demote between staff and manager.
  canChangeRoles: boolean;
  allServices: ServiceItem[];
  // Threaded through from the server page so the invite modal can
  // surface the workspace sign-up share link. There is no in-app
  // create/invite flow today — invites happen via the public sign-up
  // flow + the tenant slug. The modal explains this calmly.
  tenantSlug?: string | null;
  tenantName?: string | null;
}) {
  const [rows, setRows] = React.useState<StaffRow[] | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [addStaffOpen, setAddStaffOpen] = React.useState(false);
  const [capacityOpen, setCapacityOpen] = React.useState(false);
  const [overviewOpen, setOverviewOpen] = React.useState(false);
  const [seats, setSeats] = React.useState<SeatsSnapshot | null>(null);

  // Toolbar state
  const [q, setQ] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState<"all" | "manager" | "staff">("all");
  const [workloadFilter, setWorkloadFilter] = React.useState<"all" | Workload>("all");

  // Refetch seats whenever the directory changes — keeps the
  // capacity chip in sync after a teammate signs up. Tenant-scoped
  // by requireUser() on the server.
  const refetchSeats = React.useCallback(() => {
    let cancelled = false;
    fetch("/api/tenant/seats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SeatsSnapshot | null) => {
        if (cancelled) return;
        if (d) setSeats(d);
      })
      .catch(() => { /* leave previous snapshot in place */ });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/staff")
      .then((r) => r.json())
      .then((d) => !cancelled && setRows(Array.isArray(d) ? d : []))
      .catch(() => !cancelled && setRows([]));
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    refetchSeats();
  }, [refetchSeats, rows]);

  // Seat-aware modal openers. Both check availability the same way
  // (the server still enforces via assertCanAddStaff at signup time)
  // but route to genuinely different surfaces:
  //
  //   handleAddStaffClick    → AddStaffModal (operational provisioning)
  //   handleInviteClick      → InviteTeammateModal (collaborative)
  //
  // If seats are unknown yet (initial load), we err on the side of
  // opening the requested flow so the UX doesn't stall.
  const hasAvailableSeats = React.useCallback((): boolean => {
    if (!seats) return true;
    if (seats.unlimited) return true;
    if (seats.availableSeats === null) return true;
    return seats.availableSeats > 0;
  }, [seats]);

  const handleAddStaffClick = React.useCallback(() => {
    if (hasAvailableSeats()) setAddStaffOpen(true);
    else setCapacityOpen(true);
  }, [hasAvailableSeats]);

  const handleInviteClick = React.useCallback(() => {
    if (hasAvailableSeats()) setInviteOpen(true);
    else setCapacityOpen(true);
  }, [hasAvailableSeats]);

  // ── Derived metrics ────────────────────────────────────────────
  const metrics = React.useMemo(() => {
    const list = rows ?? [];
    const total = list.length;
    const activeThisWeek = list.filter((s) => s.upcomingCount > 0).length;
    const totalUpcoming = list.reduce((s, r) => s + r.upcomingCount, 0);
    const totalCompleted = list.reduce((s, r) => s + r.completedThisMonth, 0);
    const avgUpcoming = total > 0 ? Math.round(totalUpcoming / total) : 0;
    const calendarConnected = list.filter((s) => s.googleConnected).length;
    const calendarCoveragePct = total > 0 ? Math.round((calendarConnected / total) * 100) : 0;
    const managers = list.filter((s) => s.role === "manager").length;
    const managerRatioPct = total > 0 ? Math.round((managers / total) * 100) : 0;
    const nearCapacity = list.filter((s) => deriveWorkload(s.upcomingCount) === "near-capacity").length;
    return {
      total, activeThisWeek, avgUpcoming, totalCompleted,
      calendarConnected, calendarCoveragePct,
      managers, managerRatioPct, nearCapacity,
    };
  }, [rows]);

  // ── Filtered rows ─────────────────────────────────────────────
  const filtered = React.useMemo(() => {
    if (!rows) return null;
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (term) {
        const hay = `${r.name} ${r.email}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (roleFilter !== "all") {
        if ((r.role ?? "staff") !== roleFilter) return false;
      }
      if (workloadFilter !== "all") {
        if (deriveWorkload(r.upcomingCount) !== workloadFilter) return false;
      }
      return true;
    });
  }, [rows, q, roleFilter, workloadFilter]);

  // ── Operational signal ────────────────────────────────────────
  // The seat-capacity signal takes precedence over workload signals
  // when present (at-capacity > 80%-warning > everything else),
  // because seat headroom is the most actionable signal an admin
  // can see in the strip.
  const signal = React.useMemo(() => {
    if (seats && !seats.unlimited) {
      if (seats.atCapacity) {
        return `Workforce capacity has been reached — ${seats.usedSeats} of ${seats.totalSeats ?? seats.usedSeats} operational seats in use. Additional staffing requires more seats.`;
      }
      if (seats.nearLimit) {
        return `Workforce capacity nearing limit — ${seats.usedSeats} of ${seats.totalSeats ?? seats.usedSeats} operational seats in use (${seats.percent}%).`;
      }
    }
    return deriveSignal(metrics);
  }, [metrics, seats]);

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
        <StaffHero
          isAdmin={isAdmin}
          onAddStaff={handleAddStaffClick}
          onInvite={handleInviteClick}
          seats={seats}
          onOpenCapacityOverview={() => setOverviewOpen(true)}
        />
      </FadeIn>

      {/* ── AI Workforce Intelligence Strip ─────────────────── */}
      <FadeIn delay={1}>
        <WorkforceSignalStrip text={signal} loading={rows === null} />
      </FadeIn>

      {/* ── KPI grid ─────────────────────────────────────────── */}
      <FadeIn delay={2}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Total staff"        value={String(metrics.total)}            icon={Users}        tone="brand"     hint="In your organization" />
          <KpiCard label="Active this week"   value={String(metrics.activeThisWeek)}   icon={Activity}     tone="positive"  hint={`${metrics.total > 0 ? Math.round((metrics.activeThisWeek / Math.max(1, metrics.total)) * 100) : 0}% of staff`} />
          <KpiCard label="Avg upcoming load"  value={String(metrics.avgUpcoming)}      icon={CalendarRange} tone="brand"     hint="Bookings per staff" />
          <KpiCard label="Completed (month)"  value={String(metrics.totalCompleted)}   icon={CalendarCheck} tone="positive"  hint="Across the team" />
          <KpiCard label="Calendar coverage"  value={`${metrics.calendarCoveragePct}%`} icon={Gauge}        tone={metrics.calendarCoveragePct >= 75 ? "positive" : "warning"} hint={`${metrics.calendarConnected} connected`} />
          <KpiCard label="Manager ratio"      value={`${metrics.managerRatioPct}%`}    icon={Crown}        tone="neutral"   hint={`${metrics.managers} manager${metrics.managers === 1 ? "" : "s"}`} />
        </div>
      </FadeIn>

      {/* ── Directory ────────────────────────────────────────── */}
      <FadeIn delay={3}>
        <div>
          <SectionHead
            eyebrow="Operational directory"
            title="Workforce"
            description="Browse, filter, and open any staff member to review their workload, services, and schedule."
          />

          <Toolbar
            q={q}
            onQ={setQ}
            roleFilter={roleFilter}
            onRoleFilter={setRoleFilter}
            workloadFilter={workloadFilter}
            onWorkloadFilter={setWorkloadFilter}
            disabled={rows === null || rows.length === 0}
          />

          <div className="mt-3">
            {rows === null ? (
              <div className="space-y-2.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-[88px] rounded-2xl" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <PremiumEmptyState onAddStaff={handleAddStaffClick} onInvite={handleInviteClick} />
            ) : (filtered ?? []).length === 0 ? (
              <FilteredEmpty onClear={() => { setQ(""); setRoleFilter("all"); setWorkloadFilter("all"); }} />
            ) : (
              <ul className="space-y-2.5">
                {(filtered ?? []).map((s, idx) => (
                  <li key={s.id}>
                    <StaffOpRow
                      staff={s}
                      selected={openId === s.id}
                      onOpen={() => setOpenId(s.id)}
                      animationIndex={idx}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </FadeIn>

      <StaffDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        allServices={allServices}
        isAdmin={isAdmin}
        canChangeRoles={canChangeRoles}
      />

      <AddStaffModal
        open={addStaffOpen}
        onClose={() => setAddStaffOpen(false)}
        tenantSlug={tenantSlug ?? null}
        tenantName={tenantName ?? null}
        allServices={allServices}
        canChangeRoles={canChangeRoles}
      />

      <InviteTeammateModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        tenantSlug={tenantSlug ?? null}
        tenantName={tenantName ?? null}
        canChangeRoles={canChangeRoles}
      />

      <CapacityReachedModal
        open={capacityOpen}
        onClose={() => setCapacityOpen(false)}
        seats={seats}
      />

      <WorkforceCapacityOverviewModal
        open={overviewOpen}
        onClose={() => setOverviewOpen(false)}
        seats={seats}
        onAddStaff={() => {
          setOverviewOpen(false);
          handleAddStaffClick();
        }}
      />
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────

function StaffHero({
  isAdmin,
  onAddStaff,
  onInvite,
  seats,
  onOpenCapacityOverview,
}: {
  isAdmin: boolean;
  onAddStaff: () => void;
  onInvite: () => void;
  seats: SeatsSnapshot | null;
  onOpenCapacityOverview: () => void;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.16] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.32]"
        style={{
          backgroundImage:
            "radial-gradient(800px 220px at 80% 0%, rgba(53,157,243,0.06), transparent 70%), radial-gradient(600px 200px at 0% 100%, rgba(16,185,129,0.05), transparent 70%)",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
      <span
        aria-hidden
        className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
      />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            Workforce intelligence center
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Workforce operations
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
            Monitor staffing health, scheduling balance, responsiveness, and operational coverage across your service organization.
          </p>

          {/* Workforce capacity chip cluster — plan / seat usage /
              capacity status. All three open the WorkforceCapacityOverviewModal
              so the user has a single calm intelligence surface. */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <PlanChip seats={seats} onOpen={onOpenCapacityOverview} />
            <SeatCapacityChip seats={seats} onOpen={onOpenCapacityOverview} />
            <CapacityStatusChip seats={seats} onOpen={onOpenCapacityOverview} />
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-1.5">
            <HeroAction href="/dashboard/services" icon={Layers} label="Assign services" tone="ghost" />
            <HeroAction onClick={onInvite} icon={Mail} label="Invite teammate" tone="ghost" />
            <HeroAction onClick={onAddStaff} icon={UserPlus} label="Add staff" tone="primary" />
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
  // Exactly one of href / onClick must be set. `href` renders a Next.js
  // Link (real navigation); `onClick` renders a button (opens a modal
  // or runs a handler). This prevents any caller from accidentally
  // routing to a dead URL.
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

// ─── AI Workforce Signal Strip ──────────────────────────────────────

function WorkforceSignalStrip({ text, loading }: { text: string; loading: boolean }) {
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />
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
              Workforce signal
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-ink">
              {loading ? (
                <span className="inline-block h-3 w-2/3 animate-pulse rounded bg-surface-inset" />
              ) : (
                text
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
  total: number;
  activeThisWeek: number;
  nearCapacity: number;
  calendarCoveragePct: number;
}): string {
  if (m.total === 0) {
    return "No staff yet. Add your first team member to begin building workforce intelligence.";
  }
  if (m.nearCapacity >= 2) {
    return `${m.nearCapacity} staff members are nearing scheduling saturation. Consider rebalancing load or expanding capacity.`;
  }
  if (m.activeThisWeek === 0) {
    return "No staff have upcoming bookings this week. Calendar load is unusually quiet across the team.";
  }
  if (m.calendarCoveragePct < 50 && m.total >= 2) {
    return `Calendar sync coverage is at ${m.calendarCoveragePct}%. Connecting calendars improves availability accuracy.`;
  }
  return `Workforce load is balanced. ${m.activeThisWeek} of ${m.total} staff active this week, calendar coverage at ${m.calendarCoveragePct}%.`;
}

// ─── KPI card (real data only — no fake sparklines) ────────────────

function KpiCard({
  label,
  value,
  icon,
  tone,
  hint,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning" | "neutral";
  hint: string;
}) {
  return (
    <MetricCard
      label={label}
      value={value}
      icon={icon}
      tone={tone}
      sparkline={
        <div className="text-right text-[10px] font-medium text-ink-subtle">
          {hint}
        </div>
      }
    />
  );
}

// ─── Toolbar ────────────────────────────────────────────────────────

function Toolbar({
  q,
  onQ,
  roleFilter,
  onRoleFilter,
  workloadFilter,
  onWorkloadFilter,
  disabled,
}: {
  q: string;
  onQ: (v: string) => void;
  roleFilter: "all" | "manager" | "staff";
  onRoleFilter: (v: "all" | "manager" | "staff") => void;
  workloadFilter: "all" | Workload;
  onWorkloadFilter: (v: "all" | Workload) => void;
  disabled: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-3 shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" strokeWidth={1.75} />
          <input
            type="text"
            value={q}
            onChange={(e) => onQ(e.target.value)}
            placeholder="Search by name or email"
            disabled={disabled}
            className="w-full rounded-lg border border-border bg-surface-inset/40 py-2 pl-9 pr-3 text-[13px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:bg-surface focus:ring-2 focus:ring-brand-accent/20 disabled:opacity-50"
            style={{ transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" }}
          />
          {q && (
            <button
              onClick={() => onQ("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-inset hover:text-ink"
            >
              <X className="h-3 w-3" strokeWidth={2} />
            </button>
          )}
        </div>

        <SegPills
          label="Role"
          value={roleFilter}
          onChange={(v) => onRoleFilter(v as "all" | "manager" | "staff")}
          options={[
            { value: "all", label: "All" },
            { value: "manager", label: "Manager" },
            { value: "staff", label: "Staff" },
          ]}
          disabled={disabled}
        />

        <SegPills
          label="Workload"
          value={workloadFilter}
          onChange={(v) => onWorkloadFilter(v as "all" | Workload)}
          options={[
            { value: "all", label: "All" },
            { value: "available", label: "Available" },
            { value: "active", label: "Active" },
            { value: "near-capacity", label: "Near capacity" },
          ]}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function SegPills({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</span>
      <div className="inline-flex items-center rounded-lg bg-surface-inset/60 p-0.5">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              disabled={disabled}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-all duration-[180ms] disabled:opacity-50",
                active
                  ? "bg-surface text-ink shadow-soft ring-1 ring-border"
                  : "text-ink-muted hover:bg-surface/60 hover:text-ink"
              )}
              style={{ transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Staff operational row ─────────────────────────────────────────

function StaffOpRow({
  staff,
  selected,
  onOpen,
  animationIndex,
}: {
  staff: StaffRow;
  selected: boolean;
  onOpen: () => void;
  animationIndex: number;
}) {
  const role = (staff.role ?? "staff") as "staff" | "manager" | "admin";
  const workload = deriveWorkload(staff.upcomingCount);
  const wl = WORKLOAD_TINT[workload];

  return (
    <button
      onClick={onOpen}
      className={cn(
        "group relative block w-full overflow-hidden rounded-2xl border bg-surface px-4 py-3.5 text-left shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        selected
          ? "border-brand-accent/30 shadow-lift ring-1 ring-brand-accent/15"
          : "border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
      )}
      style={{
        animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${Math.min(animationIndex, 8) * 40}ms both`,
      }}
    >
      {/* Selected rail */}
      {selected && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 rounded-l-2xl bg-brand-accent shadow-[0_0_10px_rgba(53,157,243,0.40)]" />
      )}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

      <div className="relative flex items-center gap-3.5">
        {/* Avatar with workload halo */}
        <div className="relative shrink-0">
          <span
            aria-hidden
            className={cn("absolute -inset-1 rounded-full opacity-70 blur-[6px]", wl.halo)}
          />
          <span className="relative inline-block">
            <Avatar name={staff.name} src={staff.avatarUrl} size="md" />
            {/* Workload dot */}
            <span
              aria-hidden
              className={cn(
                "absolute -bottom-0.5 -right-0.5 inline-block h-2.5 w-2.5 rounded-full ring-2 ring-surface",
                wl.dot
              )}
              title={WORKLOAD_LABEL[workload]}
            />
          </span>
        </div>

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[14px] font-semibold tracking-tight text-ink">{staff.name}</div>
            <RoleChip role={role} />
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">{staff.email}</div>
        </div>

        {/* Workload chip */}
        <div className="hidden shrink-0 sm:block">
          <WorkloadChip workload={workload} />
        </div>

        {/* Numeric ops */}
        <div className="hidden shrink-0 items-center gap-4 md:flex">
          <OpsStat icon={CalendarRange} value={staff.upcomingCount} label="upcoming" />
          <OpsStat icon={CheckCircle2} value={staff.completedThisMonth} label="this month" tone="positive" />
          <CalendarPill connected={staff.googleConnected} />
        </div>

        <ChevronGlyph />
      </div>
    </button>
  );
}

const WORKLOAD_TINT: Record<Workload, { halo: string; dot: string }> = {
  available: {
    halo: "bg-emerald-300/45",
    dot: "bg-emerald-500",
  },
  active: {
    halo: "bg-brand-accent/35",
    dot: "bg-brand-accent",
  },
  "near-capacity": {
    halo: "bg-amber-300/50",
    dot: "bg-amber-500",
  },
};

function WorkloadChip({ workload }: { workload: Workload }) {
  const cfg =
    workload === "available"     ? { cls: "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40", icon: CircleDot } :
    workload === "active"        ? { cls: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15", icon: Activity } :
                                    { cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40", icon: TrendingUp };
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ring-1", cfg.cls)}>
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      {WORKLOAD_LABEL[workload]}
    </span>
  );
}

function RoleChip({ role }: { role: "staff" | "manager" | "admin" }) {
  const cfg =
    role === "admin"   ? { label: "Admin",   icon: ShieldCheck, cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40" } :
    role === "manager" ? { label: "Manager", icon: Crown,       cls: "bg-violet-50/80 text-violet-700 ring-violet-200/40" } :
                         { label: "Staff",   icon: Users,       cls: "bg-surface-inset text-ink-muted ring-border/50" };
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1", cfg.cls)}>
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {cfg.label}
    </span>
  );
}

function OpsStat({
  icon: Icon,
  value,
  label,
  tone = "default",
}: {
  icon: LucideIcon;
  value: number;
  label: string;
  tone?: "default" | "positive";
}) {
  const numCls = tone === "positive" ? "text-emerald-700" : "text-ink";
  return (
    <div className="flex items-center gap-1.5 text-[11.5px]">
      <Icon className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.75} />
      <span className={cn("tabular-nums font-semibold", numCls)}>{value}</span>
      <span className="text-ink-subtle">{label}</span>
    </div>
  );
}

function CalendarPill({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50/70 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200/40">
      <CalendarCheck className="h-3 w-3" strokeWidth={2} />
      Synced
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-subtle ring-1 ring-border/40">
      <Clock className="h-3 w-3" strokeWidth={1.75} />
      Not synced
    </span>
  );
}

function ChevronGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4 shrink-0 text-ink-subtle transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 group-hover:text-brand-accent"
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Section header ────────────────────────────────────────────────

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
      {description && (
        <p className="mt-0.5 text-[12px] text-ink-muted">{description}</p>
      )}
    </header>
  );
}

// ─── Premium empty state ───────────────────────────────────────────

function PremiumEmptyState({
  onAddStaff,
  onInvite,
}: {
  onAddStaff: () => void;
  onInvite: () => void;
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
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />

      <div className="relative px-2 py-6 text-center sm:px-6 sm:py-8">
        <div className="zm-pulse-glow mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Users className="h-7 w-7" strokeWidth={1.5} />
        </div>
        <h3 className="mt-4 text-[17px] font-semibold tracking-tight text-ink">
          Build your operational team
        </h3>
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
          Invite staff, assign services, and coordinate workforce availability across your organization.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onAddStaff}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
          >
            <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
            Add staff
          </button>
          <button
            type="button"
            onClick={onInvite}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <Mail className="h-3.5 w-3.5" strokeWidth={1.75} />
            Invite teammate
          </button>
        </div>
      </div>
    </PremiumCard>
  );
}

function FilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/60 p-8 text-center">
      <div className="text-[13px] font-medium text-ink">No staff match these filters</div>
      <div className="mt-1 text-[12px] text-ink-muted">Try widening your search.</div>
      <button
        onClick={onClear}
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
      >
        Clear filters
      </button>
    </div>
  );
}

// ─── Drawer (logic preserved — chrome refreshed + scaffolded modules) ──

function StaffDrawer({
  id, onClose, allServices, isAdmin, canChangeRoles,
}: {
  id: string | null;
  onClose: () => void;
  allServices: ServiceItem[];
  isAdmin: boolean;
  canChangeRoles: boolean;
}) {
  const [data, setData] = React.useState<StaffDetail | null>(null);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [savingServices, setSavingServices] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [roleSaving, setRoleSaving] = React.useState(false);

  React.useEffect(() => {
    if (!id) { setData(null); return; }
    setData(null);
    setTab("overview");
    fetch(`/api/staff/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setSelected(new Set(d.assignedServices.map((s: { id: string }) => s.id)));
      })
      .catch(() => toast("Failed to load staff", "error"));
  }, [id]);

  async function saveServices() {
    if (!id) return;
    setSavingServices(true);
    try {
      const res = await fetch(`/api/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceIds: Array.from(selected) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast("Service assignments saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingServices(false);
    }
  }

  function toggleService(sid: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }

  async function changeRole(next: "staff" | "manager") {
    if (!id || !data || data.staff.role === next) return;
    setRoleSaving(true);
    try {
      const res = await fetch(`/api/staff/${id}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      setData((prev) => prev ? { ...prev, staff: { ...prev.staff, role: d.role } } : prev);
      toast(`Role changed to ${d.role}`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setRoleSaving(false);
    }
  }

  const open = Boolean(id);
  const weekly = new Map((data?.weeklyAvailability ?? []).map((r) => [r.dayOfWeek, r]));
  const workload = data ? deriveWorkload(data.upcoming.length) : "available";

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="Staff">
      {!data ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-6 h-24 w-full" />
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-brand-subtle/30 via-surface to-surface p-5">
            <div aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <span
                    aria-hidden
                    className={cn("absolute -inset-1.5 rounded-full opacity-70 blur-[8px]", WORKLOAD_TINT[workload].halo)}
                  />
                  <span className="relative">
                    <Avatar name={data.staff.name} src={data.staff.avatarUrl} size="lg" />
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-[17px] font-semibold tracking-tight text-ink">{data.staff.name}</h2>
                    <RoleChip role={data.staff.role} />
                  </div>
                  <a className="text-[12.5px] text-brand-accent hover:underline" href={`mailto:${data.staff.email}`}>
                    {data.staff.email}
                  </a>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-muted">
                    <Clock className="h-3 w-3" strokeWidth={1.75} />
                    {data.staff.timezone}
                  </div>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>

            {/* Workload pill */}
            <div className="relative mt-3 inline-flex">
              <WorkloadChip workload={workload} />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border bg-surface/60 px-3">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "relative border-b-2 px-3 py-2.5 text-[12.5px] font-medium capitalize transition-colors duration-[160ms]",
                  t === tab
                    ? "border-brand-accent text-brand-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                )}
              >
                {t}
                {t === tab && (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 -bottom-px h-px bg-gradient-to-r from-transparent via-brand-accent to-transparent"
                  />
                )}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {tab === "overview" && (
              <div className="space-y-4">
                {/* Role + role change */}
                <Card>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Role</div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge tone={data.staff.role === "manager" ? "violet" : "neutral"} className="capitalize">{data.staff.role}</Badge>
                        {data.staff.role === "manager" && (
                          <span className="text-[11.5px] text-ink-muted">Sees all bookings &amp; manages workspace ops.</span>
                        )}
                      </div>
                    </div>
                    {canChangeRoles && (
                      <div className="flex items-center gap-2">
                        <select
                          value={data.staff.role}
                          disabled={roleSaving}
                          onChange={(e) => changeRole(e.target.value as "staff" | "manager")}
                          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12.5px]"
                        >
                          <option value="staff">Staff</option>
                          <option value="manager">Manager</option>
                        </select>
                      </div>
                    )}
                  </div>
                </Card>

                {/* Real ops stats */}
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Upcoming" value={String(data.upcoming.length)} icon={CalendarRange} tone="brand" />
                  <Stat label="Completed (30d)" value={String(data.stats.completed30d)} icon={CheckCircle2} tone="positive" />
                  <Stat label="Cancelled (30d)" value={String(data.stats.cancelled30d)} icon={X} tone={data.stats.cancelled30d > 0 ? "warning" : "neutral"} />
                  <Stat label="Services offered" value={String(data.assignedServices.length)} icon={Layers} tone="brand" />
                </div>

                {/* Scaffolded intelligence modules — explicitly placeholder.
                   These slots are reserved for future workforce intelligence
                   (per Phase 11A Step 8) and surface no fabricated data. */}
                <ScaffoldModule
                  icon={Activity}
                  title="Workload overview"
                  caption="Trailing booking density and capacity curves will appear here."
                />
                <ScaffoldModule
                  icon={MessageSquare}
                  title="Communication responsiveness"
                  caption="Average response time and quality signals — coming with the messaging intelligence layer."
                />
                <ScaffoldModule
                  icon={CalendarDays}
                  title="Schedule coverage"
                  caption="Visualized weekly coverage and routing eligibility maps."
                />
                <ScaffoldModule
                  icon={StickyNote}
                  title="Operational notes"
                  caption="Private operational annotations and handoff context."
                />

                {data.staff.bio && (
                  <Card>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Bio</div>
                    <p className="mt-1 text-[13px] text-ink">{data.staff.bio}</p>
                  </Card>
                )}
                {data.staff.specialties && (
                  <Card>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Specialties</div>
                    <p className="mt-1 text-[13px] text-ink">{data.staff.specialties}</p>
                  </Card>
                )}
              </div>
            )}

            {tab === "services" && (
              <div>
                {!isAdmin && (
                  <div className="mb-3 text-[12px] text-ink-muted">Read-only. Admins can change service assignments.</div>
                )}
                <div className="space-y-2">
                  {allServices.length === 0 && (
                    <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-ink-subtle">
                      No services in this workspace.
                    </div>
                  )}
                  {allServices.map((svc) => {
                    const on = selected.has(svc.id);
                    return (
                      <label
                        key={svc.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-[13px] transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                          on
                            ? "ring-2 ring-brand-accent/30 shadow-soft"
                            : "hover:bg-surface-inset hover:-translate-y-0.5 hover:shadow-soft"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!isAdmin}
                          onChange={() => toggleService(svc.id)}
                          className="h-4 w-4 accent-brand-accent"
                        />
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: svc.color ?? "#94a3b8" }}
                          aria-hidden
                        />
                        <span className="flex-1 text-ink">{svc.name}</span>
                        <span className="text-[11px] text-ink-subtle tabular-nums">{svc.durationMinutes} min</span>
                      </label>
                    );
                  })}
                </div>
                {isAdmin && (
                  <div className="mt-4 flex justify-end">
                    <Button onClick={saveServices} disabled={savingServices}>
                      {savingServices ? "Saving…" : "Save services"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {tab === "schedule" && (
              <div>
                <div className="mb-3 text-[12px] text-ink-muted">
                  Weekly availability (read-only here — edit on the working hours page).
                </div>
                <div className="space-y-1.5">
                  {DAYS.map((label, d) => {
                    const rule = weekly.get(d);
                    return (
                      <div
                        key={d}
                        className="flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2.5 text-[13px]"
                      >
                        <span className="w-12 font-medium text-ink">{label}</span>
                        {rule ? (
                          <span className="tabular-nums text-ink-muted">
                            {rule.startTime.slice(0,5)} – {rule.endTime.slice(0,5)}
                          </span>
                        ) : (
                          <span className="text-[11.5px] uppercase tracking-wider text-ink-subtle">Off</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === "activity" && (
              <ActivityTimeline entityType="booking" limit={30} />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning" | "neutral";
}) {
  const toneCls =
    tone === "positive" ? "text-emerald-600 bg-emerald-50 ring-emerald-300/30"
    : tone === "warning"  ? "text-amber-600 bg-amber-50 ring-amber-300/40"
    : tone === "neutral"  ? "text-ink-subtle bg-surface-inset ring-transparent"
    :                       "text-brand-accent bg-brand-subtle ring-brand-accent/15";
  return (
    <Card className="relative">
      <div className="absolute right-3 top-3">
        <div className={cn("inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1", toneCls)}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</div>
      <div className="mt-1 text-[22px] font-semibold leading-none tabular-nums tracking-tight text-ink">{value}</div>
    </Card>
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
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border bg-surface-inset/30 p-3.5">
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

// ─── Capacity chip cluster ─────────────────────────────────────────
//
// Three calm executive chips that together communicate the entire
// operational workforce picture:
//
//   PlanChip            — subscription tier + cadence
//   SeatCapacityChip    — N / M operational seats used (+ progress)
//   CapacityStatusChip  — Healthy / Near limit / At capacity / Unlimited
//
// All three open the WorkforceCapacityOverviewModal — a single
// canonical surface for the full workforce-capacity breakdown.

function PlanChip({
  seats,
  onOpen,
}: {
  seats: SeatsSnapshot | null;
  onOpen: () => void;
}) {
  if (!seats) {
    return (
      <span className="inline-flex h-7 items-center gap-2 rounded-full border border-border bg-surface/70 px-3 text-[11px] font-medium text-ink-subtle shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-subtle/40" />
        Loading plan…
      </span>
    );
  }

  // Cadence label — honest about what lib/plans actually models.
  const cadence =
    seats.planInterval === "month"
      ? "Monthly"
      : seats.planPriceCents === 0
        ? "Free"
        : "Custom";

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Current plan: ${seats.planName} · ${cadence}`}
      className="group inline-flex h-7 items-center gap-2 rounded-full border border-brand-accent/20 bg-gradient-to-br from-brand-subtle/60 via-surface to-surface px-3 text-[11px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,23,42,0.04)] ring-1 ring-brand-accent/10 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft hover:ring-brand-accent/25"
    >
      <Sparkles className="h-3 w-3 text-brand-accent" strokeWidth={2} />
      <span className="text-[9px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Plan</span>
      <span className="font-semibold text-ink">{seats.planName}</span>
      <span className="text-ink-subtle">·</span>
      <span className="text-ink-muted">{cadence}</span>
    </button>
  );
}

function SeatCapacityChip({
  seats,
  onOpen,
}: {
  seats: SeatsSnapshot | null;
  onOpen: () => void;
}) {
  if (!seats) {
    return (
      <span className="inline-flex h-7 items-center gap-2 rounded-full border border-border bg-surface/70 px-3 text-[11px] font-medium text-ink-subtle shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-subtle/40" />
        Loading seats…
      </span>
    );
  }

  if (seats.unlimited) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${seats.usedSeats} operational seats in use — unlimited`}
        className="group inline-flex h-7 items-center gap-2 rounded-full border border-border bg-surface/80 px-3 text-[11px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface hover:text-ink hover:shadow-soft"
      >
        <InfinityIcon className="h-3 w-3 text-brand-accent" strokeWidth={2} />
        <span className="font-semibold tabular-nums text-ink">{seats.usedSeats}</span>
        <span className="text-ink-subtle">operational seats</span>
        <span className="text-[9px] font-semibold uppercase tracking-wider text-brand-accent">unlimited</span>
      </button>
    );
  }

  const tone =
    seats.level === "critical" ? {
      bg: "bg-red-50/80",
      ring: "ring-red-200/50",
      text: "text-red-700",
      dot: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.45)]",
      bar: "bg-red-500",
      track: "bg-red-200/40",
    }
    : seats.level === "warning" ? {
      bg: "bg-amber-50/80",
      ring: "ring-amber-200/50",
      text: "text-amber-800",
      dot: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.40)]",
      bar: "bg-amber-500",
      track: "bg-amber-200/40",
    }
    : {
      bg: "bg-emerald-50/70",
      ring: "ring-emerald-200/40",
      text: "text-emerald-700",
      dot: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.40)]",
      bar: "bg-emerald-500",
      track: "bg-emerald-200/40",
    };

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Workforce utilization at ${seats.percent}% — click for the capacity overview`}
      className={cn(
        "group inline-flex h-7 items-center gap-2 rounded-full px-3 text-[11px] font-medium ring-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        tone.bg,
        tone.ring,
        tone.text,
      )}
      aria-label={`${seats.usedSeats} of ${seats.totalSeats ?? seats.usedSeats} operational seats used — open capacity overview`}
    >
      <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", tone.dot)} />
      <span className="font-semibold tabular-nums text-ink">{seats.usedSeats}</span>
      <span className="text-ink-subtle">/</span>
      <span className="font-semibold tabular-nums text-ink">{seats.totalSeats ?? seats.usedSeats}</span>
      <span className="text-ink-subtle">seats</span>
      <span aria-hidden className={cn("relative ml-1 inline-block h-1 w-12 overflow-hidden rounded-full", tone.track)}>
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", tone.bar)}
          style={{ width: `${seats.percent}%` }}
        />
      </span>
    </button>
  );
}

function CapacityStatusChip({
  seats,
  onOpen,
}: {
  seats: SeatsSnapshot | null;
  onOpen: () => void;
}) {
  if (!seats) return null;

  const cfg =
    seats.unlimited           ? { label: "Unlimited capacity", cls: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15", dot: "bg-brand-accent" }
    : seats.level === "critical" ? { label: "At capacity",        cls: "bg-red-50/80 text-red-700 ring-red-200/40",                dot: "bg-red-500" }
    : seats.level === "warning"  ? { label: "Near limit",          cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40",         dot: "bg-amber-500" }
    :                              { label: "Healthy capacity",    cls: "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40",   dot: "bg-emerald-500" };

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Capacity status: ${cfg.label} — open capacity overview`}
      className={cn(
        "group inline-flex h-7 items-center gap-2 rounded-full px-3 text-[11px] font-semibold uppercase tracking-[0.08em] ring-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        cfg.cls
      )}
    >
      <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
    </button>
  );
}

// ─── Capacity Reached Modal ────────────────────────────────────────
//
// Premium operational upgrade modal — NOT a paywall. Surfaces the
// real numbers (used/total) and routes to the existing billing
// workspace. Honest about scope: we don't have a per-seat add-on
// SKU configured yet, so the primary action is "Upgrade plan"
// (the canonical, working path today). The secondary "Add seats"
// link explicitly notes that add-on seats are routed through the
// same upgrade workspace until per-seat billing ships.

function CapacityReachedModal({
  open,
  onClose,
  seats,
}: {
  open: boolean;
  onClose: () => void;
  seats: SeatsSnapshot | null;
}) {
  const used = seats?.usedSeats ?? 0;
  const total = seats?.totalSeats ?? seats?.usedSeats ?? 0;
  const planLabel = seats?.plan ? seats.plan.charAt(0).toUpperCase() + seats.plan.slice(1) : "";

  return (
    <Modal open={open} onClose={onClose} title="Your workforce capacity has been reached">
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          To add additional staff members, increase your available operational seats.
          {planLabel ? (
            <>
              {" "}You&rsquo;re currently on the <span className="font-medium text-ink">{planLabel}</span> plan.
            </>
          ) : null}
        </p>

        {/* Operational signal card */}
        <div className="relative overflow-hidden rounded-2xl border border-amber-200/40 bg-gradient-to-br from-amber-50/40 via-surface to-surface p-4">
          <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-amber-300/15 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <div className="relative flex items-start gap-3">
            <div className="zm-pulse-glow inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-200/40 bg-gradient-to-br from-amber-50 to-surface text-amber-700 shadow-soft">
              <Gauge className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700">
                Current usage
              </div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[24px] font-semibold leading-none tabular-nums tracking-tight text-ink">
                  {used}
                </span>
                <span className="text-[14px] font-medium text-ink-muted tabular-nums">/ {total} seats used</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                Your team utilization is at operational saturation. Additional workforce capacity will improve scheduling flexibility and reduce coverage pressure.
              </p>
              {/* Progress rail */}
              <span aria-hidden className="relative mt-2 inline-block h-1 w-full overflow-hidden rounded-full bg-amber-100/60">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.40)]"
                  style={{ width: `${seats?.percent ?? 100}%` }}
                />
              </span>
            </div>
          </div>
        </div>

        {/* Smart operational insight */}
        <div className="rounded-xl border border-border bg-surface-inset/30 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            What to consider
          </div>
          <ul className="mt-1.5 space-y-1.5 text-[12px] leading-relaxed text-ink-muted">
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent" />
              Demand growth suggests additional staffing coverage may be beneficial.
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent" />
              Upgrading your plan unlocks a higher operational seat allocation immediately.
            </li>
            {seats?.addOnSupported && (
              <li className="flex items-start gap-2">
                <span aria-hidden className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent" />
                Per-seat add-ons are available for incremental expansion without a full plan change.
              </li>
            )}
          </ul>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Link
            href="/dashboard/billing"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
          >
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
            Upgrade plan
          </Link>
          <Link
            href="/dashboard/billing"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
            title={seats?.addOnSupported ? "Purchase add-on seats" : "Per-seat add-ons route through the upgrade workspace today"}
          >
            <CreditCard className="h-3.5 w-3.5" strokeWidth={1.75} />
            Add seats
          </Link>
          <Link
            href="/dashboard/billing"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            Manage subscription
          </Link>
          <a
            href="mailto:sales@zentromeet.com?subject=Workforce%20seat%20expansion"
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            Contact sales
          </a>
        </div>
      </div>
    </Modal>
  );
}

// ─── Workforce Capacity Overview Modal ─────────────────────────────
//
// Single canonical surface for the full workforce-capacity breakdown.
// Opened by clicking any of the three hero chips (plan / seats /
// status). Calm executive layout — feels operationally intelligent,
// NOT billing-heavy.
//
// Honest data discipline:
//   - "Inactive staff" line is rendered only when the schema actually
//     supports it (hasSoftDeactivation flag). We don't surface a
//     fake "0 inactive" count today.
//   - "Extra seats purchased" is rendered only when addOnSupported
//     is true. Today it always reads "Plan included" — no fabricated
//     add-on ledger.

function WorkforceCapacityOverviewModal({
  open,
  onClose,
  seats,
  onAddStaff,
}: {
  open: boolean;
  onClose: () => void;
  seats: SeatsSnapshot | null;
  onAddStaff: () => void;
}) {
  if (!seats) {
    return (
      <Modal open={open} onClose={onClose} title="Workforce capacity overview">
        <div className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </Modal>
    );
  }

  const totalLabel = seats.unlimited ? "Unlimited" : String(seats.totalSeats ?? seats.usedSeats);
  const availableLabel = seats.unlimited
    ? "Unlimited"
    : String(Math.max(0, (seats.totalSeats ?? 0) - seats.usedSeats));
  const cadence =
    seats.planInterval === "month"
      ? "Monthly"
      : seats.planPriceCents === 0
        ? "Free"
        : "Custom";

  // Calm operational insight — single line, tone-aware.
  const insight: { text: string; tone: "positive" | "warning" | "brand" | "neutral" } = seats.unlimited
    ? {
        text: "Your plan grants unlimited operational seats. Scale your workforce as demand grows.",
        tone: "brand",
      }
    : seats.atCapacity
      ? {
          text: "Additional staffing requires more operational seats. Upgrading your plan unlocks immediate capacity.",
          tone: "warning",
        }
      : seats.nearLimit
        ? {
            text: "Operational workforce capacity is nearing limit. Additional seats may improve scheduling flexibility.",
            tone: "warning",
          }
        : seats.usedSeats === 0
          ? {
              text: "No staff seats are currently in use. Invite your first teammates to begin building your workforce.",
              tone: "neutral",
            }
          : {
              text: "Your workforce utilization remains healthy. Capacity headroom supports current scheduling demand.",
              tone: "positive",
            };

  const insightTint =
    insight.tone === "positive" ? "bg-emerald-50/60 ring-emerald-200/40"
    : insight.tone === "warning"  ? "bg-amber-50/60 ring-amber-200/40"
    : insight.tone === "brand"    ? "bg-brand-subtle/40 ring-brand-accent/15"
    :                                "bg-surface-inset/40 ring-border/40";

  return (
    <Modal open={open} onClose={onClose} title="Workforce capacity overview">
      <div className="space-y-4">
        {/* Plan card */}
        <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-4">
          <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <div className="relative flex items-start gap-3">
            <div className="zm-pulse-glow inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
              <Sparkles className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Current plan
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[18px] font-semibold tracking-tight text-ink">{seats.planName}</span>
                <span className="text-[11.5px] font-medium text-ink-muted">{cadence}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{seats.planDescription}</p>
            </div>
          </div>
        </div>

        {/* Seat breakdown card */}
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Operational seats
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[28px] font-semibold leading-none tabular-nums tracking-tight text-ink">
              {seats.usedSeats}
            </span>
            <span className="text-[14px] font-medium text-ink-muted tabular-nums">
              / {totalLabel} {seats.unlimited ? "" : "seats used"}
            </span>
            {!seats.unlimited && (
              <span className="ml-auto text-[11.5px] font-semibold uppercase tracking-wider text-ink-subtle">
                {seats.percent}% utilized
              </span>
            )}
          </div>

          {/* Progress rail */}
          {!seats.unlimited && (
            <span aria-hidden className="relative mt-2 inline-block h-1.5 w-full overflow-hidden rounded-full bg-surface-inset/60">
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
                  seats.level === "critical" ? "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.40)]"
                  : seats.level === "warning"  ? "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.35)]"
                  :                               "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.35)]"
                )}
                style={{ width: `${seats.percent}%` }}
              />
            </span>
          )}

          {/* Detail grid */}
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
            <CapacityRow label="Included with plan" value={seats.unlimited ? "Unlimited" : String(seats.includedSeats)} />
            <CapacityRow
              label="Extra seats"
              value={seats.addOnSupported ? String(seats.extraSeats) : "Plan included"}
              hint={seats.addOnSupported ? undefined : "Per-seat add-ons coming soon"}
            />
            <CapacityRow label="Active staff" value={String(seats.usedSeats)} />
            <CapacityRow
              label="Available seats"
              value={availableLabel}
              tone={!seats.unlimited && (seats.totalSeats ?? 0) - seats.usedSeats <= 1 ? "warning" : "default"}
            />
            {seats.hasSoftDeactivation && (
              <CapacityRow label="Inactive staff" value="0" />
            )}
          </dl>

          {!seats.hasSoftDeactivation && (
            <div className="mt-3 rounded-lg border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
              <span className="font-semibold uppercase tracking-wider text-ink-muted">Coming soon · </span>
              Soft-deactivated staff will be tracked separately and won&rsquo;t consume operational seats.
            </div>
          )}
        </div>

        {/* Smart operational insight */}
        <div className={cn("rounded-2xl border border-border p-3.5 ring-1", insightTint)}>
          <div className="flex items-start gap-2.5">
            <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-muted ring-1 ring-border/40">
              <Workflow className="h-3.5 w-3.5" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                Operational insight
              </div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink">{insight.text}</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {seats.atCapacity ? (
            <Link
              href="/dashboard/billing"
              onClick={onClose}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
              Upgrade plan
            </Link>
          ) : (
            <button
              type="button"
              onClick={onAddStaff}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
              Add staff
            </button>
          )}
          <Link
            href="/dashboard/billing"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <CreditCard className="h-3.5 w-3.5" strokeWidth={1.75} />
            Manage subscription
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CapacityRow({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warning";
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</dt>
      <dd className={cn(
        "mt-0.5 text-[14px] font-semibold tabular-nums tracking-tight",
        tone === "warning" ? "text-amber-700" : "text-ink"
      )}>
        {value}
      </dd>
      {hint && (
        <div className="mt-0.5 text-[10.5px] text-ink-subtle">{hint}</div>
      )}
    </div>
  );
}

// ─── Honest scope on these two flows ───────────────────────────────
//
// There is no admin-callable "create staff" backend endpoint today.
// `/api/auth/signup` exists but sets a session cookie on the caller's
// browser — calling it from an admin's session would log the admin
// OUT and log them IN as the new staff. Until a true admin-provisioning
// endpoint lands, BOTH flows ultimately route through the public
// sign-up at /dashboard/login.
//
// What is genuinely different between the two surfaces is the
// INFORMATION the admin collects, the SHAPE of the outgoing
// communication, and the TONE of the workflow. AddStaff = operational
// provisioning checklist (role, services, notes) handed off as a
// detailed onboarding email. InviteTeammate = lightweight invitation
// with optional welcome message.

// ─── helpers reused across both modals ─────────────────────────────

function useSignupShareUrl(): string {
  return React.useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/dashboard/login`;
  }, []);
}

async function copyToClipboard(value: string, label = "Copied to clipboard"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    toast(label, "success");
    return true;
  } catch {
    toast("Could not copy — please copy manually", "error");
    return false;
  }
}

function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0]!)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// ─── Add Staff Modal — operational provisioning ────────────────────
//
// Dense workforce-provisioning form. Admin captures the teammate's
// full profile (name, email, role, service assignments, internal
// notes), then composes a detailed onboarding email + clipboard
// handoff bundle. Pre-existing service assignments are recorded
// locally so the admin can confirm them on the staff profile once
// the teammate signs up.

function AddStaffModal({
  open,
  onClose,
  tenantSlug,
  tenantName,
  allServices,
  canChangeRoles,
}: {
  open: boolean;
  onClose: () => void;
  tenantSlug: string | null;
  tenantName: string | null;
  allServices: ServiceItem[];
  canChangeRoles: boolean;
}) {
  const shareUrl = useSignupShareUrl();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"staff" | "manager">("staff");
  const [selectedServices, setSelectedServices] = React.useState<Set<string>>(new Set());
  const [notes, setNotes] = React.useState("");

  // Reset form when modal closes
  React.useEffect(() => {
    if (!open) {
      // small timeout so the closing animation doesn't show the reset
      const t = setTimeout(() => {
        setName(""); setEmail(""); setRole("staff");
        setSelectedServices(new Set()); setNotes("");
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const canSubmit = name.trim().length > 0 && /\S+@\S+\.\S+/.test(email);

  function toggleService(sid: string) {
    setSelectedServices((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }

  const assignedServiceNames = React.useMemo(
    () => allServices.filter((s) => selectedServices.has(s.id)).map((s) => s.name),
    [allServices, selectedServices],
  );

  // Compose the operational onboarding email body. Plain-text, calm,
  // includes a checklist the recipient can follow end-to-end.
  function buildMailto(): string {
    const subject = `Operational onboarding${tenantName ? ` — ${tenantName}` : ""}`;
    const lines: string[] = [
      `Hi ${name.split(" ")[0] || "there"},`,
      "",
      `You've been added to ${tenantName ?? "our workspace"} as a ${role === "manager" ? "manager" : "staff member"}.`,
      "",
      `Complete your sign-up here:`,
      shareUrl,
      "",
      `On that page, choose "Create an account", select the "${role === "manager" ? "Staff" : "Staff"}" role,`,
      `and enter the workspace slug: ${tenantSlug ?? "(your workspace slug)"}`,
      "",
    ];
    if (assignedServiceNames.length > 0) {
      lines.push("Services you'll be delivering:");
      assignedServiceNames.forEach((n) => lines.push(`  · ${n}`));
      lines.push("");
    }
    if (notes.trim()) {
      lines.push("A few notes from your admin:");
      lines.push(notes.trim());
      lines.push("");
    }
    lines.push("See you in the workspace.");

    return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
  }

  function buildClipboardBundle(): string {
    const lines: string[] = [
      `Operational onboarding bundle${tenantName ? ` — ${tenantName}` : ""}`,
      "",
      `Name:       ${name.trim() || "(set)"}`,
      `Email:      ${email.trim() || "(set)"}`,
      `Role:       ${role === "manager" ? "Manager" : "Staff"}`,
      `Workspace:  ${tenantSlug ?? "(slug)"}`,
      `Sign-up:    ${shareUrl}`,
    ];
    if (assignedServiceNames.length > 0) {
      lines.push("");
      lines.push("Service assignments to confirm after signup:");
      assignedServiceNames.forEach((n) => lines.push(`  · ${n}`));
    }
    if (notes.trim()) {
      lines.push("");
      lines.push("Internal notes:");
      lines.push(notes.trim());
    }
    return lines.join("\n");
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a staff member">
      <div className="space-y-4">
        {/* Eyebrow — operational provisioning */}
        <div className="flex items-center gap-2">
          <div className="zm-pulse-glow inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_10px_rgba(53,157,243,0.30)]">
            <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Operational provisioning
            </div>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              Capture this teammate&rsquo;s profile, assigned services, and any handoff notes — then send their onboarding email.
            </p>
          </div>
        </div>

        {/* Identity row — avatar preview + name + email */}
        <div className="rounded-2xl border border-border bg-surface p-3.5">
          <div className="flex items-start gap-3.5">
            <div className="relative shrink-0">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand-accent to-brand-hover text-[14px] font-semibold text-white shadow-[0_4px_12px_rgba(53,157,243,0.25)]"
                aria-hidden
              >
                {name.trim() ? initialsFromName(name) : "•"}
              </div>
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-surface"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-2.5">
              <div>
                <label htmlFor="add-staff-name" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Full name
                </label>
                <input
                  id="add-staff-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Riya Anand"
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-border bg-surface-inset/30 px-3 py-2 text-[13px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:bg-surface focus:ring-2 focus:ring-brand-accent/20"
                />
              </div>
              <div>
                <label htmlFor="add-staff-email" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Work email
                </label>
                <input
                  id="add-staff-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="riya@example.com"
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-border bg-surface-inset/30 px-3 py-2 text-[13px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:bg-surface focus:ring-2 focus:ring-brand-accent/20"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Role */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Role
          </div>
          <div className="mt-1.5 inline-flex items-center rounded-lg bg-surface-inset/60 p-0.5">
            {(canChangeRoles ? (["staff", "manager"] as const) : (["staff"] as const)).map((r) => {
              const active = r === role;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-all duration-[160ms]",
                    active
                      ? "bg-surface text-ink shadow-soft ring-1 ring-border"
                      : "text-ink-muted hover:bg-surface/60 hover:text-ink",
                  )}
                >
                  {r === "manager" ? <Crown className="h-3 w-3" strokeWidth={2} /> : <Users className="h-3 w-3" strokeWidth={2} />}
                  {r === "manager" ? "Manager" : "Staff"}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-subtle">
            {role === "manager"
              ? "Sees all bookings &amp; manages workspace operations. Consumes a manager seat."
              : "Delivers services and manages their own schedule. Consumes one operational seat."}
          </p>
        </div>

        {/* Services assignment */}
        {allServices.length > 0 && (
          <div>
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Service assignments
              </div>
              <span className="text-[10px] tabular-nums text-ink-subtle">
                {selectedServices.size} selected
              </span>
            </div>
            <div className="mt-1.5 max-h-[180px] space-y-1.5 overflow-y-auto rounded-xl border border-border bg-surface-inset/20 p-2">
              {allServices.map((svc) => {
                const on = selectedServices.has(svc.id);
                return (
                  <label
                    key={svc.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-all duration-[140ms]",
                      on ? "bg-surface ring-1 ring-brand-accent/25 shadow-[0_1px_2px_rgba(53,157,243,0.10)]" : "hover:bg-surface/60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleService(svc.id)}
                      className="h-3.5 w-3.5 accent-brand-accent"
                    />
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: svc.color ?? "#94a3b8" }}
                      aria-hidden
                    />
                    <span className="flex-1 text-ink">{svc.name}</span>
                    <span className="text-[10.5px] text-ink-subtle tabular-nums">{svc.durationMinutes}m</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-subtle">
              You&rsquo;ll confirm these assignments on their staff profile once they complete sign-up.
            </p>
          </div>
        )}

        {/* Internal notes */}
        <div>
          <label htmlFor="add-staff-notes" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Internal notes <span className="text-ink-subtle/70">(optional)</span>
          </label>
          <textarea
            id="add-staff-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Working hours, specialties, anything the teammate should know"
            className="mt-1 w-full rounded-lg border border-border bg-surface-inset/30 px-3 py-2 text-[12.5px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:bg-surface focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>

        {/* Scaffold note — honest about backend boundary */}
        <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">Coming soon &middot; </span>
          Native one-click provisioning is on the roadmap. Today the onboarding email below is the safe, production-ready handoff.
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <a
            href={canSubmit ? buildMailto() : undefined}
            onClick={(e) => {
              if (!canSubmit) { e.preventDefault(); return; }
              // small delay so the mailto: handler fires before close
              setTimeout(onClose, 150);
            }}
            aria-disabled={!canSubmit}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              canSubmit ? "hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]" : "cursor-not-allowed opacity-50"
            )}
          >
            <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
            Create staff member
          </a>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              const ok = await copyToClipboard(buildClipboardBundle(), "Onboarding bundle copied");
              if (ok) onClose();
            }}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              canSubmit ? "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md" : "cursor-not-allowed opacity-50",
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Copy handoff bundle
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Invite Teammate Modal — collaborative onboarding ──────────────
//
// Lightweight collaborative invitation. Email + role + optional
// welcome message. Composes a warm personal email rather than an
// operational onboarding bundle. Visibly distinct from AddStaffModal
// in tone, density, and copy.

function InviteTeammateModal({
  open,
  onClose,
  tenantSlug,
  tenantName,
  canChangeRoles,
}: {
  open: boolean;
  onClose: () => void;
  tenantSlug: string | null;
  tenantName: string | null;
  canChangeRoles: boolean;
}) {
  const shareUrl = useSignupShareUrl();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"staff" | "manager">("staff");
  const [welcome, setWelcome] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setEmail(""); setRole("staff"); setWelcome("");
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const canSend = /\S+@\S+\.\S+/.test(email);

  function buildMailto(): string {
    const subject = `You're invited to join ${tenantName ?? "our workspace"} on ZentroMeet`;
    const lines: string[] = [
      `Hi there,`,
      "",
      `I'd love for you to join ${tenantName ?? "our workspace"} on ZentroMeet.`,
    ];
    if (welcome.trim()) {
      lines.push("");
      lines.push(welcome.trim());
    }
    lines.push("");
    lines.push(`When you're ready, set up your account here:`);
    lines.push(shareUrl);
    lines.push("");
    lines.push(`Choose "Create an account", select the "${role === "manager" ? "Staff" : "Staff"}" role, and enter the workspace slug: ${tenantSlug ?? "(your workspace slug)"}.`);
    lines.push("");
    lines.push(`Looking forward to having you on the team.`);
    return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite a teammate">
      <div className="space-y-4">
        {/* Workspace branding badge */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-3.5">
          <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <div className="relative flex items-center gap-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.25)]">
              <Mail className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Collaborative invitation
              </div>
              <div className="mt-0.5 truncate text-[13px] font-semibold tracking-tight text-ink">
                {tenantName ?? "Your workspace"}
                {tenantSlug ? <span className="ml-1.5 text-[11px] font-normal text-ink-subtle">/ {tenantSlug}</span> : null}
              </div>
            </div>
          </div>
        </div>

        {/* Email */}
        <div>
          <label htmlFor="invite-email" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Their email
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            autoComplete="off"
            autoFocus
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>

        {/* Role chip selector */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Invite as
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(canChangeRoles ? (["staff", "manager"] as const) : (["staff"] as const)).map((r) => {
              const active = r === role;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] ring-1 transition-all duration-[160ms]",
                    active
                      ? r === "manager"
                        ? "bg-violet-50/80 text-violet-700 ring-violet-200/40 shadow-soft"
                        : "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15 shadow-soft"
                      : "bg-surface text-ink-muted ring-border/50 hover:text-ink",
                  )}
                >
                  {r === "manager" ? <Crown className="h-3 w-3" strokeWidth={2} /> : <Users className="h-3 w-3" strokeWidth={2} />}
                  {r === "manager" ? "Manager" : "Staff"}
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional welcome message */}
        <div>
          <label htmlFor="invite-welcome" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            Welcome message <span className="text-ink-subtle/70">(optional)</span>
          </label>
          <textarea
            id="invite-welcome"
            value={welcome}
            onChange={(e) => setWelcome(e.target.value)}
            rows={3}
            placeholder="Excited to have you join the team — looking forward to working together."
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-all duration-[180ms] focus:border-brand-accent/30 focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>

        {/* Invitation preview */}
        {canSend && (
          <div className="rounded-xl border border-border bg-surface-inset/30 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Invitation preview
            </div>
            <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">To:</span> {email}
              <br />
              <span className="font-medium text-ink">Subject:</span> You&rsquo;re invited to join {tenantName ?? "our workspace"} on ZentroMeet
              <br />
              <span className="font-medium text-ink">Role:</span> {role === "manager" ? "Manager" : "Staff"}
            </div>
          </div>
        )}

        {/* Scaffold note */}
        <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">Coming soon &middot; </span>
          Tracked invitation links with expiration and acceptance status are on the roadmap. Today the invitation email below is the safe, production-ready path.
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <a
            href={canSend ? buildMailto() : undefined}
            onClick={(e) => {
              if (!canSend) { e.preventDefault(); return; }
              setTimeout(onClose, 150);
            }}
            aria-disabled={!canSend}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              canSend ? "hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]" : "cursor-not-allowed opacity-50",
            )}
          >
            <Mail className="h-3.5 w-3.5" strokeWidth={2} />
            Send invitation
          </a>
          <button
            type="button"
            onClick={() => copyToClipboard(shareUrl, "Invite link copied")}
            disabled={!shareUrl}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12.5px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Copy invite link
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
