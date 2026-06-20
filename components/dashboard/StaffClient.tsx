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
import { useRouter } from "next/navigation";
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
  Camera,
  Upload,
  Trash2,
  Globe,
  Languages,
  Star,
  Eye,
  Link2,
  PlayCircle,
  Pencil,
  MapPin,
  Building2,
  Video,
  AlertTriangle,
  Star as StarIcon,
  Apple,
  Copy,
  RefreshCw,
  ExternalLink,
  Info,
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
  confirmAction,
} from "@/components/ui/primitives";
import { PremiumCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import { resolvePublicProfile } from "@/lib/identity";
import ActivityTimeline from "@/components/dashboard/ActivityTimeline";
import {
  locationSwatch,
  locationTypeChipTone,
  locationTypeIcon,
} from "@/lib/location-visual";

// ─── Types (matching /api/staff) ────────────────────────────────────

type StaffRow = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  avatarUrl: string | null;
  bio: string | null;
  specialties: string | null;
  // Public-facing identity (migration 0033). Both nullable; render
  // paths fall back to `name` / omit title when null.
  publicDisplayName?: string | null;
  publicTitle?: string | null;
  googleConnected: boolean;
  /** Wave C — additive: present when the staff has an active Microsoft
   *  Outlook connection. Optional + defaulted false so older payloads
   *  remain compatible. */
  microsoftConnected?: boolean;
  upcomingCount: number;
  completedThisMonth: number;
  role?: "staff" | "manager" | "admin";
};

type ServiceItem = { id: string; name: string; durationMinutes: number; color: string | null };

type StaffDetail = {
  // role widened to include "admin" — workspace owners are
  // first-class workforce members and now surface in the Staff
  // workspace alongside managers and staff (see /api/staff query
  // change). The role-change UI in the drawer hides itself when
  // the viewed user is an admin so the workspace owner isn't
  // accidentally demoted through the staff toggle.
  staff: StaffRow & {
    primaryLocationId: string | null;
    departmentId: string | null;
    role: "admin" | "manager" | "staff";
    // Public-facing identity (migration 0033). Both nullable;
    // render paths fall back to `name` / omit title when null.
    publicDisplayName?: string | null;
    publicTitle?: string | null;
    // Workforce delivery mode (migration 0037). Defaults to
    // 'hybrid' for any pre-migration staff.
    deliveryMode?: "in_person" | "virtual" | "hybrid";
    // "Show Fewer Open Slots" — public-availability throttling (migration 0075).
    showFewerOpenSlots?: boolean;
    availabilityDisplayMode?: "normal" | "balanced" | "limited" | "very_limited";
    minimumVisibleSlotsPerDay?: number;
  };
  assignedServices: { id: string; name: string }[];
  weeklyAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  // Per-staff location pivot rows (migration 0037). Empty array =
  // "no explicit presence" → routing layer (future) will fall back
  // to legacy primaryLocationId or workspace-wide visibility.
  locationAssignments?: WorkforceLocationAssignment[];
  stats: { completed30d: number; cancelled30d: number };
  upcoming: {
    id: string; startAt: string; endAt: string; status: string;
    clientName: string; clientEmail: string; meetLink: string | null; serviceName: string;
  }[];
};

// One row per (staff, location) — see lib/workforce-location.ts.
// daysOfWeek empty = "any day they work"; non-empty restricts to
// those weekday keys. At most one isPrimary=true per staff.
type WorkforceLocationAssignment = {
  id: string;
  locationId: string;
  locationName: string;
  locationType: "physical" | "virtual" | "hybrid";
  logoUrl: string | null;
  isActive: boolean;
  isSystem: boolean;
  daysOfWeek: Array<"0" | "1" | "2" | "3" | "4" | "5" | "6">;
  isPrimary: boolean;
};

// Top-level tabs:
//   overview  — read-only operational summary
//   profile   — editable public identity (avatar, name, title, bio)
//   calendar  — per-staff calendar connections (OAuth, sync health)
//   services  — service assignment workflow
//   schedule  — per-staff weekly availability (workspace inheritance toggle)
//   activity  — booking activity timeline
const TABS = ["overview", "profile", "calendar", "services", "schedule", "activity"] as const;
type Tab = (typeof TABS)[number];

// `DAYS` short-name array — kept reserved for any future compact
// schedule renders. The Schedule tab uses SCHEDULE_DAYS (full names)
// for the editable surface.
void ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
    // Wave C — any healthy calendar connection counts toward coverage.
    // OR-fold across providers so Microsoft-only staff aren't undercounted.
    const calendarConnected = list.filter((s) => s.googleConnected || s.microsoftConnected).length;
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
  // Priority order:
  //   1. Seat-capacity warnings (at-capacity > 80%-warning) — these
  //      are the most actionable signals so they override everything.
  //   2. Workforce-empty: rotate through activation insights so the
  //      strip feels alive even with zero staff.
  //   3. Populated workforce: deriveSignal(metrics) — capacity-balanced
  //      operational read.
  const seatSignal: string | null =
    seats && !seats.unlimited
      ? seats.atCapacity
        ? `Workforce capacity has been reached — ${seats.usedSeats} of ${seats.totalSeats ?? seats.usedSeats} operational seats in use. Additional staffing requires more seats.`
        : seats.nearLimit
          ? `Workforce capacity nearing limit — ${seats.usedSeats} of ${seats.totalSeats ?? seats.usedSeats} operational seats in use (${seats.percent}%).`
          : null
      : null;

  const isEmptyWorkforce = rows !== null && rows.length === 0;
  const rotatingSignal = useRotatingSignal(
    isEmptyWorkforce && !seatSignal ? ACTIVATION_SIGNALS : null,
  );

  const signal: string =
    seatSignal ??
    (isEmptyWorkforce ? rotatingSignal : deriveSignal(metrics));

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
          <KpiCard
            label="Total staff"
            value={String(metrics.total)}
            icon={Users}
            tone="brand"
            hint={metrics.total === 0 ? "No active workforce yet" : "In your organization"}
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Active this week"
            value={String(metrics.activeThisWeek)}
            icon={Activity}
            tone="positive"
            hint={
              metrics.total === 0
                ? "Awaiting workforce activation"
                : `${Math.round((metrics.activeThisWeek / Math.max(1, metrics.total)) * 100)}% of staff`
            }
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Avg upcoming load"
            value={String(metrics.avgUpcoming)}
            icon={CalendarRange}
            tone="brand"
            hint={metrics.total === 0 ? "Bookings per staff member" : "Bookings per staff"}
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Completed (month)"
            value={String(metrics.totalCompleted)}
            icon={CalendarCheck}
            tone="positive"
            hint={metrics.total === 0 ? "Tracks once staff begin delivering" : "Across the team"}
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Calendar coverage"
            value={`${metrics.calendarCoveragePct}%`}
            icon={Gauge}
            tone={metrics.total === 0 ? "neutral" : metrics.calendarCoveragePct >= 75 ? "positive" : "warning"}
            hint={metrics.total === 0 ? "Connect staff calendars" : `${metrics.calendarConnected} connected`}
            inactive={metrics.total === 0}
          />
          <KpiCard
            label="Manager ratio"
            value={`${metrics.managerRatioPct}%`}
            icon={Crown}
            tone="neutral"
            hint={metrics.total === 0 ? "Assign operational oversight" : `${metrics.managers} manager${metrics.managers === 1 ? "" : "s"}`}
            inactive={metrics.total === 0}
          />
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
              <PremiumEmptyState
                onAddStaff={handleAddStaffClick}
                onInvite={handleInviteClick}
                allServicesCount={allServices.length}
                anyCalendarConnected={metrics.calendarConnected > 0}
              />
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
            "radial-gradient(800px 220px at 80% 0%, rgba(37,99,235,0.06), transparent 70%), radial-gradient(600px 200px at 0% 100%, rgba(16,185,129,0.05), transparent 70%)",
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
  const primaryCls = "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]";
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
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(37,99,235,0.35)]">
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
            <div className="relative mt-0.5 min-h-[1.5em] text-[13px] leading-relaxed text-ink">
              {loading ? (
                <span className="inline-block h-3 w-2/3 animate-pulse rounded bg-surface-inset" />
              ) : (
                // Re-key on the actual text so rotating insights
                // cross-fade smoothly via the entrance animation.
                <span
                  key={text}
                  className="block"
                  style={{
                    animation: "zm-row-in 0.55s cubic-bezier(0.16,1,0.3,1) both",
                  }}
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

// Activation insights — shown only when workforce is empty. Rotates
// on a calm 6.5-second cadence so the strip feels alive while
// guiding the admin through the first operational setup steps.
const ACTIVATION_SIGNALS: string[] = [
  "Invite your first teammate to begin workforce coordination.",
  "Assign services to improve scheduling coverage.",
  "Connect staff calendars for real-time availability.",
  "Operational staffing intelligence activates automatically as your workforce grows.",
];

const ROTATION_INTERVAL_MS = 6500;

function useRotatingSignal(signals: string[] | null): string {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (!signals || signals.length <= 1) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % signals.length);
    }, ROTATION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [signals]);

  // Reset to first signal whenever the input set itself changes
  React.useEffect(() => {
    setIndex(0);
  }, [signals]);

  return signals?.[index] ?? "";
}

// ─── KPI card (real data only — no fake sparklines) ────────────────

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
  /** When true (workforce empty / metric zero), the hint reads as a
   *  calm activation prompt rather than a real metric. Adds a subtle
   *  pulsing dot to signal "waiting for activation". */
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
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 rounded-l-2xl bg-brand-accent shadow-[0_0_10px_rgba(37,99,235,0.40)]" />
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
          <CalendarPill connected={staff.googleConnected || Boolean(staff.microsoftConnected)} />
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

// ─── Premium empty-state activation experience ─────────────────────
//
// Replaces the prior sparse empty state with a guided operational
// activation surface. Atmosphere = subtle topology dot mesh +
// constellation accent + layered glow. Body = a five-step
// onboarding checklist that routes into real workspaces. Completion
// is derived from honest data:
//   - Step 1 (Add workforce members): never marked done here, since
//     this state only renders when rows.length === 0.
//   - Step 2 (Assign operational services): "Ready" when at least
//     one service exists in the workspace (allServicesCount > 0).
//     Service-staff assignment can't be done until staff exists,
//     so this step routes to /dashboard/services where the editor
//     lives.
//   - Step 3 (Connect calendars): derived from
//     anyCalendarConnected (false in the empty-workforce state by
//     definition — but the prop is threaded for forward-compat).
//   - Step 4 (Configure availability): no completion derivation
//     today — routes to /dashboard/availability.
//   - Step 5 (Activate scheduling coverage): celebration row.

function PremiumEmptyState({
  onAddStaff,
  onInvite,
  allServicesCount,
  anyCalendarConnected,
}: {
  onAddStaff: () => void;
  onInvite: () => void;
  allServicesCount: number;
  anyCalendarConnected: boolean;
}) {
  return (
    <PremiumCard
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/40 via-surface to-surface"
    >
      {/* ─── Atmosphere layers ──────────────────────────────── */}
      {/* Cinematic glow halos */}
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand-accent/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -left-16 -bottom-16 h-48 w-48 rounded-full bg-emerald-200/20 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.40]"
        style={{
          backgroundImage:
            "radial-gradient(700px 200px at 70% 10%, rgba(37,99,235,0.06), transparent 70%), radial-gradient(500px 180px at 10% 90%, rgba(16,185,129,0.05), transparent 70%)",
        }}
      />
      {/* Topology dot-mesh — very subtle */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.45]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(37,99,235,0.18) 1px, transparent 0)",
          backgroundSize: "22px 22px",
          maskImage:
            "radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 75%)",
        }}
      />
      {/* Constellation accent — 3 connected glowing nodes */}
      <Constellation />

      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />

      <div className="relative px-2 py-7 text-center sm:px-6 sm:py-9">
        {/* Headline cluster */}
        <div className="zm-pulse-glow mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Users className="h-7 w-7" strokeWidth={1.5} />
        </div>
        <h3 className="mt-4 text-[18px] font-semibold tracking-tight text-ink">
          Build your operational team
        </h3>
        <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
          Invite staff, assign services, and coordinate workforce availability across your organization.
        </p>

        {/* Primary CTAs */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onAddStaff}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
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

        {/* Activation checklist */}
        <ActivationChecklist
          onAddStaff={onAddStaff}
          allServicesCount={allServicesCount}
          anyCalendarConnected={anyCalendarConnected}
        />
      </div>
    </PremiumCard>
  );
}

// ─── Constellation accent — 3 calm pulsing nodes + connecting lines.
// Positioned absolute over the empty-state canvas to add subtle
// operational atmosphere without crowding the content.

function Constellation() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.55]"
      preserveAspectRatio="none"
      viewBox="0 0 400 240"
    >
      <defs>
        <radialGradient id="zm-node-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(37,99,235,0.55)" />
          <stop offset="100%" stopColor="rgba(37,99,235,0)" />
        </radialGradient>
        <radialGradient id="zm-node-emerald" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(16,185,129,0.55)" />
          <stop offset="100%" stopColor="rgba(16,185,129,0)" />
        </radialGradient>
      </defs>
      {/* Connecting lines */}
      <line x1="55" y1="38" x2="320" y2="56"  stroke="rgba(37,99,235,0.18)" strokeWidth="0.6" strokeDasharray="3 5" />
      <line x1="320" y1="56" x2="86" y2="202" stroke="rgba(16,185,129,0.16)" strokeWidth="0.6" strokeDasharray="3 5" />
      <line x1="86" y1="202" x2="55" y2="38"  stroke="rgba(37,99,235,0.14)" strokeWidth="0.6" strokeDasharray="3 5" />
      {/* Halo nodes */}
      <circle cx="55"  cy="38"  r="18" fill="url(#zm-node-glow)" />
      <circle cx="320" cy="56"  r="22" fill="url(#zm-node-emerald)" />
      <circle cx="86"  cy="202" r="20" fill="url(#zm-node-glow)" />
      {/* Cores */}
      <circle cx="55"  cy="38"  r="1.8" fill="rgba(37,99,235,0.85)" />
      <circle cx="320" cy="56"  r="2.0" fill="rgba(16,185,129,0.85)" />
      <circle cx="86"  cy="202" r="1.8" fill="rgba(37,99,235,0.85)" />
    </svg>
  );
}

// ─── Activation checklist — 5 calm operational steps ───────────────

type ActivationStep = {
  key: string;
  title: string;
  description: string;
  done: boolean;
  icon: LucideIcon;
  action:
    | { kind: "onAddStaff" }
    | { kind: "link"; href: string; label: string }
    | { kind: "none" };
};

function ActivationChecklist({
  onAddStaff,
  allServicesCount,
  anyCalendarConnected,
}: {
  onAddStaff: () => void;
  allServicesCount: number;
  anyCalendarConnected: boolean;
}) {
  const steps: ActivationStep[] = [
    {
      key: "add-staff",
      title: "Add workforce members",
      description: "Invite teammates or provision staff directly into your workspace.",
      done: false, // empty state by definition
      icon: UserPlus,
      action: { kind: "onAddStaff" },
    },
    {
      key: "assign-services",
      title: "Assign operational services",
      description: allServicesCount > 0
        ? `${allServicesCount} service${allServicesCount === 1 ? "" : "s"} ready to be assigned to staff.`
        : "Create services and assign them to the staff members who deliver them.",
      done: false, // requires staff to exist before assignment is meaningful
      icon: Layers,
      action: { kind: "link", href: "/dashboard/services", label: "Open services" },
    },
    {
      key: "connect-calendars",
      title: "Connect calendars",
      description: "Connect Google Calendar for real-time availability and automatic event creation.",
      done: anyCalendarConnected,
      icon: CalendarCheck,
      action: { kind: "link", href: "/dashboard/settings/calendar", label: "Calendar settings" },
    },
    {
      key: "configure-availability",
      title: "Configure availability",
      description: "Set weekly hours, holidays, and per-staff overrides so the scheduler routes around them.",
      done: false,
      icon: Clock,
      action: { kind: "link", href: "/dashboard/availability", label: "Open availability" },
    },
    {
      key: "activate-coverage",
      title: "Activate scheduling coverage",
      description: "Once the steps above are in place, your workforce intelligence activates automatically across the platform.",
      done: false,
      icon: Workflow,
      action: { kind: "none" },
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;

  return (
    <div className="mt-8 text-left">
      {/* Heading */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Operational activation
          </div>
          <div className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Five steps to a fully active workspace
          </div>
        </div>
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-subtle">
          {completedCount} of {steps.length} complete
        </span>
      </div>

      {/* Progress rail */}
      <span aria-hidden className="relative mt-2 inline-block h-1 w-full overflow-hidden rounded-full bg-surface-inset/60">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-brand-accent shadow-[0_0_8px_rgba(37,99,235,0.35)] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </span>

      {/* Steps */}
      <ol className="mt-4 space-y-2">
        {steps.map((step, i) => (
          <li
            key={step.key}
            style={{
              animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${i * 60}ms both`,
            }}
          >
            <ActivationStepCard step={step} index={i + 1} onAddStaff={onAddStaff} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ActivationStepCard({
  step,
  index,
  onAddStaff,
}: {
  step: ActivationStep;
  index: number;
  onAddStaff: () => void;
}) {
  const Icon = step.icon;

  const numberCls = step.done
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
    : "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15";

  const Action = () => {
    if (step.action.kind === "onAddStaff") {
      return (
        <button
          type="button"
          onClick={onAddStaff}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
        >
          Add staff
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
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-surface/80 p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        step.done
          ? "border-emerald-200/40 ring-1 ring-emerald-200/30"
          : "border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft",
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="relative flex items-center gap-3">
        {/* Step number / done glyph */}
        <div className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1",
          numberCls,
        )}>
          {step.done ? (
            <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
          ) : (
            <span className="text-[12px] font-semibold tabular-nums">{index}</span>
          )}
        </div>

        {/* Icon */}
        <div className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-inset text-ink-muted ring-1 ring-border/40 sm:inline-flex">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>

        {/* Copy */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-[13px] font-semibold tracking-tight text-ink">{step.title}</h4>
            {step.done && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-emerald-700 ring-1 ring-emerald-200/40">
                Done
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{step.description}</p>
        </div>

        {/* Action */}
        <Action />
      </div>
    </div>
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
  const workload = data ? deriveWorkload(data.upcoming.length) : "available";

  return (
    <Drawer open={open} onClose={onClose} side="right" size="workspace" ariaLabel="Staff">
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
                    {canChangeRoles && data.staff.role !== "admin" && (
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
                    {data.staff.role === "admin" && (
                      <span className="text-[11px] text-ink-subtle">
                        Workspace owner — manage admin status elsewhere.
                      </span>
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

            {tab === "profile" && (
              <div className="space-y-4">
                <ProfileTab
                  staff={data.staff}
                  canEdit={isAdmin}
                  onChange={(patch) =>
                    setData((prev) => (prev ? { ...prev, staff: { ...prev.staff, ...patch } } : prev))
                  }
                />
                {/* Workforce delivery + location assignments
                    (migration 0037). Lives inside Profile because
                    "where + how this person delivers" is identity-
                    level metadata, not a calendar-policy decision. */}
                <WorkforceLocationSection
                  staffId={data.staff.id}
                  deliveryMode={data.staff.deliveryMode ?? "hybrid"}
                  initialAssignments={data.locationAssignments ?? []}
                  canEdit={isAdmin}
                  onChange={(patch) =>
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            staff: { ...prev.staff, deliveryMode: patch.deliveryMode ?? prev.staff.deliveryMode },
                            locationAssignments: patch.assignments ?? prev.locationAssignments,
                          }
                        : prev,
                    )
                  }
                />
              </div>
            )}

            {tab === "calendar" && (
              // Calendar tab — per-staff calendar OAuth surface.
              // Promoted from a Profile subsection to a top-level tab
              // so connection state, sync health, and the connect
              // workflow get the operational prominence they need.
              // Personal calendars are STAFF-OWNED
              // (calendarConnections, migration 0019). Workspace-
              // level provider enablement (migration 0035) is
              // honored: when a provider is disabled at the tenant
              // level, Connect is blocked but existing connections
              // remain visible and the booking engine keeps honoring
              // their busy events.
              <CalendarConnectionsSection
                staffUserId={data.staff.id}
                canEdit={isAdmin}
              />
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
              <ScheduleTab
                staffUserId={data.staff.id}
                weeklyAvailability={data.weeklyAvailability}
                canEdit={isAdmin}
                onSaved={(rules) =>
                  setData((prev) =>
                    prev ? { ...prev, weeklyAvailability: rules } : prev,
                  )
                }
              />
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

// ─── Workforce location section (Profile tab subsection) ──────────
//
// Phase 16 — enterprise workforce delivery + location pivot.
// Three stacked sections:
//   A. Delivery mode segmented selector (in-person | virtual | hybrid)
//   B. Location assignments — multi-pick from workspace locations
//      with optional day-restrictions and at most one Primary.
//   C. Weekly presence map — read-only resolver showing the per-day
//      "where will this person be" decision (day-pinned > primary >
//      any-day > none) so admins can see the routing-layer answer
//      without booking a slot first.
//
// PATCH /api/staff/[id] handles deliveryMode.
// PUT  /api/staff/[id]/locations handles the assignment set.
// They're split because the assignment surface is shared by the
// future bulk-assign panel; the column edit can be made from any
// admin context.

type DayKey = "0" | "1" | "2" | "3" | "4" | "5" | "6";
const DAY_LABELS_SHORT: readonly { key: DayKey; label: string }[] = [
  { key: "0", label: "Sun" },
  { key: "1", label: "Mon" },
  { key: "2", label: "Tue" },
  { key: "3", label: "Wed" },
  { key: "4", label: "Thu" },
  { key: "5", label: "Fri" },
  { key: "6", label: "Sat" },
];

type LocationListItem = {
  id: string;
  name: string;
  locationType: "physical" | "virtual" | "hybrid";
  logoUrl: string | null;
  isActive: boolean;
  isSystem: boolean;
  /** Optional metadata surfaced inside the weekly-presence hover
   *  preview. Both nullable — render guards everywhere. */
  address: string | null;
  timezone: string | null;
};

// Per-location color palette + type-icon helpers live in
// `lib/location-visual.ts` so the Workforce Availability page (and
// any future workforce surface) paints with the same swatches.
// Imported at the top of this file.

// Resolution mirror of lib/workforce-location.getStaffPresenceForDay.
// Pure UI mirror — never used by the booking engine; rendered here
// so admins can preview the per-day decision without a round-trip.
function resolvePresenceForDay(
  assignments: WorkforceLocationAssignment[],
  day: DayKey,
): { assignment: WorkforceLocationAssignment; reason: "day-pinned" | "primary" | "any-day" } | null {
  if (assignments.length === 0) return null;
  const pinned = assignments.find((a) => a.daysOfWeek.includes(day));
  if (pinned) return { assignment: pinned, reason: "day-pinned" };
  const primary = assignments.find((a) => a.isPrimary);
  if (primary) return { assignment: primary, reason: "primary" };
  const any = assignments.find((a) => a.daysOfWeek.length === 0);
  if (any) return { assignment: any, reason: "any-day" };
  return null;
}

function WorkforceLocationSection({
  staffId,
  deliveryMode: initialDeliveryMode,
  initialAssignments,
  canEdit,
  onChange,
}: {
  staffId: string;
  deliveryMode: "in_person" | "virtual" | "hybrid";
  initialAssignments: WorkforceLocationAssignment[];
  canEdit: boolean;
  onChange: (patch: {
    deliveryMode?: "in_person" | "virtual" | "hybrid";
    assignments?: WorkforceLocationAssignment[];
  }) => void;
}) {
  const [deliveryMode, setDeliveryMode] = React.useState(initialDeliveryMode);
  const [assignments, setAssignments] = React.useState<WorkforceLocationAssignment[]>(initialAssignments);
  const [locations, setLocations] = React.useState<LocationListItem[]>([]);
  const [loadingLocations, setLoadingLocations] = React.useState(true);
  const [modeSaving, setModeSaving] = React.useState(false);
  const [assignmentsSaving, setAssignmentsSaving] = React.useState(false);

  // Resync when parent record refreshes (e.g. drawer re-opened for
  // the same staff after a refetch elsewhere).
  React.useEffect(() => {
    setDeliveryMode(initialDeliveryMode);
  }, [initialDeliveryMode]);
  React.useEffect(() => {
    setAssignments(initialAssignments);
  }, [initialAssignments]);

  // Load locations the workspace owns — used to expand assignments
  // and surface picker rows. Filters to active + non-system unless
  // already assigned (so existing virtual-hub rows still render).
  React.useEffect(() => {
    let abort = false;
    setLoadingLocations(true);
    fetch("/api/locations")
      .then((r) => r.json())
      .then((d) => {
        if (abort) return;
        const rows = Array.isArray(d) ? d : Array.isArray(d?.locations) ? d.locations : [];
        setLocations(
          rows.map((r: Record<string, unknown>) => ({
            id: String(r.id),
            name: String(r.name ?? "Untitled"),
            locationType: ((r.locationType as string) ?? "physical") as "physical" | "virtual" | "hybrid",
            logoUrl: (r.logoUrl as string | null) ?? null,
            isActive: Boolean(r.isActive ?? true),
            isSystem: Boolean(r.isSystem ?? false),
            address: (r.address as string | null) ?? null,
            timezone: (r.timezone as string | null) ?? null,
          })),
        );
      })
      .catch(() => {
        if (!abort) toast("Failed to load locations", "error");
      })
      .finally(() => {
        if (!abort) setLoadingLocations(false);
      });
    return () => {
      abort = true;
    };
  }, []);

  const dirty =
    deliveryMode !== initialDeliveryMode ||
    !sameAssignments(assignments, initialAssignments);

  async function saveDeliveryMode(next: "in_person" | "virtual" | "hybrid") {
    if (!canEdit) return;
    const prev = deliveryMode;
    setDeliveryMode(next);
    setModeSaving(true);
    try {
      const res = await fetch(`/api/staff/${staffId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryMode: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      onChange({ deliveryMode: next });
      toast("Delivery mode updated", "success");
    } catch (e) {
      setDeliveryMode(prev);
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setModeSaving(false);
    }
  }

  async function saveAssignments() {
    if (!canEdit) return;
    setAssignmentsSaving(true);
    try {
      const res = await fetch(`/api/staff/${staffId}/locations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: assignments.map((a) => ({
            locationId: a.locationId,
            daysOfWeek: a.daysOfWeek,
            isPrimary: a.isPrimary,
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      // Refetch to pick up any platform-spawned virtual hub the
      // server attached transparently.
      const refresh = await fetch(`/api/staff/${staffId}/locations`).then((r) => r.json());
      if (Array.isArray(refresh?.assignments)) {
        setAssignments(refresh.assignments);
        onChange({ assignments: refresh.assignments });
      }
      toast("Location assignments saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setAssignmentsSaving(false);
    }
  }

  function addLocation(locId: string) {
    const loc = locations.find((l) => l.id === locId);
    if (!loc) return;
    if (assignments.some((a) => a.locationId === locId)) return;
    setAssignments((cur) => [
      ...cur,
      {
        id: `tmp-${locId}`,
        locationId: locId,
        locationName: loc.name,
        locationType: loc.locationType,
        logoUrl: loc.logoUrl,
        isActive: loc.isActive,
        isSystem: loc.isSystem,
        daysOfWeek: [],
        // First assignment auto-becomes primary; subsequent ones
        // stay non-primary so we never accidentally violate the
        // single-primary invariant.
        isPrimary: cur.length === 0,
      },
    ]);
  }

  function removeAssignment(locId: string) {
    setAssignments((cur) => cur.filter((a) => a.locationId !== locId));
  }

  function toggleDay(locId: string, day: DayKey) {
    setAssignments((cur) =>
      cur.map((a) => {
        if (a.locationId !== locId) return a;
        const has = a.daysOfWeek.includes(day);
        const nextDays = has ? a.daysOfWeek.filter((d) => d !== day) : [...a.daysOfWeek, day];
        return { ...a, daysOfWeek: nextDays };
      }),
    );
  }

  function setPrimary(locId: string) {
    setAssignments((cur) => cur.map((a) => ({ ...a, isPrimary: a.locationId === locId })));
  }

  const unassignedLocations = locations.filter(
    (l) => l.isActive && !assignments.some((a) => a.locationId === l.id),
  );

  // Delivery-mode visual language (Phase 16B refinement #3).
  // Each mode has its own operational identity so the operator can
  // tell-at-a-glance how this staff member shows up:
  //   • in_person → warm amber tint, building texture, "physical hub"
  //   • virtual   → cool violet with a soft animated digital halo
  //   • hybrid    → blended amber→violet gradient + globe
  // The selected state lifts each card with its mode-specific halo
  // so the segmented control reads as a luxury operational selector.
  const DELIVERY_OPTIONS: Array<{
    value: "in_person" | "virtual" | "hybrid";
    label: string;
    icon: LucideIcon;
    caption: string;
    /** Ring + bg combo applied when this mode is selected. */
    selectedTone: string;
    /** Icon ring + tint when the mode is selected. */
    iconSelected: string;
    /** Soft halo glow behind the card when selected. */
    halo: string;
    /** Subtle background texture/gradient that reads even when not selected. */
    ambient: string;
    /** Operational language for the "current mode" subtitle. */
    operationalNote: string;
  }> = [
    {
      value: "in_person",
      label: "In-person",
      icon: Building2,
      caption: "Meets clients at one or more physical locations.",
      selectedTone: "border-amber-300/60 bg-amber-50/60 ring-amber-300/40",
      iconSelected: "bg-amber-100 text-amber-700 ring-amber-300/40",
      halo: "shadow-[0_8px_28px_rgba(245,158,11,0.22)]",
      ambient: "bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.06),transparent_55%)]",
      operationalNote: "Physical-only delivery. Bookings route to locations with a physical address.",
    },
    {
      value: "virtual",
      label: "Virtual",
      icon: Video,
      caption: "Meets clients online — Virtual Hub auto-attached when saved.",
      selectedTone: "border-violet-300/60 bg-violet-50/60 ring-violet-300/40",
      iconSelected: "bg-violet-100 text-violet-700 ring-violet-300/40",
      halo: "shadow-[0_8px_28px_rgba(139,92,246,0.26)]",
      ambient: "bg-[radial-gradient(circle_at_top_right,rgba(139,92,246,0.08),transparent_55%)]",
      operationalNote: "Online-only delivery. Virtual Hub is auto-attached on save.",
    },
    {
      value: "hybrid",
      label: "Hybrid",
      icon: Globe,
      caption: "Mix of physical and virtual delivery — any combination allowed.",
      selectedTone: "border-sky-300/60 bg-sky-50/60 ring-sky-300/40",
      iconSelected: "bg-sky-100 text-sky-700 ring-sky-300/40",
      halo: "shadow-[0_8px_28px_rgba(14,165,233,0.22)]",
      ambient: "bg-[linear-gradient(120deg,rgba(245,158,11,0.06),rgba(139,92,246,0.08))]",
      operationalNote: "Blended delivery. Eligible across every physical and virtual location.",
    },
  ];

  const activeMode = DELIVERY_OPTIONS.find((o) => o.value === deliveryMode);

  // Location-awareness: in-person + hybrid need a place to meet (an active
  // physical/hybrid location in this workspace). Virtual needs none. When none
  // exist, those two modes are disabled here and rejected by the API.
  const hasPhysicalLocation = locations.some(
    (l) => l.isActive && (l.locationType === "physical" || l.locationType === "hybrid"),
  );
  const blockPhysicalModes = !loadingLocations && !hasPhysicalLocation;
  const currentModeNeedsLocation =
    blockPhysicalModes && (deliveryMode === "in_person" || deliveryMode === "hybrid");

  // Phase 10 violation hints — surfaced inline so admins know why
  // a save will fail before clicking. Mirror of
  // assertValidLocationAssignments().
  const primaryCount = assignments.filter((a) => a.isPrimary).length;
  const hasPhysical = assignments.some(
    (a) => a.locationType === "physical" || a.locationType === "hybrid",
  );
  const invalid: string[] = [];
  if (primaryCount > 1) invalid.push("Only one location can be Primary.");
  if (deliveryMode === "in_person" && assignments.length > 0 && !hasPhysical) {
    invalid.push("In-person delivery requires at least one physical or hybrid location.");
  }
  for (const a of assignments) {
    const seen = new Set<string>();
    for (const d of a.daysOfWeek) {
      if (seen.has(d)) {
        invalid.push(`Duplicate day in "${a.locationName}" — clear and re-pick.`);
        break;
      }
      seen.add(d);
    }
  }

  return (
    <>
      {/* Section A — Delivery mode */}
      <PremiumCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Workforce delivery</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">How does this person meet clients?</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              Sets the delivery model the booking engine will use to filter visible slots.
              Availability stays staff-owned — this only affects which surfaces serve them.
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {DELIVERY_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const on = deliveryMode === opt.value;
            // In-person / hybrid can't be enabled without a physical/hybrid
            // location. Disabled even if currently selected (legacy bad state),
            // so the only valid action is switching to Virtual.
            const blocked = (opt.value === "in_person" || opt.value === "hybrid") && blockPhysicalModes;
            const cardDisabled = !canEdit || modeSaving || blocked;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={cardDisabled}
                title={blocked ? "Add a location first to enable in-person or hybrid appointments." : undefined}
                onClick={() => saveDeliveryMode(opt.value)}
                className={cn(
                  "group relative overflow-hidden rounded-xl border px-3 py-3 text-left transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  // Always paint the mode-specific ambient layer at
                  // low opacity so every card feels operationally
                  // distinct even before selection.
                  opt.ambient,
                  on
                    ? cn("ring-2", opt.selectedTone, opt.halo, "-translate-y-0.5")
                    : "border-border bg-surface hover:-translate-y-0.5 hover:shadow-soft hover:border-ink/15",
                  cardDisabled && "cursor-not-allowed opacity-70",
                )}
              >
                {/* Top edge sheen — premium light catch */}
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 h-px transition-opacity duration-[260ms]",
                    on ? "bg-gradient-to-r from-transparent via-white/80 to-transparent opacity-100" : "opacity-0 group-hover:opacity-60",
                  )}
                />
                {/* Soft pulse halo behind virtual mode when selected.
                    Pure CSS — uses Tailwind's animate-pulse on a low-
                    opacity radial. Never overpowers the foreground. */}
                {on && opt.value === "virtual" && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -inset-1 animate-pulse rounded-2xl bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.18),transparent_65%)]"
                  />
                )}
                <div className="relative flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1 transition-colors duration-[200ms]",
                      on ? opt.iconSelected : "bg-surface-inset text-ink-muted ring-border/40 group-hover:bg-surface",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                  <span className={cn("text-[13px] font-semibold tracking-tight", on ? "text-ink" : "text-ink")}>
                    {opt.label}
                  </span>
                </div>
                <p className="relative mt-1.5 text-[11px] leading-relaxed text-ink-muted">{opt.caption}</p>
              </button>
            );
          })}
        </div>
        {blockPhysicalModes && (
          <div className="mt-3 rounded-md border border-amber-300/60 bg-amber-50/70 px-3 py-2">
            <p className="text-[11.5px] leading-relaxed text-amber-900">
              {currentModeNeedsLocation ? (
                <>
                  This person is set to <span className="font-semibold">{activeMode?.label}</span>, but no
                  locations exist in this workspace — switch to <span className="font-semibold">Virtual</span>, or{" "}
                </>
              ) : (
                <>Add a location first to enable in-person or hybrid appointments — </>
              )}
              <a href="/dashboard/locations" className="font-semibold underline underline-offset-2">
                create one in Settings → Locations
              </a>
              .
            </p>
          </div>
        )}
        {activeMode && !blockPhysicalModes && (
          <p className="mt-3 text-[11.5px] text-ink-subtle">
            <span className="font-medium text-ink-muted">Current:</span> {activeMode.operationalNote}
          </p>
        )}
      </PremiumCard>

      {/* Section B — Location assignments */}
      <PremiumCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Location assignments</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Where does this person work?</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              Add the locations this person is assigned to. Restrict by weekday or leave open to
              all days. Mark exactly one as Primary — that&apos;s the default fallback when no day
              restriction matches.
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {assignments.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 px-3 py-6 text-center">
              <MapPin className="mx-auto h-5 w-5 text-ink-subtle" strokeWidth={1.5} />
              <p className="mt-2 text-[12.5px] text-ink-muted">
                No locations assigned yet.{" "}
                {deliveryMode === "virtual"
                  ? "Virtual Hub will auto-attach when you save."
                  : "Pick a location below to start."}
              </p>
            </div>
          )}

          {assignments.map((a) => {
            const Icon = locationTypeIcon(a.locationType);
            const swatch = locationSwatch(a.locationId, a.locationType);
            return (
              <div
                key={a.locationId}
                className={cn(
                  "rounded-xl border bg-surface p-3 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  a.isPrimary ? "border-brand-accent/40 ring-1 ring-brand-accent/20" : "border-border",
                )}
              >
                <div className="flex items-start gap-3">
                  {/* Per-location swatch icon — same color the
                      Weekly Presence Map paints for this row, so the
                      operator can scan color→location instantly. */}
                  <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", swatch.surface, swatch.ring, swatch.text)}>
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{a.locationName}</span>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] ring-1",
                          locationTypeChipTone(a.locationType),
                        )}
                      >
                        {a.locationType}
                      </span>
                      {a.isSystem && (
                        <span className="inline-flex items-center rounded-full bg-violet-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-violet-700 ring-1 ring-violet-200/60">
                          system
                        </span>
                      )}
                      {a.isPrimary && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-accent/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-brand-accent ring-1 ring-brand-accent/20">
                          <StarIcon className="h-2.5 w-2.5" strokeWidth={2} />
                          primary
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Days</span>
                      <div className="flex flex-wrap items-center gap-1">
                        {DAY_LABELS_SHORT.map(({ key, label }) => {
                          const on = a.daysOfWeek.includes(key);
                          return (
                            <button
                              key={key}
                              type="button"
                              disabled={!canEdit}
                              onClick={() => toggleDay(a.locationId, key)}
                              className={cn(
                                "inline-flex h-6 min-w-[28px] items-center justify-center rounded-md border px-1.5 text-[10.5px] font-semibold tracking-tight transition-colors",
                                on
                                  ? "border-brand-accent/40 bg-brand-subtle text-brand-accent"
                                  : "border-border bg-surface text-ink-muted hover:bg-surface-inset",
                                !canEdit && "cursor-not-allowed opacity-60",
                              )}
                            >
                              {label}
                            </button>
                          );
                        })}
                        {a.daysOfWeek.length === 0 && (
                          <span className="ml-1 text-[10.5px] text-ink-subtle">Any day</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    {!a.isPrimary && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit}
                        onClick={() => setPrimary(a.locationId)}
                      >
                        Set primary
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!canEdit}
                      onClick={() => removeAssignment(a.locationId)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Add picker */}
        {canEdit && (
          <div className="mt-3">
            {loadingLocations ? (
              <Skeleton className="h-9 w-full" />
            ) : unassignedLocations.length === 0 ? (
              <p className="text-[11.5px] text-ink-subtle">
                {locations.length === 0
                  ? "No locations exist in this workspace yet — create one in Settings → Locations first."
                  : "Every active workspace location is already assigned."}
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-[12.5px]"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      addLocation(e.target.value);
                      e.target.value = "";
                    }
                  }}
                >
                  <option value="" disabled>
                    + Add a location…
                  </option>
                  {unassignedLocations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} {`(${l.locationType})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {invalid.length > 0 && (
          <div className="mt-3 rounded-xl border border-amber-200/60 bg-amber-50/60 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-amber-600" strokeWidth={1.75} />
              <div className="space-y-0.5">
                {invalid.map((msg, i) => (
                  <p key={i} className="text-[11.5px] text-amber-800">{msg}</p>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Save bar for the assignment set. Delivery mode is saved
            on click; assignments batch on Save. */}
        {canEdit && (
          <div
            className={cn(
              "pointer-events-none mt-3 flex translate-y-2 items-center justify-end gap-3 opacity-0 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              dirty && invalid.length === 0 && "pointer-events-auto translate-y-0 opacity-100",
            )}
            aria-hidden={!dirty || invalid.length > 0}
          >
            <span className="text-[11.5px] text-ink-muted">
              <Pencil className="mr-1 inline-block h-3 w-3 text-brand-accent" strokeWidth={2} />
              Unsaved assignment changes.
            </span>
            <Button
              type="button"
              size="sm"
              onClick={saveAssignments}
              disabled={assignmentsSaving || invalid.length > 0 || !dirty}
            >
              {assignmentsSaving ? "Saving…" : "Save assignments"}
            </Button>
          </div>
        )}
      </PremiumCard>

      {/* Section C — Weekly presence map (Phase 16B refinement #1).
          Executive-grade workforce visualization. Each day cell
          paints in its location's stable color, virtual cells get a
          soft "digital" halo, and hover surfaces an inline preview
          with the resolution reason + address + timezone. The grid
          itself becomes the operations dashboard for "where will
          this person be." */}
      <PremiumCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Weekly presence</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Per-day resolved location</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              How the routing layer will answer &quot;where is this person on each weekday?&quot;
              Day-pinned wins, then Primary, then any-day. Read-only — adjust assignments
              above to change.
            </p>
          </div>
          {/* Compact legend chips for distinct locations in this
              week. Helps the operator scan the color language. */}
          <WorkforceLegend assignments={assignments} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {DAY_LABELS_SHORT.map(({ key, label }) => {
            const resolved = resolvePresenceForDay(assignments, key);
            if (!resolved) {
              return (
                <div
                  key={key}
                  className="group relative rounded-xl border border-dashed border-border bg-surface-inset/20 p-2.5 text-center transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface-inset/40"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{label}</div>
                  <div className="mt-1.5 flex flex-col items-center justify-center gap-1 py-1">
                    <span aria-hidden className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-surface text-ink-subtle ring-1 ring-border/40">
                      <MapPin className="h-2.5 w-2.5" strokeWidth={1.75} />
                    </span>
                    <span className="text-[10.5px] text-ink-subtle">No presence</span>
                  </div>
                </div>
              );
            }
            const a = resolved.assignment;
            const Icon = locationTypeIcon(a.locationType);
            const swatch = locationSwatch(a.locationId, a.locationType);
            const meta = locations.find((l) => l.id === a.locationId);
            const isVirtual = a.locationType === "virtual";
            const isPinned = resolved.reason === "day-pinned";

            return (
              <div
                key={key}
                className={cn(
                  "group relative overflow-visible rounded-xl border p-2.5 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5",
                  // Tinted soft surface keyed to the resolved location
                  // — this is what makes the week scan-readable.
                  swatch.surface,
                  // Subtler ring than the swatch ring so the tint
                  // dominates; ring intensifies on hover.
                  "ring-1 ring-inset",
                  isPinned ? swatch.ring : "ring-border/60",
                  "border-border/60 hover:shadow-soft",
                  swatch.haloHover,
                )}
              >
                {/* Day-pinned cells get a thin colored left edge —
                    operational "this is intentional" signal. */}
                {isPinned && (
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-y-2 left-0 w-[3px] rounded-r-full",
                      swatch.dot,
                    )}
                  />
                )}
                {/* Soft virtual-hub glow halo — pulses subtly so the
                    "online day" is unmistakable. */}
                {isVirtual && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -inset-0.5 animate-pulse rounded-xl bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.12),transparent_70%)]"
                  />
                )}

                <div className="relative">
                  <div className="flex items-center justify-between gap-1">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{label}</div>
                    {/* Reason badge — pure semantic chip */}
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-[0.08em] ring-1",
                        resolved.reason === "day-pinned"
                          ? "bg-brand-accent/10 text-brand-accent ring-brand-accent/20"
                          : resolved.reason === "primary"
                            ? "bg-amber-50 text-amber-700 ring-amber-200/60"
                            : "bg-surface-inset text-ink-subtle ring-border/40",
                      )}
                    >
                      {resolved.reason === "day-pinned" ? "pin" : resolved.reason === "primary" ? "primary" : "any"}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-1.5">
                    <span
                      className={cn(
                        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 transition-shadow duration-[260ms]",
                        swatch.surface,
                        swatch.ring,
                        swatch.text,
                      )}
                    >
                      <Icon className="h-3 w-3" strokeWidth={1.75} />
                    </span>
                    <span className="truncate text-[11.5px] font-semibold text-ink" title={a.locationName}>
                      {a.locationName}
                    </span>
                  </div>

                  {/* Color chip strip — visual brand for this
                      location, even when name is truncated. */}
                  <div className="mt-1.5 flex items-center gap-1">
                    <span className={cn("inline-block h-1 w-6 rounded-full", swatch.dot)} aria-hidden />
                    <span className={cn("text-[9.5px] font-semibold uppercase tracking-[0.10em]", swatch.text)}>
                      {a.locationType === "virtual" ? "online" : a.locationType === "hybrid" ? "hybrid" : "physical"}
                    </span>
                    {a.isSystem && (
                      <span className="ml-auto inline-flex items-center rounded-full bg-violet-50 px-1 py-px text-[8.5px] font-semibold uppercase tracking-[0.06em] text-violet-700 ring-1 ring-violet-200/60">
                        sys
                      </span>
                    )}
                  </div>
                </div>

                {/* Hover preview popover — surfaces meeting context
                    inline, no second click required. Positioned
                    absolute so it doesn't reflow the grid. CSS-only
                    via group-hover for snappy interactivity. */}
                <div
                  role="tooltip"
                  className={cn(
                    "pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-[220px] -translate-x-1/2 translate-y-1 rounded-xl border border-border bg-surface p-3 text-left opacity-0 shadow-[0_18px_44px_rgba(15,23,42,0.18)] backdrop-blur transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                    "group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-md ring-1", swatch.surface, swatch.ring, swatch.text)}>
                      <Icon className="h-3 w-3" strokeWidth={1.75} />
                    </span>
                    <span className="truncate text-[12.5px] font-semibold tracking-tight text-ink">{a.locationName}</span>
                  </div>
                  <div className="mt-1.5 grid gap-1 text-[11px] leading-snug text-ink-muted">
                    <div className="flex items-center gap-1">
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Resolved via</span>
                      <span className="text-[11px] font-medium text-ink">
                        {resolved.reason === "day-pinned"
                          ? "Day-pinned"
                          : resolved.reason === "primary"
                            ? "Primary fallback"
                            : "Any-day fallback"}
                      </span>
                    </div>
                    {meta?.address && (
                      <div className="line-clamp-2 text-[11px] text-ink-muted">{meta.address}</div>
                    )}
                    {meta?.timezone && (
                      <div className="flex items-center gap-1 text-[10.5px] text-ink-subtle">
                        <Clock className="h-2.5 w-2.5" strokeWidth={1.75} />
                        {meta.timezone}
                      </div>
                    )}
                    {isVirtual && (
                      <div className="mt-0.5 text-[10.5px] text-violet-700">
                        Online delivery — link auto-attached at booking time.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </PremiumCard>
    </>
  );
}

// Compact legend chip strip for the weekly presence map. Surfaces
// the distinct locations + their palette swatches so operators can
// read the color language at a glance. Skips re-render when there
// are no assignments — keeps the header quiet on empty state.
function WorkforceLegend({ assignments }: { assignments: WorkforceLocationAssignment[] }) {
  if (assignments.length === 0) return null;
  // De-dup by locationId while preserving render order.
  const seen = new Set<string>();
  const items = assignments.filter((a) => {
    if (seen.has(a.locationId)) return false;
    seen.add(a.locationId);
    return true;
  });
  // Cap at 4 to keep the chip strip calm — anything beyond gets a "+N".
  const visible = items.slice(0, 4);
  const overflow = items.length - visible.length;
  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      {visible.map((a) => {
        const swatch = locationSwatch(a.locationId, a.locationType);
        return (
          <span
            key={a.locationId}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
              swatch.surface,
              swatch.ring,
              swatch.text,
            )}
            title={a.locationName}
          >
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", swatch.dot)} aria-hidden />
            <span className="max-w-[88px] truncate">{a.locationName}</span>
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-border/40">
          +{overflow}
        </span>
      )}
    </div>
  );
}

function sameAssignments(a: WorkforceLocationAssignment[], b: WorkforceLocationAssignment[]): boolean {
  if (a.length !== b.length) return false;
  const byIdA = new Map(a.map((x) => [x.locationId, x]));
  for (const y of b) {
    const x = byIdA.get(y.locationId);
    if (!x) return false;
    if (x.isPrimary !== y.isPrimary) return false;
    if (x.daysOfWeek.length !== y.daysOfWeek.length) return false;
    const setX = new Set(x.daysOfWeek);
    for (const d of y.daysOfWeek) if (!setX.has(d)) return false;
  }
  return true;
}

// ─── Profile tab — editable workforce identity ────────────────────
//
// Premium identity-editor surface. Every schedulable workforce
// member can curate the public-facing identity that powers booking
// pages and service pages (migration 0033 + earlier 0007 fields):
//
//   • avatar (uploaded image)            → users.avatar_url
//   • public display name                → users.public_display_name
//   • professional title                 → users.public_title
//   • public bio                         → users.bio
//   • expertise (comma-separated)        → users.specialties
//
// Render rules everywhere customer-facing:
//   displayName = publicDisplayName ?? name
//   publicTitle omitted when null
//
// Save behavior: dirty fields are PATCH'd to /api/staff/[id]. Avatar
// upload uses a multipart POST to /api/users/[id]/avatar; on
// success the returned URL is written into the local form state
// and shown immediately in the identity preview.
//
// The "Coming soon" scaffold tiles document the v2 identity layer
// without fabricating any data. Fields land when their backends do.

function ProfileTab({
  staff,
  canEdit,
  onChange,
}: {
  staff: StaffDetail["staff"];
  canEdit: boolean;
  onChange: (patch: Partial<StaffDetail["staff"]>) => void;
}) {
  // Local form state — initialized from the staff record, dirty-tracked
  // independently so we can show a Save bar only when something
  // actually changed.
  const [name, setName] = React.useState(staff.name);
  const [displayName, setDisplayName] = React.useState(staff.publicDisplayName ?? "");
  const [title, setTitle] = React.useState(staff.publicTitle ?? "");
  const [bio, setBio] = React.useState(staff.bio ?? "");
  const [specialties, setSpecialties] = React.useState(staff.specialties ?? "");
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(staff.avatarUrl);
  // "Show Fewer Open Slots" — public-availability throttling settings.
  const [showFewer, setShowFewer] = React.useState<boolean>(staff.showFewerOpenSlots ?? false);
  const [displayMode, setDisplayMode] = React.useState<
    NonNullable<StaffDetail["staff"]["availabilityDisplayMode"]>
  >(staff.availabilityDisplayMode ?? "normal");
  const [minVisible, setMinVisible] = React.useState<number>(
    staff.minimumVisibleSlotsPerDay ?? 3,
  );
  const [uploading, setUploading] = React.useState(false);
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);

  // Re-sync when the underlying staff record changes (e.g. role flip
  // refresh) — but only when not actively editing dirty fields.
  React.useEffect(() => {
    setName(staff.name);
    setDisplayName(staff.publicDisplayName ?? "");
    setTitle(staff.publicTitle ?? "");
    setBio(staff.bio ?? "");
    setSpecialties(staff.specialties ?? "");
    setAvatarUrl(staff.avatarUrl);
    setShowFewer(staff.showFewerOpenSlots ?? false);
    setDisplayMode(staff.availabilityDisplayMode ?? "normal");
    setMinVisible(staff.minimumVisibleSlotsPerDay ?? 3);
    // We intentionally omit dependencies on the local form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff.id, staff.name, staff.publicDisplayName, staff.publicTitle, staff.bio, staff.specialties, staff.avatarUrl, staff.showFewerOpenSlots, staff.availabilityDisplayMode, staff.minimumVisibleSlotsPerDay]);

  const dirty =
    name !== staff.name ||
    (displayName || null) !== (staff.publicDisplayName ?? null) ||
    (title || null) !== (staff.publicTitle ?? null) ||
    (bio || null) !== (staff.bio ?? null) ||
    (specialties || null) !== (staff.specialties ?? null) ||
    showFewer !== (staff.showFewerOpenSlots ?? false) ||
    displayMode !== (staff.availabilityDisplayMode ?? "normal") ||
    minVisible !== (staff.minimumVisibleSlotsPerDay ?? 3);

  // Resolved preview profile — same shape booking pages see.
  const preview = resolvePublicProfile({
    id: staff.id,
    name,
    publicDisplayName: displayName || null,
    publicTitle: title || null,
    avatarUrl,
    bio: bio || null,
    specialties: specialties || null,
  });

  async function uploadAvatar(file: File) {
    if (!canEdit) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast("Use a JPG, PNG, or WebP image", "error");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast("Image too large — max 2 MB", "error");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/users/${staff.id}/avatar`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Upload failed");
      setAvatarUrl(d.avatarUrl);
      onChange({ avatarUrl: d.avatarUrl });
      // Propagate to server-rendered surfaces (staff list/directory) so the
      // new photo shows everywhere without a manual page refresh. The card +
      // drawer already updated via local state + onChange above.
      router.refresh();
      toast("Photo updated", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    if (!canEdit) return;
    if (!avatarUrl) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/users/${staff.id}/avatar`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      setAvatarUrl(null);
      onChange({ avatarUrl: null });
      router.refresh();
      toast("Photo removed", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!canEdit || !dirty) return;
    setSaving(true);
    try {
      const payload: Record<string, string | null | boolean | number> = {};
      if (name !== staff.name) payload.name = name;
      if ((displayName || null) !== (staff.publicDisplayName ?? null)) payload.publicDisplayName = displayName || null;
      if ((title || null) !== (staff.publicTitle ?? null)) payload.publicTitle = title || null;
      if ((bio || null) !== (staff.bio ?? null)) payload.bio = bio || null;
      if ((specialties || null) !== (staff.specialties ?? null)) payload.specialties = specialties || null;
      if (showFewer !== (staff.showFewerOpenSlots ?? false)) payload.showFewerOpenSlots = showFewer;
      if (displayMode !== (staff.availabilityDisplayMode ?? "normal")) payload.availabilityDisplayMode = displayMode;
      if (minVisible !== (staff.minimumVisibleSlotsPerDay ?? 3)) payload.minimumVisibleSlotsPerDay = minVisible;
      const res = await fetch(`/api/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Save failed");
      onChange(payload as Partial<StaffDetail["staff"]>);
      toast("Profile saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadAvatar(f);
    e.target.value = ""; // reset so re-selecting the same file fires onChange
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (!canEdit) return;
    const f = e.dataTransfer.files?.[0];
    if (f) uploadAvatar(f);
  }

  return (
    <div className="space-y-4 pb-24">
      {/* Avatar zone */}
      <PremiumCard className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Profile photo</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Booking identity image</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">JPG, PNG, or WebP. Max 2 MB.</p>
          </div>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "mt-3 flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:flex-row sm:items-center sm:gap-5",
            dragOver
              ? "border-brand-accent/60 bg-brand-subtle/30"
              : "border-border bg-surface-inset/30",
          )}
        >
          <div className="relative">
            <Avatar name={preview.displayName} src={avatarUrl} size="xl" />
            {uploading && (
              <span
                aria-hidden
                className="absolute inset-0 flex items-center justify-center rounded-full bg-ink/30 backdrop-blur-[1.5px]"
              >
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/60 border-t-white" />
              </span>
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onPickFile}
              disabled={!canEdit || uploading}
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={!canEdit || uploading}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
              {avatarUrl ? "Replace photo" : "Upload photo"}
            </Button>
            {avatarUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={removeAvatar}
                disabled={!canEdit || uploading}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                Remove
              </Button>
            )}
            <p className="text-[11px] text-ink-subtle">
              Or drop a file here. Shown across booking pages, appointments, and the workforce directory.
            </p>
          </div>
        </div>
      </PremiumCard>

      {/* Editable identity fields */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Public identity</div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">How customers see this person</h3>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Internal name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
            />
            <span className="mt-1 block text-[10.5px] text-ink-subtle">Login + admin record. Not shown publicly.</span>
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Public display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={!canEdit}
              maxLength={120}
              placeholder={name}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
            />
            <span className="mt-1 block text-[10.5px] text-ink-subtle">Optional — defaults to internal name when blank.</span>
          </label>

          <label className="block sm:col-span-2">
            <span className="text-[11px] font-semibold text-ink-muted">Professional title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canEdit}
              maxLength={120}
              placeholder="e.g. Founder & Tax Strategist"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
            />
            <span className="mt-1 block text-[10.5px] text-ink-subtle">Shown beneath the name on booking pages.</span>
          </label>

          <label className="block sm:col-span-2">
            <span className="text-[11px] font-semibold text-ink-muted">Public bio</span>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              disabled={!canEdit}
              maxLength={2000}
              rows={4}
              placeholder={`"Helping businesses simplify tax, compliance, and operational workflows."`}
              className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed disabled:bg-surface-inset"
            />
            <span className="mt-1 block text-[10.5px] text-ink-subtle">Visible to customers on booking pages — keep it short and human.</span>
          </label>

          <label className="block sm:col-span-2">
            <span className="text-[11px] font-semibold text-ink-muted">Expertise</span>
            <input
              value={specialties}
              onChange={(e) => setSpecialties(e.target.value)}
              disabled={!canEdit}
              maxLength={500}
              placeholder="Tax strategy, S-corp planning, IRS resolution"
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
            />
            <span className="mt-1 block text-[10.5px] text-ink-subtle">Comma-separated — surfaces as chips on the booking page.</span>
          </label>
        </div>
      </PremiumCard>

      {/* Show Fewer Open Slots — public availability throttling (migration 0075) */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Availability display</div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Show Fewer Open Slots</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-muted">
          When enabled, ZentroMeet will display fewer available booking times to clients while keeping your real schedule unchanged.
        </p>
        <p className="mt-1 text-[11.5px] text-ink-muted">
          Clients will only be able to book the slots shown on your public booking page. Admins and staff can still book your full real availability internally.
        </p>

        <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
          <span className="text-[12.5px] font-medium text-ink">Show Fewer Open Slots</span>
          <input
            type="checkbox"
            checked={showFewer}
            onChange={(e) => setShowFewer(e.target.checked)}
            disabled={!canEdit}
            className="h-4 w-4 accent-brand-accent disabled:opacity-50"
          />
        </label>

        <div className={cn("mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2", !showFewer && "opacity-50")}>
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Availability display</span>
            <select
              value={displayMode}
              onChange={(e) => setDisplayMode(e.target.value as typeof displayMode)}
              disabled={!canEdit || !showFewer}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
            >
              <option value="normal">Normal — Show all available slots</option>
              <option value="balanced">Balanced — Show fewer slots</option>
              <option value="limited">Limited — Show limited slots</option>
              <option value="very_limited">Very Limited — Show very few slots</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold text-ink-muted">Maximum visible slots per day</span>
            <input
              type="number"
              min={1}
              max={20}
              value={minVisible}
              onChange={(e) => {
                const n = Number(e.target.value);
                setMinVisible(Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 3);
              }}
              disabled={!canEdit || !showFewer}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
            />
          </label>
        </div>

        <p className="mt-2 text-[10.5px] text-ink-subtle">
          This only affects what clients see on your booking page. Your real availability remains unchanged for internal scheduling.
        </p>
      </PremiumCard>

      {/* Booking identity preview */}
      <PremiumCard className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Live preview</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Booking identity</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">How this profile appears to customers on the booking page.</p>
          </div>
          <Eye className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
        </div>
        <div className="mt-3 rounded-2xl border border-border bg-surface p-4 shadow-[0_4px_18px_rgba(15,23,42,0.04)]">
          <div className="flex items-start gap-4">
            <Avatar name={preview.displayName} src={preview.avatarUrl} size="xl" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Your host</div>
              <div className="mt-0.5 text-[18px] font-semibold tracking-tight text-ink">{preview.displayName || "—"}</div>
              {preview.title && (
                <div className="mt-0.5 text-[13px] font-medium text-ink-muted">{preview.title}</div>
              )}
              {preview.bio && (
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">{preview.bio}</p>
              )}
              {preview.specialties.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {preview.specialties.slice(0, 4).map((s, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded-full border border-border bg-surface-inset/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-muted"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </PremiumCard>

      {/* Future scaffolds — honest "Coming soon" placeholders. No
          fabricated fields; these all map to v2 identity layer
          features that need their own backend before going live. */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">v2 identity layer</div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-muted">
          More ways to humanize and differentiate this booking identity. Each ships when its backend lands.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ScaffoldModule icon={Languages} title="Languages" caption="List the languages this host conducts meetings in." />
          <ScaffoldModule icon={Globe} title="Meeting styles" caption="In-person, virtual, hybrid preferences and norms." />
          <ScaffoldModule icon={Eye} title="Public visibility" caption="Hide a profile from public booking surfaces without disabling the user." />
          <ScaffoldModule icon={Link2} title="Social links" caption="LinkedIn, professional site, and other trust signals." />
          <ScaffoldModule icon={PlayCircle} title="Intro video" caption="Short 30s greeting embedded on the booking page." />
          <ScaffoldModule icon={Star} title="Reviews" caption="Verified customer reviews surface beneath the bio." />
        </div>
      </PremiumCard>

      {/* Dirty-state save bar — premium slide-in. Calm when clean. */}
      {canEdit && (
        <div
          className={cn(
            "pointer-events-none sticky bottom-0 left-0 right-0 -mx-5 mt-3 flex translate-y-2 items-center justify-between gap-3 border-t border-border bg-surface/95 px-5 py-3 opacity-0 shadow-[0_-10px_24px_rgba(15,23,42,0.06)] backdrop-blur transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            dirty && "pointer-events-auto translate-y-0 opacity-100",
          )}
          aria-hidden={!dirty}
        >
          <span className="text-[12px] text-ink-muted">
            <Pencil className="mr-1 inline-block h-3 w-3 text-brand-accent" strokeWidth={2} />
            Unsaved profile changes.
          </span>
          <Button onClick={save} disabled={saving || !dirty} size="sm">
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </div>
      )}

      {!canEdit && (
        <p className="text-center text-[11.5px] text-ink-subtle">
          Read-only. Admins and managers can edit workforce profiles.
        </p>
      )}
    </div>
  );
}

// ─── Calendar connections section (Profile tab subsection) ────────
//
// Per-staff calendar OAuth surface. Reads from the canonical
// calendarConnections table (migration 0019) via
// GET /api/users/[id]/calendar-connections. The booking engine
// reads from the same source via getExternalBusyForUser() —
// disconnecting here immediately flips slot generation to "no
// external busy" for the affected staff.
//
// State derivations per REFINEMENT #6 (sync-health):
//   active + lastSyncedAt < 5m  → "Last synced just now"
//   active + lastSyncedAt < 1h  → "Last synced N minutes ago"
//   active                       → "Connected"
//   needs_reconnect              → "Needs reconnect" (amber)
//   active + lastError recent    → "Sync issue detected"  (amber)
//   disconnected                 → "Not connected"
//
// REFINEMENT #5: account email shown when present, derived from the
// OAuth tokeninfo response stored at connect time. REFINEMENT #7:
// workspace-level disablement gates the Connect button but never
// hides existing rows.

type CalendarConn = {
  id: string;
  provider: string;
  status: string;
  calendarId: string;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceProvider = {
  id: string;
  name: string;
  description: string;
  wired: boolean;
  category: "calendar" | "video" | "chat";
  enabled: boolean;
};

function CalendarConnectionsSection({
  staffUserId,
  canEdit,
}: {
  staffUserId: string;
  isSelf?: boolean;
  canEdit: boolean;
}) {
  const [conns, setConns] = React.useState<CalendarConn[] | null>(null);
  const [providers, setProviders] = React.useState<WorkspaceProvider[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    Promise.all([
      fetch(`/api/users/${staffUserId}/calendar-connections`).then((r) => r.json()),
      fetch("/api/tenant/integrations/providers").then((r) => r.json()),
    ])
      .then(([c, p]) => {
        setConns(c?.connections ?? []);
        setProviders(p?.providers ?? []);
      })
      .catch(() => {
        setConns([]);
        setProviders([]);
      });
  }, [staffUserId]);

  React.useEffect(() => { load(); }, [load]);

  // Index workspace providers + connections by provider id so each
  // catalog row knows whether THIS staff has a connection AND
  // whether the workspace allows new connections.
  const connByProvider = React.useMemo(() => {
    const m = new Map<string, CalendarConn>();
    for (const c of conns ?? []) {
      // Prefer the most recently-updated row per provider
      if (!m.has(c.provider) || (m.get(c.provider)!.updatedAt < c.updatedAt)) {
        m.set(c.provider, c);
      }
    }
    return m;
  }, [conns]);

  // Catalog: real wired calendar provider(s) first, then video/
  // chat scaffolds. We filter to category="calendar" + "video"
  // for this section — Slack lives on the workspace integrations
  // page only.
  const catalog = React.useMemo(
    () => (providers ?? []).filter((p) => p.category === "calendar" || p.category === "video"),
    [providers],
  );

  async function disconnect(connectionId: string) {
    if (!canEdit) return;
    if (
      !(await confirmAction({
        title: "Disconnect this calendar?",
        body: "Booking sync for this staff member stops until they reconnect from their Staff Profile.",
        variant: "danger",
        confirmLabel: "Disconnect",
      }))
    ) {
      return;
    }
    setBusyId(connectionId);
    try {
      const r = await fetch("/api/calendar/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      toast("Calendar disconnected", "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PremiumCard className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Calendar connections
          </div>
          <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Personal sync + meeting generation
          </h3>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
            Each staff member connects their own calendar. The booking engine checks the assigned
            staff&rsquo;s connected calendar for busy events and creates meetings on confirmed bookings.
          </p>
        </div>
        <CalendarRange className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
      </div>

      <div className="mt-3 space-y-2">
        {conns === null || providers === null ? (
          <div className="space-y-2">
            <div className="h-14 animate-pulse rounded-xl bg-surface-inset/40" />
            <div className="h-14 animate-pulse rounded-xl bg-surface-inset/40" />
          </div>
        ) : catalog.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 px-3 py-3 text-center text-[11.5px] text-ink-subtle">
            No supported providers yet.
          </div>
        ) : (
          catalog.map((p) => {
            const conn = connByProvider.get(providerKeyFor(p.id));
            const busy = conn ? busyId === conn.id : false;
            return (
              <ProviderConnectionRow
                key={p.id}
                provider={p}
                connection={conn ?? null}
                staffUserId={staffUserId}
                canEdit={canEdit}
                busy={busy}
                onDisconnect={() => conn && disconnect(conn.id)}
              />
            );
          })
        )}
      </div>

      {/* Phase ICAL-2 — Apple Calendar subscription feed. NOT an
          OAuth provider; this is a one-way webcal:// feed of the
          staff's bookings. Rendered as a distinct row to make the
          difference from Google/Outlook unambiguous. */}
      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-2 flex items-center gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-muted">
            Subscription feeds · one-way
          </div>
        </div>
        <AppleCalendarSubscriptionRow staffUserId={staffUserId} canEdit={canEdit} />
      </div>

      {/* Phase ICAL-3 — Imported calendar feeds (inbound). Read-only
          busy-time import from external ICS URLs (Apple iCloud share,
          published Outlook .ics, Google iCal). The OPPOSITE direction
          from Phase ICAL-2: we PULL events to block our slots, not
          PUSH bookings to their calendar. */}
      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-2 flex items-center gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-muted">
            Imported calendar feeds · read-only busy blocking
          </div>
        </div>
        <ImportedCalendarFeedsSection staffUserId={staffUserId} canEdit={canEdit} />
      </div>
    </PremiumCard>
  );
}

// ─── Apple Calendar subscription row (Phase ICAL-2) ─────────────────
//
// Distinct from the OAuth provider rows above: Apple does NOT offer a
// calendar API for SaaS integration, so this is a one-way feed only.
// Bookings appear on the staff's iPhone/iPad/Mac Calendar; busy times
// do NOT flow back to the booking engine.
//
// The required educational copy below — "this is one-way, for two-way
// connect Google/Outlook" — is non-removable per Phase ICAL-2 spec so
// users don't expect availability blocking from this.

type FeedTokenState = {
  active: boolean;
  rawToken?: string;
  httpsUrl?: string;
  webcalUrl?: string;
  token: {
    id: string;
    createdAt: string;
    lastAccessedAt: string | null;
    lastAccessedIp: string | null;
  } | null;
};

function AppleCalendarSubscriptionRow({
  staffUserId,
  canEdit,
}: {
  staffUserId: string;
  canEdit: boolean;
}) {
  const [state, setState] = React.useState<FeedTokenState | null>(null);
  // The plaintext URL is held in component state ONLY while the user
  // has the modal/banner open after a generate/rotate. Refreshing
  // the page wipes it (the server can never re-show it).
  const [revealed, setRevealed] = React.useState<{
    httpsUrl: string;
    webcalUrl: string;
  } | null>(null);
  const [busy, setBusy] = React.useState<"generate" | "rotate" | "revoke" | null>(
    null,
  );

  const qs = staffUserId ? `?userId=${encodeURIComponent(staffUserId)}` : "";

  const load = React.useCallback(() => {
    fetch(`/api/staff/calendar-feed${qs}`)
      .then((r) => r.json())
      .then((d) => setState(d))
      .catch(() => setState({ active: false, token: null }));
  }, [qs]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function generateOrRotate(kind: "generate" | "rotate") {
    if (!canEdit) return;
    if (kind === "rotate") {
      const ok = await confirmAction({
        title: "Regenerate the feed URL?",
        body: "Your existing iPhone or Mac calendar subscription will stop syncing until you re-subscribe with the new URL.",
        variant: "warning",
        confirmLabel: "Regenerate URL",
      });
      if (!ok) return;
    }
    setBusy(kind);
    try {
      const r = await fetch(`/api/staff/calendar-feed${qs}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      setRevealed({ httpsUrl: d.httpsUrl, webcalUrl: d.webcalUrl });
      setState({
        active: true,
        rawToken: d.rawToken,
        httpsUrl: d.httpsUrl,
        webcalUrl: d.webcalUrl,
        token: d.token,
      });
      toast(
        kind === "rotate"
          ? "New feed URL issued — previous URL is now invalid."
          : "Feed URL issued.",
        "success",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!canEdit) return;
    const ok = await confirmAction({
      title: "Revoke the feed URL?",
      body: "Your Apple Calendar subscription will stop receiving updates. You can issue a new URL afterwards.",
      variant: "danger",
      confirmLabel: "Revoke URL",
    });
    if (!ok) return;
    setBusy("revoke");
    try {
      const r = await fetch(`/api/staff/calendar-feed${qs}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      setRevealed(null);
      setState({ active: false, token: null });
      toast("Subscription feed revoked.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "success");
    } catch {
      toast("Copy failed — select the text manually", "error");
    }
  }

  // Loading skeleton
  if (state === null) {
    return <div className="h-32 animate-pulse rounded-xl bg-surface-inset/40" />;
  }

  const active = state.active && state.token;

  return (
    <div className="rounded-xl border border-border bg-surface-raised/60 p-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
          <Apple className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="text-[13px] font-semibold tracking-tight text-ink">
              Apple Calendar
            </div>
            <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-700">
              Subscription feed
            </span>
            {active ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-700">
                Active
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
            Your ZentroMeet bookings, blocked time, and group sessions appear
            automatically in Apple Calendar on iPhone, iPad, and macOS using a
            secure subscription URL.
          </p>
        </div>
      </div>

      {/* Required educational copy — Phase ICAL-2 spec §5. Non-removable. */}
      <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50/60 px-2.5 py-2 text-[11px] leading-snug text-amber-900">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <div>
          <strong className="font-semibold">One-way sync only.</strong>{" "}
          Bookings appear in Apple Calendar — busy times do{" "}
          <em className="not-italic underline decoration-amber-700/40">not</em>{" "}
          flow back. For conflict detection + availability sync, connect Google
          or Microsoft Calendar above.
        </div>
      </div>

      {/* URL surface — shown ONLY immediately after generate/rotate.
          The plaintext token can never be re-recovered server-side,
          so once the user navigates away, only metadata stays. */}
      {revealed ? (
        <div className="mt-3 space-y-2 rounded-lg border border-brand-accent/30 bg-brand-accent/5 p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-brand-accent">
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
            Your subscription URL (shown once)
          </div>
          <div className="rounded-md bg-white p-2 font-mono text-[10.5px] leading-snug text-ink break-all">
            {revealed.webcalUrl}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => copyToClipboard(revealed.webcalUrl)}
              className="inline-flex items-center gap-1 rounded-md bg-brand-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
            >
              <Copy className="h-3 w-3" strokeWidth={2} />
              Copy webcal URL
            </button>
            <a
              href={revealed.webcalUrl}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-inset"
            >
              <ExternalLink className="h-3 w-3" strokeWidth={2} />
              Open in Apple Calendar
            </a>
            <button
              type="button"
              onClick={() => copyToClipboard(revealed.httpsUrl)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-inset"
            >
              <Copy className="h-3 w-3" strokeWidth={2} />
              Copy https URL
            </button>
          </div>
          <p className="text-[10.5px] leading-snug text-ink-subtle">
            Save this URL now — for security, ZentroMeet never displays it
            again. If you lose it, click <em>Regenerate</em> below.
          </p>
        </div>
      ) : null}

      {/* Action bar */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {!active ? (
          <button
            type="button"
            disabled={!canEdit || busy !== null}
            onClick={() => generateOrRotate("generate")}
            className="inline-flex items-center gap-1 rounded-md bg-brand-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === "generate" ? "Generating…" : "Generate feed URL"}
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={!canEdit || busy !== null}
              onClick={() => generateOrRotate("rotate")}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-inset disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" strokeWidth={2} />
              {busy === "rotate" ? "Regenerating…" : "Regenerate"}
            </button>
            <button
              type="button"
              disabled={!canEdit || busy !== null}
              onClick={revoke}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
          </>
        )}
      </div>

      {/* Metadata: when issued, last polled. Helps the user audit
          which device is actively syncing. */}
      {active && state.token ? (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[10.5px] text-ink-subtle">
          <div>
            <div className="font-semibold uppercase tracking-wide text-[9px] text-ink-muted">
              Issued
            </div>
            {new Date(state.token.createdAt).toLocaleDateString()}
          </div>
          <div>
            <div className="font-semibold uppercase tracking-wide text-[9px] text-ink-muted">
              Last polled
            </div>
            {state.token.lastAccessedAt
              ? new Date(state.token.lastAccessedAt).toLocaleString()
              : "Never"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Imported Calendar Feeds section (Phase ICAL-3) ─────────────────
//
// Read-only inbound ICS feed import. The OPPOSITE direction from
// Phase ICAL-2: we PULL events from a URL the user pastes and use
// them as busy blocks in the availability engine. No CalDAV. No
// password collection. No write-back.
//
// Each row shows: provider icon, label, redacted URL preview, last
// sync status, error (if any). Actions: enable/disable, sync now,
// remove.

type ImportedFeed = {
  id: string;
  providerLabel: string;
  providerKind: "apple_icloud" | "outlook" | "google" | "exchange" | "other";
  urlPreview: string;
  isEnabled: boolean;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  // Phase ICAL-4 fields
  nextSyncAfter?: string;
  syncDurationMs?: number | null;
  eventCount?: number | null;
  consecutiveFailures?: number;
  health?: {
    state: "healthy" | "warning" | "stale" | "error" | "disabled";
    reason: string;
    tone: "green" | "amber" | "red" | "slate";
  };
  createdAt: string;
};

type FeedDiagnosticsPayload = {
  feedId: string;
  health: { state: string; reason: string; tone: string };
  providerKind: string;
  providerLabel: string;
  urlHost: string;
  supportsETag: boolean;
  supportsLastModified: boolean;
  lastRun: {
    at: string | null;
    status: string | null;
    durationMs: number | null;
    eventCount: number | null;
    error: string | null;
  };
  consecutiveFailures: number;
  nextSyncAt: string;
  cachedEventCount?: number;
  createdAt: string;
  updatedAt: string;
};

function ImportedCalendarFeedsSection({
  staffUserId,
  canEdit,
}: {
  staffUserId: string;
  canEdit: boolean;
}) {
  const [feeds, setFeeds] = React.useState<ImportedFeed[] | null>(null);
  const [showAdd, setShowAdd] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const qs = staffUserId ? `?userId=${encodeURIComponent(staffUserId)}` : "";

  const load = React.useCallback(() => {
    fetch(`/api/staff/external-feeds${qs}`)
      .then((r) => r.json())
      .then((d) => setFeeds(d?.feeds ?? []))
      .catch(() => setFeeds([]));
  }, [qs]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function toggleEnabled(feed: ImportedFeed) {
    if (!canEdit) return;
    setBusyId(feed.id);
    try {
      const r = await fetch(`/api/staff/external-feeds/${feed.id}${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: !feed.isEnabled }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? "Failed");
      }
      toast(feed.isEnabled ? "Feed disabled" : "Feed enabled", "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function syncNow(feed: ImportedFeed) {
    if (!canEdit) return;
    setBusyId(feed.id);
    try {
      const r = await fetch(`/api/staff/external-feeds/${feed.id}/sync${qs}`, {
        method: "POST",
      });
      const d = await r.json();
      if (d.ok) {
        toast(
          d.status === "not_modified" ? "Already up to date" : "Synced",
          "success",
        );
      } else {
        toast(d.error ?? "Sync failed", "error");
      }
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function removeFeed(feed: ImportedFeed) {
    if (!canEdit) return;
    if (
      !(await confirmAction({
        title: `Remove "${feed.providerLabel}"?`,
        body: "Its busy events will stop blocking booking slots. You can re-import the feed at any time.",
        variant: "warning",
        confirmLabel: "Remove feed",
      }))
    ) {
      return;
    }
    setBusyId(feed.id);
    try {
      const r = await fetch(`/api/staff/external-feeds/${feed.id}${qs}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? "Failed");
      }
      toast("Feed removed", "success");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  if (feeds === null) {
    return <div className="h-20 animate-pulse rounded-xl bg-surface-inset/40" />;
  }

  return (
    <div className="space-y-2">
      {/* Required educational copy — Phase ICAL-3 spec. Non-removable. */}
      <div className="flex items-start gap-1.5 rounded-lg bg-blue-50/60 px-2.5 py-2 text-[11px] leading-snug text-blue-900">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <div>
          Read-only busy-time sync. ZentroMeet imports external calendar events
          to prevent double-bookings. No Apple password required. Source
          calendars are{" "}
          <em className="not-italic underline decoration-blue-700/40">never</em>{" "}
          modified.
        </div>
      </div>

      {/* Phase ICAL-4 — top-of-section problem banner. Only renders
          when at least one feed needs attention. */}
      {feeds.filter(
        (f) => f.health && (f.health.state === "stale" || f.health.state === "error"),
      ).length > 0 ? (
        <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 text-[11px] leading-snug text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <div>
            <strong className="font-semibold">
              {feeds.filter((f) => f.health && (f.health.state === "stale" || f.health.state === "error")).length}{" "}
              feed
              {feeds.filter((f) => f.health && (f.health.state === "stale" || f.health.state === "error")).length === 1
                ? ""
                : "s"}{" "}
              need attention.
            </strong>{" "}
            Booking slots may be allowed during times that are actually busy on
            the source calendar. Review the affected feeds below.
          </div>
        </div>
      ) : null}

      {/* Feed list */}
      {feeds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 px-3 py-4 text-center text-[11.5px] text-ink-subtle">
          No imported feeds yet. Paste an ICS URL below to start blocking slots
          based on an external calendar.
        </div>
      ) : (
        feeds.map((f) => (
          <ImportedFeedRow
            key={f.id}
            feed={f}
            busy={busyId === f.id}
            canEdit={canEdit}
            qs={qs}
            onToggle={() => toggleEnabled(f)}
            onSync={() => syncNow(f)}
            onRemove={() => removeFeed(f)}
          />
        ))
      )}

      {/* Add controls */}
      {canEdit ? (
        showAdd ? (
          <AddFeedForm
            qs={qs}
            onCancel={() => setShowAdd(false)}
            onAdded={() => {
              setShowAdd(false);
              load();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-inset"
          >
            + Add ICS feed
          </button>
        )
      ) : null}
    </div>
  );
}

function ImportedFeedRow({
  feed,
  busy,
  canEdit,
  qs,
  onToggle,
  onSync,
  onRemove,
}: {
  feed: ImportedFeed;
  busy: boolean;
  canEdit: boolean;
  qs: string;
  onToggle: () => void;
  onSync: () => void;
  onRemove: () => void;
}) {
  const [showDiagnostics, setShowDiagnostics] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<FeedDiagnosticsPayload | null>(null);

  // Phase ICAL-4 — sync-now cooldown timer. Counts seconds remaining
  // from the 30s cooldown the backend enforces. Re-evaluated on
  // every tick + every render.
  const COOLDOWN_S = 30;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const cooldownRemaining = feed.lastSyncedAt
    ? Math.max(
        0,
        COOLDOWN_S - Math.floor((now - new Date(feed.lastSyncedAt).getTime()) / 1000),
      )
    : 0;

  async function loadDiagnostics() {
    if (diagnostics) return;
    try {
      const r = await fetch(`/api/staff/external-feeds/${feed.id}/diagnostics${qs}`);
      const d = await r.json();
      if (r.ok && d?.diagnostics) setDiagnostics(d.diagnostics);
    } catch {
      /* silent */
    }
  }

  const providerLabel: Record<ImportedFeed["providerKind"], string> = {
    apple_icloud: "Apple iCloud",
    outlook: "Outlook",
    google: "Google",
    exchange: "Exchange",
    other: "Other",
  };

  // Phase ICAL-4 — health badge color from the classifier tone.
  const healthBadge = feed.health
    ? {
        healthy: "bg-emerald-50 text-emerald-700 border-emerald-200",
        warning: "bg-amber-50 text-amber-800 border-amber-200",
        stale: "bg-amber-100 text-amber-900 border-amber-300",
        error: "bg-red-50 text-red-700 border-red-200",
        disabled: "bg-slate-100 text-slate-700 border-slate-200",
      }[feed.health.state]
    : "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <div className="rounded-xl border border-border bg-surface-raised/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="text-[13px] font-semibold tracking-tight text-ink truncate">
              {feed.providerLabel}
            </div>
            <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-700">
              {providerLabel[feed.providerKind]}
            </span>
            {feed.health ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide",
                  healthBadge,
                )}
                title={feed.health.reason}
              >
                {feed.health.state}
              </span>
            ) : !feed.isEnabled ? (
              <span className="inline-flex items-center rounded-full bg-slate-200 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-700">
                Disabled
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ink-subtle truncate">
            {feed.urlPreview}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-ink-subtle">
            {feed.lastSyncedAt ? (
              <span>
                <span className="font-medium text-ink-muted">Synced:</span>{" "}
                {new Date(feed.lastSyncedAt).toLocaleString()}
              </span>
            ) : (
              <span className="italic">Pending first sync</span>
            )}
            {typeof feed.eventCount === "number" ? (
              <span>
                <span className="font-medium text-ink-muted">Events:</span>{" "}
                {feed.eventCount}
              </span>
            ) : null}
            {typeof feed.syncDurationMs === "number" ? (
              <span>
                <span className="font-medium text-ink-muted">Took:</span>{" "}
                {feed.syncDurationMs}ms
              </span>
            ) : null}
            {feed.nextSyncAfter ? (
              <span>
                <span className="font-medium text-ink-muted">Next:</span>{" "}
                {formatNextSync(feed.nextSyncAfter, now)}
              </span>
            ) : null}
          </div>
          {feed.lastError && feed.health?.state !== "healthy" ? (
            <div className="mt-1 text-[10.5px] text-red-700 line-clamp-2">
              {feed.lastError}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!canEdit || busy || cooldownRemaining > 0}
          onClick={onSync}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink hover:bg-surface-inset disabled:opacity-50"
          title={cooldownRemaining > 0 ? `Wait ${cooldownRemaining}s` : "Force a sync now"}
        >
          <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} strokeWidth={2} />
          {cooldownRemaining > 0 ? `Wait ${cooldownRemaining}s` : busy ? "Syncing…" : "Sync now"}
        </button>
        <button
          type="button"
          disabled={!canEdit || busy}
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink hover:bg-surface-inset disabled:opacity-50"
        >
          {feed.isEnabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowDiagnostics((s) => !s);
            if (!showDiagnostics) void loadDiagnostics();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-0.5 text-[10.5px] font-medium text-ink hover:bg-surface-inset"
        >
          {showDiagnostics ? "Hide" : "Diagnostics"}
        </button>
        <button
          type="button"
          disabled={!canEdit || busy}
          onClick={onRemove}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-0.5 text-[10.5px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {/* Phase ICAL-4 — expandable diagnostics drawer. Loads
          on-demand from the redacted /diagnostics endpoint. */}
      {showDiagnostics ? (
        <div className="mt-2 rounded-lg border border-border bg-surface-inset/50 p-2.5 text-[10.5px] text-ink-muted">
          {!diagnostics ? (
            <div className="italic">Loading diagnostics…</div>
          ) : (
            <div className="space-y-1.5">
              <DiagRow label="Feed ID" value={diagnostics.feedId} mono />
              <DiagRow label="Host" value={diagnostics.urlHost} mono />
              <DiagRow label="Health" value={`${diagnostics.health.state} — ${diagnostics.health.reason}`} />
              <DiagRow
                label="ETag support"
                value={diagnostics.supportsETag ? "yes" : "no"}
              />
              <DiagRow
                label="Last-Modified support"
                value={diagnostics.supportsLastModified ? "yes" : "no"}
              />
              <DiagRow
                label="Last status"
                value={diagnostics.lastRun.status ?? "(never synced)"}
              />
              {diagnostics.lastRun.durationMs !== null ? (
                <DiagRow label="Last duration" value={`${diagnostics.lastRun.durationMs}ms`} />
              ) : null}
              {diagnostics.lastRun.eventCount !== null ? (
                <DiagRow label="Last event count" value={String(diagnostics.lastRun.eventCount)} />
              ) : null}
              {typeof diagnostics.cachedEventCount === "number" ? (
                <DiagRow label="Cached events" value={String(diagnostics.cachedEventCount)} />
              ) : null}
              <DiagRow label="Consecutive failures" value={String(diagnostics.consecutiveFailures)} />
              <DiagRow label="Next scheduled sync" value={new Date(diagnostics.nextSyncAt).toLocaleString()} />
              {diagnostics.lastRun.error ? (
                <DiagRow label="Last error" value={diagnostics.lastRun.error} mono />
              ) : null}
              <div className="pt-1 text-[9.5px] italic text-ink-subtle">
                Safe to share with support — URL path is redacted; only the host is exposed.
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DiagRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-32 shrink-0 text-[9.5px] font-semibold uppercase tracking-wide text-ink-subtle">
        {label}
      </div>
      <div className={cn("min-w-0 flex-1 break-all", mono && "font-mono")}>
        {value}
      </div>
    </div>
  );
}

/** Phase ICAL-4 — human-friendly "next sync in" formatter. */
function formatNextSync(iso: string, nowMs: number): string {
  const target = new Date(iso).getTime();
  const deltaMs = target - nowMs;
  if (deltaMs <= 0) return "now";
  const m = Math.round(deltaMs / 60_000);
  if (m < 1) return "< 1 min";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return `in ${h}h`;
}

function AddFeedForm({
  qs,
  onCancel,
  onAdded,
}: {
  qs: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit() {
    if (submitting) return;
    if (!/^https?:\/\//.test(url.trim())) {
      toast("URL must start with https://", "error");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/staff/external-feeds${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), label: label.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed to add feed");
      toast("Feed added — first sync complete", "success");
      onAdded();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-brand-accent/30 bg-brand-accent/5 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.10em] text-brand-accent mb-2">
        Add an imported feed
      </div>
      <div className="space-y-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional, e.g. Apple iCloud personal)"
          className="w-full rounded-md border border-border bg-white px-2 py-1 text-[11.5px]"
        />
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://... — paste an ICS / webcal URL"
          className="w-full rounded-md border border-border bg-white px-2 py-1 text-[11.5px] font-mono"
        />
        <p className="text-[10.5px] leading-snug text-ink-subtle">
          <strong>Apple iCloud:</strong> Calendar app → right-click calendar →
          Share Calendar → enable Public Calendar → copy URL.{" "}
          <strong>Outlook:</strong> outlook.com → Settings → Calendar → Shared
          calendars → Publish → ICS link.{" "}
          <strong>Google:</strong> Calendar settings → Settings for my calendars →
          Integrate calendar → Public/Secret address in iCal format.
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={submitting || !url.trim()}
            onClick={submit}
            className="inline-flex items-center gap-1 rounded-md bg-brand-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Validating…" : "Add feed"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-inset"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// The calendarConnections table stores "google", "microsoft", and
// "zoom" as canonical provider values. The workspace catalog uses
// "google_calendar", "outlook", "teams", "zoom" as UI ids. Map
// between the two so catalog lookups stay accurate even when only
// one row exists.
//
// Wave C — Microsoft Outlook and Microsoft Teams share a single
// calendar_connections row (provider="microsoft"). Teams piggybacks
// on the Outlook connection — creating a Microsoft event with
// isOnlineMeeting=true spawns the Teams join URL on the same Graph
// call. So both UI catalog rows resolve to the same DB row; if the
// staff has a Microsoft connection, both Outlook AND Teams render
// as Connected.
function providerKeyFor(catalogId: string): string {
  if (catalogId === "google_calendar") return "google";
  if (catalogId === "outlook" || catalogId === "teams") return "microsoft";
  return catalogId;
}

function ProviderConnectionRow({
  provider,
  connection,
  staffUserId,
  canEdit,
  busy,
  onDisconnect,
}: {
  provider: WorkspaceProvider;
  connection: CalendarConn | null;
  staffUserId: string;
  canEdit: boolean;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const isConnected = Boolean(connection) && connection!.status === "active";
  const needsReconnect = Boolean(connection) && connection!.status === "needs_reconnect";
  const stale = Boolean(connection) && connection!.status === "disconnected";
  const wsDisabled = !provider.enabled;
  const wired = provider.wired;

  // Sync-health label.
  let healthLabel = "Not connected";
  let healthTone: "neutral" | "positive" | "warning" = "neutral";
  if (needsReconnect) {
    healthLabel = "Needs reconnect";
    healthTone = "warning";
  } else if (isConnected) {
    const recentError =
      connection?.lastError &&
      connection.lastErrorAt &&
      Date.now() - new Date(connection.lastErrorAt).getTime() < 24 * 60 * 60 * 1000;
    if (recentError) {
      healthLabel = "Sync issue detected";
      healthTone = "warning";
    } else if (connection?.lastSyncedAt) {
      healthLabel = `Last synced ${formatRelative(connection.lastSyncedAt)}`;
      healthTone = "positive";
    } else {
      healthLabel = "Connected";
      healthTone = "positive";
    }
  } else if (stale) {
    healthLabel = "Disconnected";
    healthTone = "neutral";
  }

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border bg-surface px-3.5 py-3 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        isConnected
          ? "border-border hover:border-border-strong"
          : needsReconnect
            ? "border-amber-300/40 bg-amber-50/30"
            : "border-border/60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold tracking-tight text-ink">{provider.name}</span>
          <SyncHealthChip label={healthLabel} tone={healthTone} />
          {!wired && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
              Coming soon
            </span>
          )}
          {wsDisabled && wired && !isConnected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-amber-800 ring-1 ring-amber-200/40">
              Workspace disabled
            </span>
          )}
        </div>
        {/* REFINEMENT #5: surface connected account email when present */}
        {isConnected && connection?.accountEmail && (
          <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">
            Connected as <span className="font-medium text-ink">{connection.accountEmail}</span>
          </div>
        )}
        {needsReconnect && connection?.lastError && (
          <div className="mt-0.5 line-clamp-1 text-[11px] text-amber-800/90">
            {connection.lastError}
          </div>
        )}
        {!isConnected && !needsReconnect && (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{provider.description}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {wired && !isConnected && !needsReconnect && (
          <ConnectButton
            disabled={!canEdit || wsDisabled}
            providerCatalogId={provider.id}
            staffUserId={staffUserId}
          />
        )}
        {wired && needsReconnect && (
          <ConnectButton
            disabled={!canEdit || wsDisabled}
            providerCatalogId={provider.id}
            staffUserId={staffUserId}
            label="Reconnect"
          />
        )}
        {isConnected && canEdit && provider.id !== "teams" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            disabled={busy}
            title="Disconnect this calendar"
          >
            {busy ? "…" : "Disconnect"}
          </Button>
        )}
        {isConnected && provider.id === "teams" && (
          // Wave C — Teams piggybacks on the Outlook connection. There
          // is no separate Teams OAuth or DB row to disconnect; the
          // shared Microsoft connection lives on the Outlook row.
          // Surface a calm "via Outlook" affordance so the user
          // understands why no Disconnect button appears here.
          <span className="inline-flex items-center gap-1 rounded-md bg-surface-inset px-2 py-1 text-[10.5px] font-medium text-ink-muted ring-1 ring-border/40">
            via Outlook
          </span>
        )}
      </div>
    </div>
  );
}

function ConnectButton({
  providerCatalogId,
  staffUserId,
  disabled,
  label = "Connect",
}: {
  providerCatalogId: string;
  staffUserId: string;
  disabled?: boolean;
  label?: string;
}) {
  // Wave C/D — Google Calendar, Outlook, and Zoom all have working
  // OAuth flows. Teams piggybacks on the Outlook flow so a separate
  // connect button isn't shown for it. Cross-user connect (admin
  // OAuth-on-behalf) is still not supported for any provider — staff
  // must initiate the flow themselves.
  let href: string | null = null;
  if (providerCatalogId === "google_calendar") href = "/api/calendar/google/connect";
  else if (providerCatalogId === "outlook") href = "/api/calendar/microsoft/connect";
  else if (providerCatalogId === "zoom") href = "/api/calendar/zoom/connect";
  if (!href) {
    return (
      <Button type="button" variant="ghost" size="sm" disabled>
        Connect
      </Button>
    );
  }
  void staffUserId; // reserved for a future cross-user OAuth-on-behalf flow
  return (
    <a
      href={href}
      aria-disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_1px_3px_rgba(15,23,42,0.10)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {label}
      <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
    </a>
  );
}

function SyncHealthChip({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "positive" | "warning";
}) {
  const cls =
    tone === "positive" ? "bg-emerald-50/80 text-emerald-700 ring-emerald-300/40" :
    tone === "warning"  ? "bg-amber-50/80 text-amber-800 ring-amber-200/40" :
                          "bg-surface-inset text-ink-subtle ring-border/50";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] ring-1",
        cls,
      )}
    >
      {tone === "positive" && (
        <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
      )}
      {label}
    </span>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Schedule tab — editable per-staff weekly availability ────────
//
// Two-mode editor:
//   • "Use workspace default hours" toggle ON  → no per-staff rows
//     in `availability` for this user. Slot generator falls back
//     to tenants.default_workspace_hours (migration 0034).
//     UI renders a calm read-only preview of the inherited schedule.
//   • Toggle OFF → custom per-staff rules editable as 7 day rows.
//     Saving writes via PUT /api/availability?userId=<id>.
//
// When the operator flips ON→OFF and no custom rules exist yet, we
// pre-fill the editor from the workspace default hours instead of
// starting blank. That's the user's approved refinement #3.
//
// Operational state chips beneath the toggle are pure derivations
// from real data — no fabricated signals. See lib/workspace-hours.
//
// Booking engine remains separated: it only consumes resolved
// windows from getStaffWorkingWindows(). This tab edits the SOURCE
// of those windows; the engine never branches on inheritance.

type WeeklyRule = { dayOfWeek: number; startTime: string; endTime: string };
type DraftDay = { open: boolean; start: string; end: string };
type WorkspaceHoursMap = Partial<Record<"0"|"1"|"2"|"3"|"4"|"5"|"6", { start: string; end: string } | null>>;

const SCHEDULE_DAYS: { idx: number; label: string }[] = [
  { idx: 1, label: "Monday" },
  { idx: 2, label: "Tuesday" },
  { idx: 3, label: "Wednesday" },
  { idx: 4, label: "Thursday" },
  { idx: 5, label: "Friday" },
  { idx: 6, label: "Saturday" },
  { idx: 0, label: "Sunday" },
];

function rulesToDraft(rules: WeeklyRule[]): Record<number, DraftDay> {
  const draft: Record<number, DraftDay> = {};
  for (const { idx } of SCHEDULE_DAYS) {
    draft[idx] = { open: false, start: "09:00", end: "17:00" };
  }
  for (const r of rules) {
    draft[r.dayOfWeek] = {
      open: true,
      start: r.startTime.slice(0, 5),
      end: r.endTime.slice(0, 5),
    };
  }
  return draft;
}

function workspaceHoursToDraft(hours: WorkspaceHoursMap): Record<number, DraftDay> {
  const draft: Record<number, DraftDay> = {};
  for (const { idx } of SCHEDULE_DAYS) {
    const v = hours[String(idx) as keyof WorkspaceHoursMap];
    if (v && typeof v === "object") {
      draft[idx] = { open: true, start: v.start, end: v.end };
    } else {
      draft[idx] = { open: false, start: "09:00", end: "17:00" };
    }
  }
  return draft;
}

function draftToRules(draft: Record<number, DraftDay>): WeeklyRule[] {
  const out: WeeklyRule[] = [];
  for (const { idx } of SCHEDULE_DAYS) {
    const day = draft[idx];
    if (day && day.open) {
      out.push({
        dayOfWeek: idx,
        startTime: `${day.start}:00`,
        endTime: `${day.end}:00`,
      });
    }
  }
  return out;
}

function ScheduleTab({
  staffUserId,
  weeklyAvailability,
  canEdit,
  onSaved,
}: {
  staffUserId: string;
  weeklyAvailability: WeeklyRule[];
  canEdit: boolean;
  onSaved: (rules: WeeklyRule[]) => void;
}) {
  // Workspace fallback (lazy fetch — only once when this tab opens).
  const [workspaceHours, setWorkspaceHours] = React.useState<WorkspaceHoursMap | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancel = false;
    fetch("/api/tenant/workspace-hours")
      .then((r) => r.json())
      .then((d) => {
        if (cancel) return;
        setWorkspaceHours((d?.hours as WorkspaceHoursMap) ?? {});
        setWorkspaceLoaded(true);
      })
      .catch(() => {
        if (!cancel) {
          setWorkspaceHours({});
          setWorkspaceLoaded(true);
        }
      });
    return () => { cancel = true; };
  }, []);

  // Toggle state — derived initially from data: if the user has any
  // rules, they're on custom; else they're inheriting.
  const hasRules = weeklyAvailability.length > 0;
  const [useWorkspace, setUseWorkspace] = React.useState(!hasRules);
  // Custom draft — initialized from existing rules.
  const [draft, setDraft] = React.useState<Record<number, DraftDay>>(() =>
    rulesToDraft(weeklyAvailability),
  );
  const [baseline, setBaseline] = React.useState<Record<number, DraftDay>>(() =>
    rulesToDraft(weeklyAvailability),
  );
  const [savedUseWorkspace, setSavedUseWorkspace] = React.useState(!hasRules);
  const [saving, setSaving] = React.useState(false);

  // Re-sync when the underlying staff record changes.
  React.useEffect(() => {
    setDraft(rulesToDraft(weeklyAvailability));
    setBaseline(rulesToDraft(weeklyAvailability));
    setUseWorkspace(weeklyAvailability.length === 0);
    setSavedUseWorkspace(weeklyAvailability.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffUserId, weeklyAvailability.length]);

  // Refinement #3: when the operator disables "Use workspace default
  // hours" AND no custom rules exist yet, pre-fill the editor from
  // workspace defaults so they don't start from a blank slate.
  function flipToCustom() {
    if (!canEdit) return;
    setUseWorkspace(false);
    const hasAnyDraftOpen = SCHEDULE_DAYS.some((d) => draft[d.idx]?.open);
    if (!hasAnyDraftOpen && workspaceHours) {
      const prefilled = workspaceHoursToDraft(workspaceHours);
      // Only pre-fill if workspace actually has any open days.
      const wsHasAny = SCHEDULE_DAYS.some((d) => prefilled[d.idx]?.open);
      if (wsHasAny) setDraft(prefilled);
    }
  }

  function flipToWorkspace() {
    if (!canEdit) return;
    setUseWorkspace(true);
  }

  function setDayOpen(idx: number, on: boolean) {
    setDraft((d) => ({ ...d, [idx]: { ...d[idx], open: on } }));
  }
  function setDayTime(idx: number, field: "start" | "end", v: string) {
    setDraft((d) => ({ ...d, [idx]: { ...d[idx], [field]: v } }));
  }

  // Dirty detection — either the toggle changed, OR the custom draft
  // changed while in custom mode.
  const draftChanged = React.useMemo(() => {
    for (const { idx } of SCHEDULE_DAYS) {
      const a = draft[idx];
      const b = baseline[idx];
      if (a.open !== b.open) return true;
      if (a.open) {
        if (a.start !== b.start) return true;
        if (a.end !== b.end) return true;
      }
    }
    return false;
  }, [draft, baseline]);

  const dirty =
    useWorkspace !== savedUseWorkspace ||
    (!useWorkspace && draftChanged);

  async function save() {
    if (!canEdit || !dirty) return;
    setSaving(true);
    try {
      let rulesPayload: WeeklyRule[] = [];
      if (!useWorkspace) {
        // Validate start < end on open days.
        for (const { idx, label } of SCHEDULE_DAYS) {
          const day = draft[idx];
          if (day.open && !(day.start < day.end)) {
            toast(`${label}: start must be before end`, "error");
            setSaving(false);
            return;
          }
        }
        rulesPayload = draftToRules(draft);
      }
      const res = await fetch(`/api/availability?userId=${staffUserId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: rulesPayload }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Save failed");
      setBaseline(useWorkspace ? rulesToDraft([]) : { ...draft });
      setSavedUseWorkspace(useWorkspace);
      onSaved(rulesPayload);
      toast(useWorkspace ? "Now using workspace hours" : "Custom schedule saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  // ── Derived state chips ────────────────────────────────────────
  const wsHasAny = workspaceHours
    ? SCHEDULE_DAYS.some((d) => {
        const v = workspaceHours[String(d.idx) as keyof WorkspaceHoursMap];
        return v && typeof v === "object";
      })
    : false;

  const effective = useWorkspace
    ? workspaceHours
      ? workspaceHoursToDraft(workspaceHours)
      : null
    : draft;
  const openDays = effective
    ? SCHEDULE_DAYS.filter((d) => effective[d.idx]?.open).length
    : 0;
  const hasWeekend = effective
    ? Boolean(effective[0]?.open || effective[6]?.open)
    : false;
  const limited = openDays > 0 && openDays < 5;

  return (
    <div className="space-y-4 pb-24">
      {/* Mode card — workspace-vs-custom toggle */}
      <PremiumCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Schedule source
            </div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
              {useWorkspace ? "Using workspace default hours" : "Custom availability"}
            </h3>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
              {useWorkspace
                ? "Inherits the tenant-wide weekly schedule. Per-date overrides (vacations, custom days) still apply on top."
                : "Editable per-day rules. Per-date overrides still apply on top."}
            </p>
          </div>
          <ScheduleSourceToggle
            on={useWorkspace}
            onWorkspace={flipToWorkspace}
            onCustom={flipToCustom}
            disabled={!canEdit || saving}
          />
        </div>

        {/* Intelligence chips */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ScheduleStateChip
            label={useWorkspace ? "Using workspace hours" : "Custom availability"}
            tone={useWorkspace ? "neutral" : "brand"}
          />
          {openDays > 0 && (
            <ScheduleStateChip
              label={`${openDays} day${openDays === 1 ? "" : "s"} open`}
              tone="positive"
            />
          )}
          {limited && (
            <ScheduleStateChip label="Limited weekly coverage" tone="warning" />
          )}
          {hasWeekend && (
            <ScheduleStateChip label="Weekend availability" tone="violet" />
          )}
          {useWorkspace && !wsHasAny && workspaceLoaded && (
            <ScheduleStateChip label="Workspace hours not configured" tone="warning" />
          )}
        </div>
      </PremiumCard>

      {/* When inheriting — show the resolved preview */}
      {useWorkspace && workspaceLoaded && workspaceHours && (
        <PremiumCard className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Inherited from workspace
              </div>
              <h4 className="mt-0.5 text-[13px] font-semibold tracking-tight text-ink">
                What this staff currently sees
              </h4>
            </div>
            {canEdit && wsHasAny && (
              <Link
                href="/dashboard/availability"
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-accent hover:underline"
              >
                Edit workspace hours
                <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
              </Link>
            )}
          </div>
          <InheritedPreview hours={workspaceHours} />
          {!wsHasAny && (
            <div className="mt-2 rounded-lg border border-dashed border-amber-300/50 bg-amber-50/40 px-3 py-2 text-[11.5px] text-amber-900">
              No workspace hours configured. Staff inheriting will produce zero
              bookable slots until either workspace defaults are set or this staff
              switches to a custom schedule.
            </div>
          )}
        </PremiumCard>
      )}

      {/* When custom — editable per-day */}
      {!useWorkspace && (
        <PremiumCard className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Custom weekly schedule
              </div>
              <h4 className="mt-0.5 text-[13px] font-semibold tracking-tight text-ink">
                This staff&rsquo;s availability
              </h4>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {SCHEDULE_DAYS.map(({ idx, label }) => {
              const day = draft[idx];
              return (
                <div
                  key={idx}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-2.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                    day.open
                      ? "border-border hover:border-border-strong"
                      : "border-border/60 bg-surface-inset/30",
                  )}
                >
                  <DayPillToggle
                    on={day.open}
                    onChange={(on) => setDayOpen(idx, on)}
                    disabled={!canEdit || saving}
                  />
                  <div className="w-24 shrink-0 text-[13px] font-medium text-ink">
                    {label}
                  </div>
                  {day.open ? (
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <DayTimeInput
                        value={day.start}
                        onChange={(v) => setDayTime(idx, "start", v)}
                        disabled={!canEdit || saving}
                      />
                      <span className="text-[12px] text-ink-subtle">–</span>
                      <DayTimeInput
                        value={day.end}
                        onChange={(v) => setDayTime(idx, "end", v)}
                        disabled={!canEdit || saving}
                      />
                    </div>
                  ) : (
                    <div className="flex-1 text-[11.5px] uppercase tracking-[0.10em] text-ink-subtle">
                      Off
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </PremiumCard>
      )}

      {/* Future scaffolds — calm placeholders for v2 layers */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          v2 scheduling layer
        </div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-muted">
          Deeper scheduling primitives layer in cleanly on top of this hierarchy.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ScaffoldModule icon={Workflow} title="Department defaults" caption="Department-level fallback between workspace and staff." />
          <ScaffoldModule icon={Layers} title="Service-specific hours" caption="Different availability per service for the same staff." />
          <ScaffoldModule icon={CalendarRange} title="Split shifts" caption="Multiple windows per day, e.g. 9–12 + 1–5." />
          <ScaffoldModule icon={Activity} title="Rotating schedules" caption="Bi-weekly or n-week rotation patterns." />
          <ScaffoldModule icon={CalendarDays} title="Seasonal schedules" caption="Switch hours by date range — summer, holiday season." />
          <ScaffoldModule icon={Clock} title="Timezone-based routing" caption="Route to staff whose timezone matches the customer." />
        </div>
      </PremiumCard>

      {/* Save bar */}
      {canEdit && (
        <div
          className={cn(
            "pointer-events-none sticky bottom-0 left-0 right-0 -mx-5 mt-3 flex translate-y-2 items-center justify-between gap-3 border-t border-border bg-surface/95 px-5 py-3 opacity-0 shadow-[0_-10px_24px_rgba(15,23,42,0.06)] backdrop-blur transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            dirty && "pointer-events-auto translate-y-0 opacity-100",
          )}
          aria-hidden={!dirty}
        >
          <span className="text-[12px] text-ink-muted">
            <Pencil className="mr-1 inline-block h-3 w-3 text-brand-accent" strokeWidth={2} />
            {useWorkspace ? "Switching to workspace hours" : "Unsaved custom schedule"}
          </span>
          <Button onClick={save} size="sm" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save schedule"}
          </Button>
        </div>
      )}

      {!canEdit && (
        <p className="text-center text-[11.5px] text-ink-subtle">
          Read-only. Admins and managers can edit workforce schedules.
        </p>
      )}
    </div>
  );
}

function ScheduleSourceToggle({
  on,
  onWorkspace,
  onCustom,
  disabled,
}: {
  on: boolean;
  onWorkspace: () => void;
  onCustom: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 rounded-full bg-surface-inset p-0.5 ring-1 ring-border/40">
      <button
        type="button"
        disabled={disabled}
        onClick={onWorkspace}
        className={cn(
          "rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          on ? "bg-surface text-ink shadow-[0_1px_3px_rgba(15,23,42,0.08)]" : "text-ink-subtle hover:text-ink",
          disabled && "opacity-50",
        )}
      >
        Workspace
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onCustom}
        className={cn(
          "rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          !on ? "bg-surface text-ink shadow-[0_1px_3px_rgba(15,23,42,0.08)]" : "text-ink-subtle hover:text-ink",
          disabled && "opacity-50",
        )}
      >
        Custom
      </button>
    </span>
  );
}

function ScheduleStateChip({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "brand" | "positive" | "warning" | "violet";
}) {
  const cls =
    tone === "brand" ? "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15" :
    tone === "positive" ? "bg-emerald-50/80 text-emerald-700 ring-emerald-300/40" :
    tone === "warning" ? "bg-amber-50/80 text-amber-800 ring-amber-200/40" :
    tone === "violet" ? "bg-violet-50/80 text-violet-700 ring-violet-300/40" :
    "bg-surface-inset text-ink-muted ring-border/50";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ring-1", cls)}>
      {label}
    </span>
  );
}

function InheritedPreview({ hours }: { hours: WorkspaceHoursMap }) {
  return (
    <div className="mt-3 space-y-1.5">
      {SCHEDULE_DAYS.map(({ idx, label }) => {
        const v = hours[String(idx) as keyof WorkspaceHoursMap];
        const open = v && typeof v === "object";
        return (
          <div
            key={idx}
            className="flex items-center justify-between rounded-lg border border-border/60 bg-surface px-3 py-2 text-[12.5px]"
          >
            <span className="w-24 font-medium text-ink">{label}</span>
            {open ? (
              <span className="tabular-nums text-ink-muted">
                {v.start} – {v.end}
              </span>
            ) : (
              <span className="text-[10.5px] uppercase tracking-[0.10em] text-ink-subtle">Closed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DayPillToggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
        on ? "bg-brand-accent" : "bg-surface-inset ring-1 ring-border",
        disabled && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.20)] transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function DayTimeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5">
      <Clock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="border-0 bg-transparent p-0 text-[12.5px] tabular-nums text-ink outline-none disabled:opacity-50"
      />
    </span>
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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
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
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
            >
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
              Upgrade plan
            </Link>
          ) : (
            <button
              type="button"
              onClick={onAddStaff}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
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
          <div className="zm-pulse-glow inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_10px_rgba(37,99,235,0.30)]">
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
                className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand-accent to-brand-hover text-[14px] font-semibold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)]"
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
                      on ? "bg-surface ring-1 ring-brand-accent/25 shadow-[0_1px_2px_rgba(37,99,235,0.10)]" : "hover:bg-surface/60",
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
              "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              canSubmit ? "hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]" : "cursor-not-allowed opacity-50"
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
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)]">
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
              "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              canSend ? "hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]" : "cursor-not-allowed opacity-50",
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
