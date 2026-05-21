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
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  AlertTriangle,
  CalendarRange,
  Video,
  MapPin,
  UserPlus,
  Settings,
  Pencil,
  Share2,
  ExternalLink,
  Copy,
  Globe,
  Lock,
  Code2,
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
  // Phase 16 — per-service delivery compatibility (migration 0037).
  // jsonb array of allowed delivery modes. Defaults to both at the
  // DB layer so existing services stay bookable in either mode;
  // future routing filter intersects with each staff's per-day
  // location-type to determine eligibility — never gates slot
  // generation directly.
  deliveryModes?: Array<"in_person" | "virtual"> | null;
  staff: { userId: string; name: string }[];
  // Direct department ownership (migration 0032). Primary signal.
  // `null` = explicitly unassigned. `undefined` = legacy row before
  // GET surfaced the column (treated identically to null in UI).
  departmentId?: string | null;
  // Additive enrichment from the extended GET
  // departmentNames + departmentCount are transitive (via staff).
  // After migration 0032, the direct `departmentId` is the source of
  // truth for "this service belongs to". Transitive lists are kept
  // as a secondary signal so we can still surface cross-department
  // staff coverage on the card.
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

const DELIVERY_MODE_OPTIONS = [
  {
    value: "in_person" as const,
    label: "In-person",
    caption: "Bookable by staff with a physical or hybrid location.",
  },
  {
    value: "virtual" as const,
    label: "Virtual",
    caption: "Bookable by staff who deliver virtually (Virtual Hub or hybrid).",
  },
];

// Normalize whatever shape the server returns into a clean,
// de-duplicated array. Falls back to BOTH when missing — matches the
// migration default so old services never appear "no-mode" in the UI.
function normalizeDeliveryModes(
  raw: Array<"in_person" | "virtual"> | null | undefined,
): Array<"in_person" | "virtual"> {
  if (!Array.isArray(raw) || raw.length === 0) return ["virtual", "in_person"];
  const set = new Set<"in_person" | "virtual">();
  for (const v of raw) {
    if (v === "in_person" || v === "virtual") set.add(v);
  }
  if (set.size === 0) return ["virtual", "in_person"];
  return Array.from(set);
}

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

// ─── Service health score (Phase 18B) ─────────────────────────────
//
// Operational readiness score derived from REAL signals only. Each
// signal is binary (pass/fail); the score is the % of signals that
// pass, rounded to the nearest 5. We never fabricate values —
// "Setup incomplete" surfaces when 0 signals pass.
//
// Signals (4 today; extend by appending to SIGNAL_DEFS below):
//   1. Active        — service.isActive === 1
//   2. Staffed       — service has ≥1 assigned staff
//   3. Department    — service has an owning department (mig 0032)
//   4. Calendar cov  — ≥1 assigned staff has a healthy calendar
//                      connection (server-derived healthyStaffIds)
//
// IMPORTANT: this is a presentation-layer derivation. The booking
// engine continues to work when health < 100% — calendar-aware
// features degrade but bookings themselves still succeed. We never
// gate slot generation on health.

type ServiceHealthSignal = {
  key: "active" | "staffed" | "department" | "calendar";
  label: string;
  hint: string;
  pass: boolean;
};

type ServiceHealth = {
  /** 0-100. 0 = "Setup incomplete" (no signals pass yet). */
  pct: number;
  /** All evaluated signals, in display order. UI can render the
   *  failed ones inline ("Missing: department, calendar coverage"). */
  signals: ServiceHealthSignal[];
  /** Convenience flag for the catalog badge — "Ready" tone vs amber. */
  isFullyReady: boolean;
  /** Convenience: signals that did NOT pass, ready for a chip strip. */
  failing: ServiceHealthSignal[];
};

function deriveServiceHealth(
  s: Svc,
  healthyStaffIds: Set<string>,
): ServiceHealth {
  const hasOwningDept = (s.departmentId ?? null) !== null;
  const calendarCoverage = s.staff.length > 0
    && s.staff.some((m) => healthyStaffIds.has(m.userId));
  const signals: ServiceHealthSignal[] = [
    { key: "active",     label: "Active",            hint: "Service is bookable",                                        pass: s.isActive === 1 },
    { key: "staffed",    label: "Staffed",           hint: "At least one staff member is assigned",                      pass: s.staff.length > 0 },
    { key: "department", label: "Department mapped", hint: "Owned by a department — improves routing visibility",         pass: hasOwningDept },
    { key: "calendar",   label: "Calendar coverage", hint: "At least one assigned staff has a healthy calendar connection", pass: calendarCoverage },
  ];
  const passed = signals.filter((g) => g.pass).length;
  const pct = signals.length > 0 ? Math.round((passed / signals.length) * 100) : 0;
  return {
    pct,
    signals,
    isFullyReady: passed === signals.length,
    failing: signals.filter((g) => !g.pass),
  };
}

// Per-mode meta for the delivery-mode chip strip on each catalog
// card (Phase 18B refinement #4). Iconography + tone per mode.
const DELIVERY_MODE_META: Record<"in_person" | "virtual", {
  label: string;
  short: string;
  tone: string;
}> = {
  in_person: {
    label: "In-person",
    short: "In-person",
    tone: "bg-amber-50/80 text-amber-800 ring-amber-200/40",
  },
  virtual: {
    label: "Virtual",
    short: "Virtual",
    tone: "bg-violet-50/80 text-violet-800 ring-violet-200/40",
  },
};

// ─── Main client ───────────────────────────────────────────────────

type StaffOption = {
  id: string;
  name: string;
  avatarUrl: string | null;
  departmentId: string | null;
  departmentName: string | null;
};

export default function ServicesClient({
  isAdmin,
  allStaff,
  allDepartments,
  tenantSlug,
  tenantName,
  planInfo,
  healthyStaffIds,
}: {
  isAdmin: boolean;
  allStaff: StaffOption[];
  allDepartments: { id: string; name: string; color: string | null }[];
  /** Tenant identifier used to construct public booking URLs.
   *  Threaded from the server page so we never have to fetch /api/tenant
   *  from the client. Null when the tenant lookup failed server-side
   *  (the page redirects in that case, but we keep the type honest). */
  tenantSlug?: string | null;
  tenantName?: string | null;
  /** Phase 18 plan capability snapshot. The component recomputes the
   *  live "atCap" / "remaining" values from `rows` so deletes free
   *  up capacity instantly; these seeded values matter only for the
   *  first paint before the /api/services round-trip lands. */
  planInfo: {
    id: string;
    name: string;
    maxActiveServices: number;   // -1 = unlimited
    initialActiveCount: number;
    initialAtCap: boolean;
  };
  /** Phase 18B: tenant-wide set of staff IDs that have a healthy
   *  calendar connection (active + no trailing error). Used by
   *  deriveServiceHealth to compute the "Calendar coverage" signal
   *  per service without a per-card round-trip. */
  healthyStaffIds: string[];
}) {
  const healthyStaffIdSet = React.useMemo(
    () => new Set(healthyStaffIds),
    [healthyStaffIds],
  );
  const [rows, setRows] = React.useState<Svc[] | null>(null);
  // Edit-service drawer: existing "new" + service-id state
  const [openId, setOpenId] = React.useState<string | "new" | null>(null);
  // Dedicated Assign-Staff panel: separate state, separate workflow
  const [assignStaffId, setAssignStaffId] = React.useState<string | null>(null);
  // Share Service panel: separate state, opens via the Share icon
  const [shareId, setShareId] = React.useState<string | null>(null);

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

  // ── Plan cap snapshot (Phase 18) ───────────────────────────────
  // Derived live from `rows` so deletes/reactivations re-evaluate
  // without a page refresh. Falls back to the server-seeded values
  // before the first /api/services load completes — prevents a flash
  // of "Add service" before the lockout state hydrates.
  const planCap = React.useMemo(() => {
    const max = planInfo.maxActiveServices;
    const used = rows === null ? planInfo.initialActiveCount : metrics.active;
    if (max < 0) {
      return { used, max: -1, remaining: -1, atCap: false, unlimited: true };
    }
    const remaining = Math.max(0, max - used);
    const atCap = used >= max;
    return { used, max, remaining, atCap, unlimited: false };
  }, [rows, metrics.active, planInfo.maxActiveServices, planInfo.initialActiveCount]);

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
        <ServicesHero
          isAdmin={isAdmin}
          onAdd={() => setOpenId("new")}
          planCap={planCap}
          planName={planInfo.name}
        />
      </FadeIn>

      {/* ── Cap-reached upgrade card (Phase 18) ──────────────── */}
      {isAdmin && planCap.atCap && (
        <FadeIn delay={1}>
          <ServiceCapUpgradeCard planName={planInfo.name} max={planCap.max} />
        </FadeIn>
      )}

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
            tone={planCap.atCap ? "warning" : "brand"}
            hint={
              planCap.unlimited
                ? metrics.active === 0
                  ? "Awaiting service catalog"
                  : `${metrics.total} total`
                : planCap.atCap
                  ? `Plan cap reached · ${planCap.max} max on ${planInfo.name}`
                  : `${planCap.used} of ${planCap.max} on ${planInfo.name}`
            }
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
                <Skeleton key={i} className="h-56 rounded-2xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <PremiumActivationState isAdmin={isAdmin} onAdd={() => setOpenId("new")} />
          ) : (
            <ServiceDirectoryGrid
              rows={rows}
              tenantSlug={tenantSlug ?? null}
              allDepartments={allDepartments}
              healthyStaffIds={healthyStaffIdSet}
              onOpen={(id) => setOpenId(id)}
              onAssignStaff={(id) => setAssignStaffId(id)}
              onShare={(id) => setShareId(id)}
            />
          )}
        </div>
      </FadeIn>

      {/* Edit Service drawer — full configuration workflow.
          Logic preserved byte-identical. Tenant slug threaded for the
          new in-drawer Booking & sharing field (compact preview only;
          full per-staff + embed surface lives in ShareServicePanel). */}
      <ServiceDrawer
        openId={openId}
        onClose={() => setOpenId(null)}
        onSaved={() => { setOpenId(null); reload(); }}
        allStaff={allStaff}
        allDepartments={allDepartments}
        isAdmin={isAdmin}
        existing={rows ?? []}
        tenantSlug={tenantSlug ?? null}
      />

      {/* Dedicated Assign Staff panel — workforce-only workflow.
          Separate state, separate operational surface, separate PATCH
          payload that only touches staffUserIds. */}
      <AssignStaffPanel
        svc={assignStaffId ? (rows ?? []).find((r) => r.id === assignStaffId) ?? null : null}
        onClose={() => setAssignStaffId(null)}
        onSaved={() => { setAssignStaffId(null); reload(); }}
        allStaff={allStaff}
        isAdmin={isAdmin}
      />

      {/* Share Service panel — operational sharing surface.
          Public service link + per-staff pinned links + embed scaffold.
          Read-only; no PATCH/POST anywhere. */}
      <ShareServicePanel
        svc={shareId ? (rows ?? []).find((r) => r.id === shareId) ?? null : null}
        onClose={() => setShareId(null)}
        tenantSlug={tenantSlug ?? null}
        tenantName={tenantName ?? null}
      />
    </div>
  );
}

// ─── Hero ───────────────────────────────────────────────────────────

function ServicesHero({
  isAdmin,
  onAdd,
  planCap,
  planName,
}: {
  isAdmin: boolean;
  onAdd: () => void;
  planCap: { used: number; max: number; remaining: number; atCap: boolean; unlimited: boolean };
  planName: string;
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
            {/* Phase 18 capacity chip — calm pill that lives next
                to the action buttons. Hidden on unlimited plans. */}
            {!planCap.unlimited && (
              <ServiceCapChip used={planCap.used} max={planCap.max} atCap={planCap.atCap} planName={planName} />
            )}
            <HeroAction href="/dashboard/availability" icon={CalendarCheck} label="Configure scheduling" tone="ghost" />
            <HeroAction href="/dashboard/staff" icon={Users} label="Assign staff" tone="ghost" />
            {planCap.atCap ? (
              <HeroAction
                href="/dashboard/billing"
                icon={Sparkles}
                label="Upgrade to add more"
                tone="primary"
              />
            ) : (
              <HeroAction onClick={onAdd} icon={Plus} label="Add service" tone="primary" />
            )}
          </div>
        )}
      </div>
    </PremiumCard>
  );
}

// Plan-cap chip surfaced in the hero action row. Calm tones when
// there's headroom; amber when the cap is reached so the operator
// understands why "Add service" is locked.
function ServiceCapChip({
  used,
  max,
  atCap,
  planName,
}: {
  used: number;
  max: number;
  atCap: boolean;
  planName: string;
}) {
  // Phase 18B refinement #8 — surface remaining capacity in human
  // language. "2 slots remaining" reads more operationally than a
  // raw "1 / 3" pill, but we keep the tabular ratio for at-a-glance
  // scanning. At-cap copy stays calm: "Service capacity reached".
  const remaining = Math.max(0, max - used);
  const subline = atCap
    ? "Service capacity reached"
    : remaining === 1
      ? "1 slot remaining"
      : `${remaining} slots remaining`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        atCap
          ? "border-amber-300/40 bg-amber-50/80 text-amber-800"
          : "border-border bg-surface/80 text-ink-muted",
      )}
      title={`${planName} plan supports up to ${max} active services · ${subline}`}
    >
      <Briefcase
        className={cn("h-3 w-3", atCap ? "text-amber-600" : "text-brand-accent")}
        strokeWidth={2}
      />
      <span className="tabular-nums">
        <span className="font-semibold text-ink">{used}</span>
        <span className="text-ink-subtle"> / {max}</span>
      </span>
      <span className="hidden sm:inline">{subline}</span>
      <span className="sm:hidden">services</span>
    </span>
  );
}

// Premium cap-reached upgrade card (Phase 18 refinement #6).
// Renders only when the workspace is at its active-services cap.
// Tone is aspirational — surfaces what Pro+ unlocks rather than
// lecturing about the limit.
function ServiceCapUpgradeCard({
  planName,
  max,
}: {
  planName: string;
  max: number;
}) {
  const perks: string[] = [
    "Unlimited active services",
    "Advanced routing across the workforce",
    "Multi-location delivery hubs",
    "Departments + service ownership",
    "Operational analytics dashboards",
  ];
  return (
    <PremiumCard className="relative overflow-hidden p-5">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-amber-400/[0.10] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-12 bottom-0 h-32 w-32 rounded-full bg-brand-accent/[0.10] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />

      <div className="relative flex flex-wrap items-start gap-4">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-amber-200/60">
          <Sparkles className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700">
            Service capacity reached
          </div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
            You&apos;re using all {max} active services on {planName}.
          </h2>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
            Expand your booking surface with unlimited services and the full operational stack — or archive
            an existing service to free up a slot on your current plan.
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-1 text-[11.5px] text-ink-muted sm:grid-cols-2">
            {perks.map((p) => (
              <li key={p} className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-brand-accent" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-[0_2px_8px_rgba(53,157,243,0.20)] transition-all duration-[220ms] hover:-translate-y-0.5 hover:shadow-[0_4px_14px_rgba(53,157,243,0.30)]"
          >
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            Upgrade plan
          </Link>
          <Link
            href="#services-grid"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-muted transition-colors duration-[200ms] hover:bg-surface-inset"
          >
            Manage existing
          </Link>
        </div>
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

// ─── Service directory grid ───────────────────────────────────────
//
// Phase 13B — adapts column count to the number of services and
// renders an "Operational architecture" insight tile alongside small
// grids so a single floating card doesn't look orphaned.

function ServiceDirectoryGrid({
  rows,
  tenantSlug,
  allDepartments,
  healthyStaffIds,
  onOpen,
  onAssignStaff,
  onShare,
}: {
  rows: Svc[];
  tenantSlug: string | null;
  /** Threaded so each card can resolve its direct ownership
   *  (svc.departmentId → name + color) without a per-card fetch. */
  allDepartments: { id: string; name: string; color: string | null }[];
  /** Tenant-wide healthy-staff set (Phase 18B). Passed straight to
   *  each ServiceOpCard so health derivation is a pure function call. */
  healthyStaffIds: Set<string>;
  onOpen: (id: string) => void;
  onAssignStaff: (id: string) => void;
  onShare: (id: string) => void;
}) {
  // Build the resolver once for the whole grid render so every card
  // looks up names/colors from the same memoized map.
  const departmentById = React.useMemo(() => {
    const m = new Map<string, { name: string; color: string | null }>();
    for (const d of allDepartments) m.set(d.id, { name: d.name, color: d.color });
    return m;
  }, [allDepartments]);
  const count = rows.length;
  const showArchitectureTile = count > 0 && count <= 2;

  // Column heuristic — keep card width comfortable at low counts so
  // they don't stretch to absurd widths, but scale up at high counts.
  // Three tiers: 1 / 2 / 3+
  const gridCls =
    count >= 3
      ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      : count === 2
        ? "grid grid-cols-1 gap-3 lg:grid-cols-2"
        : "grid grid-cols-1 gap-3";

  return (
    <div className={cn(showArchitectureTile && "lg:grid lg:grid-cols-[1fr_280px] lg:gap-3")}>
      <ul className={gridCls}>
        {rows.map((s, idx) => (
          <li
            key={s.id}
            style={{
              animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${Math.min(idx, 8) * 50}ms both`,
            }}
          >
            <ServiceOpCard
              svc={s}
              tenantSlug={tenantSlug}
              departmentById={departmentById}
              healthyStaffIds={healthyStaffIds}
              onOpen={() => onOpen(s.id)}
              onAssignStaff={() => onAssignStaff(s.id)}
              onShare={() => onShare(s.id)}
            />
          </li>
        ))}
      </ul>
      {showArchitectureTile && (
        <div
          className="mt-3 lg:mt-0"
          style={{ animation: `zm-row-in 0.5s cubic-bezier(0.16,1,0.3,1) 200ms both` }}
        >
          <ArchitectureInsightTile rows={rows} />
        </div>
      )}
    </div>
  );
}

// ─── Service operational card ─────────────────────────────────────
//
// Phase 13B — richer operational entity, not a simple booking tile.
// The card body is divided into:
//
//   1. Header strip (icon swatch + name + readiness chip)
//   2. Description (optional)
//   3. Operational meta row (duration · price · meeting mode · 30d bookings)
//   4. Department ownership zone (always visible — chips OR explicit
//      "Department not assigned" warning pill)
//   5. Staff zone with avatar group OR "No staff assigned" warning
//   6. Calm contextual insight line (state-aware operational guidance)
//   7. Action bar (Assign staff / Configure availability /
//      Configure routing / Edit service) — icons only, accessible
//      labels via aria-label + title
//
// The card's clickable region is the body (above the action bar);
// action bar items are independent buttons/links so we never nest
// buttons. e.stopPropagation guards keep them functioning even when
// the card's surface receives a click.

function ServiceOpCard({
  svc,
  tenantSlug,
  departmentById,
  healthyStaffIds,
  onOpen,
  onAssignStaff,
  onShare,
}: {
  svc: Svc;
  /** Tenant identifier used to compose the public booking URL right
   *  on the card when the service is publicly bookable. Null when
   *  the tenant lookup failed server-side. */
  tenantSlug: string | null;
  /** Department id → (name, color) lookup, threaded from the grid
   *  parent so every card can resolve its direct ownership without
   *  per-card fetches. */
  departmentById: Map<string, { name: string; color: string | null }>;
  /** Tenant-wide healthy-staff set (Phase 18B). */
  healthyStaffIds: Set<string>;
  onOpen: () => void;
  onAssignStaff: () => void;
  onShare: () => void;
}) {
  const accent = serviceColor(svc.id, svc.color);
  const readiness = deriveReadiness(svc);
  const health = React.useMemo(() => deriveServiceHealth(svc, healthyStaffIds), [svc, healthyStaffIds]);
  const inactive = svc.isActive !== 1;
  const meeting = deriveMeetingMode(svc.videoProvider ?? null);
  const deliveryModes = normalizeDeliveryModes(svc.deliveryModes);

  // Primary ownership: the direct `departmentId` (migration 0032).
  // If null/undefined, the service is explicitly unassigned — even if
  // its staff happen to belong to a department, that is now treated
  // as secondary "delivered by" information, not ownership.
  const owningDept = svc.departmentId ? departmentById.get(svc.departmentId) ?? null : null;
  const hasOwningDept = owningDept !== null;

  // Secondary signal: transitive department coverage via staff. Only
  // surfaced when distinct from the owning department, so we never
  // double-render the same chip.
  const transitiveNames = (svc.departmentNames ?? []).filter(
    (n) => !owningDept || n !== owningDept.name,
  );
  const transitiveCount = svc.departmentCount ?? 0;

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-surface shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        inactive
          ? "border-border opacity-85 hover:opacity-100"
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

      {/* Clickable body — opens the edit drawer */}
      <button
        type="button"
        onClick={onOpen}
        className="relative block w-full text-left p-4 pl-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40"
        aria-label={`Open ${svc.name}`}
      >
        {/* Header — color swatch + name + readiness */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-[0_2px_8px_rgba(15,23,42,0.10)]"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              <Briefcase className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink">{svc.name}</h3>
              {svc.slug && (
                <div className="mt-0.5 truncate text-[10.5px] font-mono text-ink-subtle">/{svc.slug}</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <ReadinessChip readiness={readiness} />
            <ServiceHealthBadge health={health} />
            <BookableChip
              readiness={readiness}
              hasStaff={svc.staff.length > 0}
              onShare={(e) => { e.stopPropagation(); onShare(); }}
            />
          </div>
        </div>

        {/* Description */}
        {svc.description && (
          <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{svc.description}</p>
        )}

        {/* Operational meta row */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <MetaPill icon={Clock} tint="brand">
            <span className="tabular-nums font-semibold text-ink">{svc.durationMinutes}</span>
            <span className="text-ink-muted">min</span>
          </MetaPill>
          {svc.price > 0 && (
            <MetaPill icon={null} tint="neutral">
              <span className="font-semibold text-ink">${(svc.price / 100).toFixed(0)}</span>
            </MetaPill>
          )}
          <MetaPill icon={meeting.icon} tint={meeting.tint}>
            <span className="text-ink-muted">{meeting.label}</span>
          </MetaPill>
          {svc.bookingsLast30d !== undefined && svc.bookingsLast30d > 0 && (
            <MetaPill icon={CalendarRange} tint="positive">
              <span className="tabular-nums font-semibold text-emerald-700">{svc.bookingsLast30d}</span>
              <span className="text-emerald-700/80">· 30d</span>
            </MetaPill>
          )}
          {/* Phase 18B refinement #4 — delivery mode chips with
              per-mode iconography. Only renders when the service
              has explicit mode metadata (every modern service does
              since Phase 16). */}
          <DeliveryModeChips modes={deliveryModes} />
        </div>

        {/* Phase 18B refinement #1 — operational hints surfaced
            inline when health < 100%. Reads from the same derived
            signals as the badge above so the badge + hints can
            never disagree. */}
        {!inactive && !health.isFullyReady && health.failing.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Needs
            </span>
            {health.failing.map((g) => (
              <span
                key={g.key}
                className="inline-flex items-center gap-1 rounded-full bg-amber-50/80 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-amber-200/40"
                title={g.hint}
              >
                {g.label}
              </span>
            ))}
          </div>
        )}

        {/* Department ownership — always visible.
            Primary signal = direct `departmentId` (migration 0032).
            Secondary "delivered by" line surfaces transitive
            departments (via staff) only when distinct, so operators
            can still see if delivery crosses department boundaries
            without confusing it with ownership. */}
        <div className="mt-3">
          <div className="text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            Department ownership
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {hasOwningDept ? (
              <DepartmentChip name={owningDept!.name} color={owningDept!.color} primary />
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-amber-800 ring-1 ring-amber-200/40">
                <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2} />
                Department not assigned
              </span>
            )}
          </div>
          {transitiveNames.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-ink-subtle">
              <span className="font-medium uppercase tracking-[0.06em] text-ink-subtle/80">
                Also delivered by
              </span>
              {transitiveNames.slice(0, 2).map((d) => (
                <DepartmentChip key={d} name={d} subtle />
              ))}
              {transitiveCount > transitiveNames.slice(0, 2).length + (hasOwningDept ? 1 : 0) && (
                <span>
                  +{transitiveCount - transitiveNames.slice(0, 2).length - (hasOwningDept ? 1 : 0)} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Staff + routing row */}
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

        {/* Contextual insight line */}
        <ServiceInsight svc={svc} readiness={readiness} />
      </button>

      {/* Inline booking URL strip — only rendered when the service
       *  is publicly bookable AND we have the tenant slug. Surfaces
       *  the URL directly on the card so admins can copy/open without
       *  diving into the share panel for simple distribution. Sits
       *  OUTSIDE the click-button so the copy/open buttons don't
       *  accidentally trigger the open-drawer click. */}
      {readiness === "ready" && svc.staff.length > 0 && tenantSlug && svc.slug && (
        <InlineBookingUrl
          tenantSlug={tenantSlug}
          serviceSlug={svc.slug}
        />
      )}

      {/* Action bar — sits OUTSIDE the click-button so we don't nest
       *  buttons. Action bar items have their own handlers and links.
       *  Assign Staff, Share, and Edit Service all have separate
       *  handlers that open distinct operational workflows. */}
      <ServiceActionBar
        svc={svc}
        onAssignStaff={onAssignStaff}
        onShare={onShare}
        onEdit={onOpen}
      />
    </article>
  );
}

function ReadinessChip({ readiness }: { readiness: Readiness }) {
  const cfg =
    readiness === "ready" ? {
      cls: "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40",
      icon: CheckCircle2,
    }
    : readiness === "partial" ? {
      cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40",
      icon: CircleDot,
    }
    : {
      cls: "bg-surface-inset text-ink-muted ring-border/50",
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

// ─── Service health badge (Phase 18B refinement #5) ───────────────
//
// Compact "X%" pill in the card header. Tone scales with the score:
//   100% -> emerald (fully ready)
//   75%  -> brand
//   50%  -> amber
//   <50% -> rose
// "Setup incomplete" replaces the percentage when 0 signals pass —
// keeps us honest per the brief ("If incomplete: show 'Setup
// incomplete' instead of fake percentages").

function ServiceHealthBadge({ health }: { health: ServiceHealth }) {
  if (health.pct === 0) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/50"
        title="No readiness signals pass yet — finish setup to activate this service."
      >
        Setup incomplete
      </span>
    );
  }
  const tone =
    health.pct === 100
      ? "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40"
      : health.pct >= 75
        ? "bg-brand-subtle text-brand-accent ring-brand-accent/20"
        : health.pct >= 50
          ? "bg-amber-50/80 text-amber-800 ring-amber-200/40"
          : "bg-rose-50/80 text-rose-700 ring-rose-200/40";
  const missingSummary =
    health.failing.length > 0
      ? `Needs: ${health.failing.map((s) => s.label.toLowerCase()).join(", ")}.`
      : "All readiness signals pass.";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1 tabular-nums",
        tone,
      )}
      title={`Service readiness · ${health.pct}% · ${missingSummary}`}
    >
      <Activity className="h-2.5 w-2.5" strokeWidth={2} />
      {health.pct}%
    </span>
  );
}

// Per-mode chip strip rendered in the meta row (Phase 18B refinement
// #4). Skips render when there's nothing to surface so single-mode
// services don't add visual noise.

function DeliveryModeChips({ modes }: { modes: Array<"in_person" | "virtual"> }) {
  if (modes.length === 0) return null;
  // Hybrid = both modes selected. Surface as a single elegant chip
  // instead of two side-by-side ones — cleaner operational signal.
  if (modes.includes("in_person") && modes.includes("virtual")) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 bg-sky-50/80 text-sky-800 ring-sky-200/40"
        title="Bookable in-person and online — staff with hybrid or matching delivery mode are eligible."
      >
        Hybrid
      </span>
    );
  }
  return (
    <>
      {modes.map((m) => {
        const meta = DELIVERY_MODE_META[m];
        return (
          <span
            key={m}
            className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1", meta.tone)}
            title={`Delivery mode · ${meta.label}`}
          >
            {meta.short}
          </span>
        );
      })}
    </>
  );
}

// `primary` — the service's directly-owned department (migration
//             0032). Rendered with a colored dot and a stronger
//             border so it visually wins over secondary chips.
// `subtle`  — used for transitive "also delivered by" chips. Lower
//             contrast so the eye lands on the owning dept first.
// `color`   — optional hex from the department row; falls back to
//             brand accent when unset.
function DepartmentChip({
  name,
  color,
  primary,
  subtle,
}: {
  name: string;
  color?: string | null;
  primary?: boolean;
  subtle?: boolean;
}) {
  const dot = color || "#359df3";
  if (primary) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-brand-accent/30 bg-brand-accent/8 px-2 py-0.5 text-[10.5px] font-semibold text-ink"
        title={`Owned by ${name}`}
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: dot, boxShadow: `0 0 6px ${dot}66` }}
        />
        <span className="truncate max-w-[120px]">{name}</span>
      </span>
    );
  }
  if (subtle) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-surface px-1.5 py-0.5 text-[9.5px] font-medium text-ink-subtle">
        <Building2 className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={2} />
        <span className="truncate max-w-[100px]">{name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
      <Building2 className="h-2.5 w-2.5 text-brand-accent" strokeWidth={2} />
      <span className="truncate max-w-[100px]">{name}</span>
    </span>
  );
}

// ─── Meta pill primitive ──────────────────────────────────────────

type MetaTint = "brand" | "neutral" | "positive" | "warning";

function MetaPill({
  icon: Icon,
  tint,
  children,
}: {
  icon: LucideIcon | null;
  tint: MetaTint;
  children: React.ReactNode;
}) {
  const cls =
    tint === "positive" ? "bg-emerald-50/70 ring-emerald-200/40"
    : tint === "warning"  ? "bg-amber-50/70 ring-amber-200/40"
    : tint === "neutral"  ? "bg-surface-inset/70 ring-border/40"
    :                       "bg-brand-subtle/40 ring-brand-accent/15";
  const iconCls =
    tint === "positive" ? "text-emerald-600"
    : tint === "warning"  ? "text-amber-600"
    : tint === "neutral"  ? "text-ink-muted"
    :                       "text-brand-accent";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 ring-1", cls)}>
      {Icon && <Icon className={cn("h-3 w-3", iconCls)} strokeWidth={2} />}
      {children}
    </span>
  );
}

// ─── Meeting mode derivation ──────────────────────────────────────
// Honest: derive in-person/virtual from the existing videoProvider
// column. Default to "Virtual" so we never label a missing field as
// "in-person" — that would be incorrect inference.

function deriveMeetingMode(provider: string | null): {
  label: string;
  icon: LucideIcon;
  tint: MetaTint;
} {
  switch (provider) {
    case "none":
      return { label: "In-person", icon: MapPin, tint: "neutral" };
    case "google_meet":
      return { label: "Google Meet", icon: Video, tint: "brand" };
    case "zoom":
      return { label: "Zoom", icon: Video, tint: "brand" };
    case "teams":
      return { label: "Teams", icon: Video, tint: "brand" };
    default:
      return { label: "Virtual", icon: Video, tint: "neutral" };
  }
}

// ─── Service insight line ─────────────────────────────────────────
// Calm, state-aware operational guidance. Renders one line. Honest
// signals only.

function ServiceInsight({
  svc,
  readiness,
}: {
  svc: Svc;
  readiness: Readiness;
}) {
  const hasStaff = svc.staff.length > 0;
  const hasDepartment = (svc.departmentNames?.length ?? 0) > 0;
  const hasBookings = (svc.bookingsLast30d ?? 0) > 0;

  let text: string;
  let tone: "neutral" | "positive" | "warning" | "brand";

  if (readiness === "inactive") {
    text = "This service is not yet bookable.";
    tone = "warning";
  } else if (!hasStaff) {
    text = "Assign staff to activate scheduling.";
    tone = "warning";
  } else if (!hasDepartment) {
    text = "Department ownership improves routing intelligence.";
    tone = "brand";
  } else if (hasBookings) {
    text = `Routing active — ${svc.bookingsLast30d} ${svc.bookingsLast30d === 1 ? "booking" : "bookings"} in the last 30 days.`;
    tone = "positive";
  } else {
    text = "Ready for booking. Awaiting first customer activity.";
    tone = "brand";
  }

  const cls =
    tone === "positive" ? "bg-emerald-50/50 text-emerald-800/90 ring-emerald-200/30"
    : tone === "warning"  ? "bg-amber-50/40 text-amber-900/90 ring-amber-200/30"
    : tone === "brand"    ? "bg-brand-subtle/40 text-brand-accent ring-brand-accent/15"
    :                       "bg-surface-inset/40 text-ink-muted ring-border/40";

  const dotCls =
    tone === "positive" ? "bg-emerald-500"
    : tone === "warning"  ? "bg-amber-500"
    : tone === "brand"    ? "bg-brand-accent"
    :                       "bg-ink-subtle/50";

  return (
    <div className={cn("mt-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ring-1", cls)}>
      <span aria-hidden className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", dotCls)} />
      <span className="min-w-0">{text}</span>
    </div>
  );
}

// ─── Service action bar ───────────────────────────────────────────
// Sits outside the card's clickable body so we don't nest buttons.
// All items either navigate or invoke the existing drawer (no new
// API calls, no new routes).

function ServiceActionBar({
  svc,
  onAssignStaff,
  onShare,
  onEdit,
}: {
  svc: Svc;
  /** Opens the dedicated Assign Staff panel (workforce-only flow). */
  onAssignStaff: () => void;
  /** Opens the Share Service panel (booking link distribution). */
  onShare: () => void;
  /** Opens the full service-edit drawer (configuration flow). */
  onEdit: () => void;
}) {
  // Encourage the next operational step based on current state.
  const needsStaff = svc.staff.length === 0;
  const needsDept = (svc.departmentNames?.length ?? 0) === 0;

  return (
    <div className="relative flex items-center justify-end gap-0.5 border-t border-border/50 bg-surface-subtle/30 px-2 py-1.5">
      <ActionButton
        icon={UserPlus}
        label="Assign staff"
        onClick={onAssignStaff}
        highlight={needsStaff}
      />
      <ActionButton
        icon={Share2}
        label="Share booking link"
        onClick={onShare}
      />
      <ActionLink
        icon={CalendarCheck}
        label="Configure availability"
        href="/dashboard/availability"
      />
      <ActionLink
        icon={Settings}
        label="Configure routing"
        href="/dashboard/settings/routing"
        highlight={needsDept}
      />
      <span aria-hidden className="mx-0.5 inline-block h-3 w-px bg-border/60" />
      <ActionButton
        icon={Pencil}
        label="Edit service"
        onClick={onEdit}
      />
    </div>
  );
}

// ─── Inline booking URL strip ─────────────────────────────────────
// Surfaces the public booking URL directly on the card when the
// service is publicly bookable. Sits between the click-body and the
// action bar so the copy/open controls are independent of the
// open-drawer click. Stable URL = /u/{tenantSlug}/{serviceSlug} —
// no new routes.

function InlineBookingUrl({
  tenantSlug,
  serviceSlug,
}: {
  tenantSlug: string;
  serviceSlug: string;
}) {
  const path = `/u/${tenantSlug}/${serviceSlug}`;
  const fullUrl =
    typeof window !== "undefined" ? `${window.location.origin}${path}` : path;

  async function copy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast("Booking link copied.", "success");
    } catch {
      toast("Could not copy — please copy manually", "error");
    }
  }

  return (
    <div className="relative flex items-center gap-1 border-t border-emerald-200/30 bg-gradient-to-r from-emerald-50/50 via-surface to-surface px-3 py-1.5">
      <Globe className="h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2} />
      <code
        className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted"
        title={fullUrl}
      >
        {path}
      </code>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); copy(); }}
        title="Copy booking link"
        aria-label="Copy booking link"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-subtle transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface hover:text-ink hover:shadow-soft"
      >
        <Copy className="h-3 w-3" strokeWidth={1.75} />
      </button>
      <a
        href={fullUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open booking page"
        aria-label="Open booking page in new tab"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-subtle transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface hover:text-ink hover:shadow-soft"
      >
        <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
      </a>
    </div>
  );
}

// ─── Bookable status chip — derived honestly from real fields ──────
// Public bookability is a function of: isActive=1 AND staff.length > 0.
// We surface this as a calm informational chip beside readiness.
// When onShare is provided, the chip becomes interactive and opens
// the share panel (with stopPropagation so it doesn't also trigger
// the card's open-drawer click).
//
// We deliberately render this as a <span role="button"> rather than
// a real <button> because the chip lives inside the card body which
// is itself a <button> — nested buttons are invalid HTML. Keyboard
// users still have a real Share <button> in the action bar.

function BookableChip({
  readiness,
  hasStaff,
  onShare,
}: {
  readiness: Readiness;
  hasStaff: boolean;
  onShare?: (e: React.MouseEvent) => void;
}) {
  const interactive = Boolean(onShare);
  if (readiness === "ready" && hasStaff) {
    return (
      <span
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={onShare}
        onKeyDown={
          interactive
            ? (e) => {
                if ((e.key === "Enter" || e.key === " ") && onShare) {
                  e.preventDefault();
                  // Cast through unknown — keyboard event doesn't carry
                  // stopPropagation semantics the same way, but the
                  // handler only reads .stopPropagation in the mouse
                  // path. Safe to pass a minimal shim.
                  onShare({ stopPropagation: () => {} } as unknown as React.MouseEvent);
                }
              }
            : undefined
        }
        title={interactive ? "Share booking link" : undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-emerald-50/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-emerald-700 ring-1 ring-emerald-200/40",
          interactive && "cursor-pointer transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_2px_8px_rgba(16,185,129,0.25)] hover:bg-emerald-50",
        )}
      >
        <Globe className="h-2.5 w-2.5" strokeWidth={2} />
        Publicly bookable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-muted ring-1 ring-border/50">
      <Lock className="h-2.5 w-2.5" strokeWidth={2} />
      Internal only
    </span>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  highlight,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={label}
      aria-label={label}
      className={cn(
        "group/btn inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface hover:text-ink hover:shadow-soft",
        highlight && "text-amber-700 hover:text-amber-800",
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {highlight && (
        <span aria-hidden className="ml-px inline-block h-1 w-1 rounded-full bg-amber-500" />
      )}
    </button>
  );
}

function ActionLink({
  icon: Icon,
  label,
  href,
  highlight,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  highlight?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface hover:text-ink hover:shadow-soft",
        highlight && "text-amber-700 hover:text-amber-800",
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {highlight && (
        <span aria-hidden className="ml-px inline-block h-1 w-1 rounded-full bg-amber-500" />
      )}
    </Link>
  );
}

// ─── Architecture insight tile (low-density companion) ────────────
//
// Rendered alongside the service grid when the workspace has only
// 1–2 services, so the page doesn't feel sparse. Calm executive
// styling, no fabricated metrics — content adapts to what we
// actually know about the workspace.

function ArchitectureInsightTile({ rows }: { rows: Svc[] }) {
  const totalStaff = rows.reduce((s, r) => s + r.staff.length, 0);
  const hasAnyDept = rows.some((r) => (r.departmentNames?.length ?? 0) > 0);
  const allReady = rows.every((r) => deriveReadiness(r) === "ready");

  const items: { icon: LucideIcon; title: string; body: string; tone: "neutral" | "positive" | "brand" | "warning" }[] = [];

  items.push({
    icon: Briefcase,
    title: `${rows.length} ${rows.length === 1 ? "service" : "services"} configured`,
    body: rows.length === 1
      ? "Add more services to broaden your booking surface."
      : "Add more services to expand your operational catalog.",
    tone: "brand",
  });
  items.push({
    icon: Users,
    title: totalStaff > 0 ? `${totalStaff} staff ${totalStaff === 1 ? "assignment" : "assignments"}` : "No staff assigned",
    body: totalStaff > 0
      ? "Workforce is connected to your service catalog."
      : "Assign staff to activate routing.",
    tone: totalStaff > 0 ? "positive" : "warning",
  });
  items.push({
    icon: Building2,
    title: hasAnyDept ? "Departments connected" : "Departments not connected",
    body: hasAnyDept
      ? "Department ownership is in place for routing intelligence."
      : "Connect services to departments to enable operational routing.",
    tone: hasAnyDept ? "positive" : "brand",
  });
  items.push({
    icon: Workflow,
    title: allReady ? "Booking coverage ready" : "Booking coverage in progress",
    body: allReady
      ? "All services are staffed and bookable."
      : "Complete the steps above to activate public booking.",
    tone: allReady ? "positive" : "neutral",
  });

  return (
    <aside
      className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand-subtle/35 via-surface to-surface p-4 shadow-soft"
      aria-label="Service architecture insight"
    >
      <div aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/[0.12] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />

      <div className="relative">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          Service architecture
        </div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
          Operational composition
        </h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
          A quick read on how your service catalog connects to staff, departments, and booking coverage.
        </p>

        <ul className="mt-3 space-y-1.5">
          {items.map((it, i) => {
            const Icon = it.icon;
            const iconBg =
              it.tone === "positive" ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
              : it.tone === "warning"  ? "bg-amber-50 text-amber-700 ring-amber-200/40"
              : it.tone === "brand"    ? "bg-brand-subtle text-brand-accent ring-brand-accent/15"
              :                          "bg-surface-inset text-ink-subtle ring-border/40";
            return (
              <li key={i} className="flex items-start gap-2">
                <div className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1", iconBg)}>
                  <Icon className="h-3 w-3" strokeWidth={2} />
                </div>
                <div className="min-w-0">
                  <div className="text-[11.5px] font-semibold tracking-tight text-ink">{it.title}</div>
                  <div className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{it.body}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
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
  openId, onClose, onSaved, allStaff, allDepartments, isAdmin, existing, tenantSlug,
}: {
  openId: string | "new" | null;
  onClose: () => void;
  onSaved: () => void;
  allStaff: StaffOption[];
  allDepartments: { id: string; name: string; color: string | null }[];
  isAdmin: boolean;
  existing: Svc[];
  /** Threaded for the Booking & sharing field inside the drawer. */
  tenantSlug: string | null;
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
  // Phase 16 — per-service delivery compatibility (migration 0037).
  // Service must accept at least one mode; default to BOTH so every
  // existing service stays bookable in either delivery model.
  const [deliveryModes, setDeliveryModes] = React.useState<Array<"in_person" | "virtual">>([
    "virtual",
    "in_person",
  ]);
  const [selectedStaff, setSelectedStaff] = React.useState<Set<string>>(new Set());
  // Direct department ownership (migration 0032). `null` = explicit
  // "no department". The drawer never persists `undefined` — we
  // always serialize to either a uuid or null so admins can clear
  // an assignment.
  const [departmentId, setDepartmentId] = React.useState<string | null>(null);
  const [deptQuery, setDeptQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (svc) {
      setName(svc.name); setDescription(svc.description ?? "");
      setDurationMinutes(svc.durationMinutes); setPrice(svc.price);
      setBufferBefore(svc.bufferBefore); setBufferAfter(svc.bufferAfter);
      setColor(svc.color ?? DEFAULT_COLORS[0]);
      setIsActive(svc.isActive === 1);
      setVideoProvider(svc.videoProvider ?? "google_meet");
      setDeliveryModes(normalizeDeliveryModes(svc.deliveryModes));
      setSelectedStaff(new Set(svc.staff.map((s) => s.userId)));
      setDepartmentId(svc.departmentId ?? null);
      setDeptQuery("");
    } else if (isNew) {
      setName(""); setDescription(""); setDurationMinutes(30);
      setPrice(0); setBufferBefore(0); setBufferAfter(0);
      setColor(DEFAULT_COLORS[0]); setIsActive(true);
      setVideoProvider("google_meet");
      setDeliveryModes(["virtual", "in_person"]);
      setSelectedStaff(new Set());
      setDepartmentId(null);
      setDeptQuery("");
    }
  }, [openId, svc, isNew]);

  // Department picker: filtered alphabetically by query
  const filteredDepartments = React.useMemo(() => {
    const q = deptQuery.trim().toLowerCase();
    const list = q
      ? allDepartments.filter((d) => d.name.toLowerCase().includes(q))
      : allDepartments;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [allDepartments, deptQuery]);
  const selectedDept = departmentId
    ? allDepartments.find((d) => d.id === departmentId) ?? null
    : null;

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
      if (deliveryModes.length === 0) {
        toast("Pick at least one delivery mode", "error");
        setBusy(false);
        return;
      }
      const payload = {
        name, description: description || null,
        durationMinutes, price, bufferBefore, bufferAfter, color,
        isActive,
        videoProvider,
        // Phase 16 (migration 0037). Sorted for deterministic
        // payloads — the server normalizes ordering anyway.
        deliveryModes: [...deliveryModes].sort(),
        staffUserIds: Array.from(selectedStaff),
        // Direct department ownership (migration 0032).
        // `null` clears the assignment server-side; a uuid sets it.
        departmentId,
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

  return (
    <Drawer open={open} onClose={onClose} side="right" size="workspace" ariaLabel="Service editor">
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

          {/* Phase 16 — per-service delivery compatibility
              (migration 0037). Determines which staff are eligible
              once the routing layer intersects with each staff's
              per-day location type. Defaults to BOTH so existing
              services stay bookable in either mode. */}
          <Field label="Delivery modes">
            <div className="space-y-1.5">
              {DELIVERY_MODE_OPTIONS.map((opt) => {
                const on = deliveryModes.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className={
                      "flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm " +
                      (on ? "ring-1 ring-brand-accent/30" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!isAdmin}
                      onChange={() => {
                        setDeliveryModes((cur) => {
                          if (cur.includes(opt.value)) {
                            // Block deselect of the last remaining mode — server
                            // would reject anyway; cleaner to no-op here.
                            if (cur.length <= 1) return cur;
                            return cur.filter((v) => v !== opt.value);
                          }
                          return [...cur, opt.value];
                        });
                      }}
                      className="mt-0.5 h-4 w-4 accent-brand-accent"
                    />
                    <span className="flex-1">
                      <span className="block text-ink">{opt.label}</span>
                      <span className="block text-[11px] text-ink-subtle">{opt.caption}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-ink-subtle">
              At least one mode is required. Both selected = service is visible to every
              eligible staff regardless of delivery surface.
            </p>
          </Field>

          <Field label="Status">
            <label className="inline-flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={isActive} disabled={!isAdmin} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-brand-accent" />
              Active and bookable
            </label>
          </Field>

          {/* Department ownership — single primary department per
              service (migration 0032). Searchable picker over the
              tenant's departments. Empty state is allowed: a service
              can be created unassigned and the operator can later
              route it to a department. Tenant scope is enforced
              server-side on save. */}
          <Field label="Department ownership">
            {selectedDept ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-brand-accent/30 bg-brand-accent/8 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: selectedDept.color || "#359df3",
                      boxShadow: `0 0 6px ${selectedDept.color || "#359df3"}66`,
                    }}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-ink">{selectedDept.name}</div>
                    <div className="text-[10.5px] text-ink-subtle">Owns this service · drives department routing</div>
                  </div>
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setDepartmentId(null)}
                    className="shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] font-medium text-ink-muted hover:bg-surface-inset hover:text-ink"
                  >
                    Clear
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-amber-300/50 bg-amber-50/40 px-3 py-2 text-[11.5px] text-amber-900">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                <span>
                  This service is unassigned. Pick a department below to give it operational ownership.
                </span>
              </div>
            )}

            {isAdmin && (
              <div className="mt-2 space-y-1.5">
                {allDepartments.length > 6 && (
                  <input
                    type="search"
                    value={deptQuery}
                    onChange={(e) => setDeptQuery(e.target.value)}
                    placeholder="Search departments…"
                    className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] placeholder:text-ink-subtle"
                  />
                )}
                {allDepartments.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-ink-subtle">
                    No departments configured yet.
                  </div>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border bg-surface/50 p-1.5">
                    {filteredDepartments.map((d) => {
                      const on = departmentId === d.id;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setDepartmentId(on ? null : d.id)}
                          className={
                            "flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition-colors " +
                            (on
                              ? "border-brand-accent/30 bg-brand-accent/10 text-ink"
                              : "border-transparent text-ink-muted hover:border-border hover:bg-surface")
                          }
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              aria-hidden
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: d.color || "#359df3" }}
                            />
                            <span className="truncate">{d.name}</span>
                          </span>
                          {on && (
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-brand-accent">
                              Owner
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {filteredDepartments.length === 0 && (
                      <div className="px-2 py-3 text-center text-[11.5px] text-ink-subtle">
                        No matches.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
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
                <span className="font-semibold uppercase tracking-wider text-ink-muted">Also delivered by &middot; </span>
                {svc.departmentNames.join(", ")}
                {svc.departmentCount !== undefined && svc.departmentCount > svc.departmentNames.length && (
                  <> +{svc.departmentCount - svc.departmentNames.length} more</>
                )} &nbsp;<span className="text-ink-subtle/80">(derived from assigned staff &mdash; secondary signal)</span>
              </div>
            )}
          </Field>

          {/* Booking & sharing — visible inside the Edit Side Panel
              for any existing service. Compact surface: public URL
              with copy + open, plus a calm pointer to the dedicated
              Share panel on the service card for per-staff URLs and
              the embed scaffold. Honors honest state: when not
              publicly bookable, surfaces the operational reason. */}
          {!isNew && svc && (
            <Field label="Booking & sharing">
              <DrawerBookingShare
                svc={svc}
                tenantSlug={tenantSlug}
                isActive={isActive}
                selectedStaffCount={selectedStaff.size}
              />
            </Field>
          )}

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

// ─── Assign Staff panel — dedicated workforce assignment workflow ──
//
// Distinct from the ServiceDrawer's full edit flow: this panel
// touches ONLY the staff assignments. PATCHes /api/services/[id]
// with { staffUserIds: [...] } — every other service field (name,
// duration, price, color, isActive, videoProvider) is preserved by
// the server's partial-body handling.
//
// Surfaces:
//   - Workforce context (current assignment count)
//   - Department-aware filter (when departments exist)
//   - Staff list with check toggles, department chips, current-assigned
//     state preserved across re-opens
//   - Live "after-save readiness preview" so admins see the projected
//     readiness state before they save
//   - Operational copy clarifying the booking implication
//
// All other service edits remain in ServiceDrawer behind the Pencil.

function AssignStaffPanel({
  svc,
  onClose,
  onSaved,
  allStaff,
  isAdmin,
}: {
  svc: Svc | null;
  onClose: () => void;
  onSaved: () => void;
  allStaff: StaffOption[];
  isAdmin: boolean;
}) {
  const open = svc !== null;

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [deptFilter, setDeptFilter] = React.useState<string | "all">("all");

  // Re-hydrate the selection set whenever the panel opens for a
  // (possibly different) service. The Drawer remounts so we use a
  // serviceId-keyed effect for safety.
  React.useEffect(() => {
    if (svc) {
      setSelected(new Set(svc.staff.map((s) => s.userId)));
      setDeptFilter("all");
    }
  }, [svc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!svc) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${svc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffUserIds: Array.from(selected) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast("Staff assignment saved", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  // Derived projected readiness — honest signal computed from the
  // staged selection rather than what's persisted.
  const projectedReady = svc?.isActive === 1 && selected.size > 0;
  const projectedPartial = svc?.isActive === 1 && selected.size === 0;
  const projectedInactive = svc?.isActive !== 1;

  // Department options derived from the staff catalog (only depts
  // that actually contain at least one assignable staff member).
  const deptOptions = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const u of allStaff) {
      if (u.departmentId && u.departmentName) {
        map.set(u.departmentId, u.departmentName);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allStaff]);

  const filteredStaff = React.useMemo(() => {
    if (deptFilter === "all") return allStaff;
    if (deptFilter === "none") return allStaff.filter((u) => !u.departmentId);
    return allStaff.filter((u) => u.departmentId === deptFilter);
  }, [allStaff, deptFilter]);

  // Splits for the panel layout
  const assigned = filteredStaff.filter((u) => selected.has(u.id));
  const available = filteredStaff.filter((u) => !selected.has(u.id));

  return (
    <Drawer open={open} onClose={onClose} side="right" size="xl" ariaLabel="Assign staff to service">
      {!svc ? null : (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-brand-subtle/35 via-surface to-surface p-5">
            <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-[0_2px_8px_rgba(53,157,243,0.30)]"
                  style={{ backgroundColor: serviceColor(svc.id, svc.color) }}
                  aria-hidden
                >
                  <UserPlus className="h-5 w-5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                    Assign staff
                  </div>
                  <h2 className="mt-0.5 truncate text-[17px] font-semibold tracking-tight text-ink">
                    {svc.name}
                  </h2>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    Activate workforce routing for this service. Only assignment changes are saved — other settings stay untouched.
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
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {/* Operational summary */}
            <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-brand-subtle/30 p-3">
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
              <div className="flex items-start gap-2.5">
                <div className="zm-pulse-glow inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_10px_rgba(53,157,243,0.30)]">
                  <Workflow className="h-3.5 w-3.5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                    Routing readiness preview
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
                    {projectedInactive
                      ? "This service is inactive — assignments are saved but the service won't be publicly bookable until it's reactivated in Edit service."
                      : projectedReady
                        ? `After save: Ready — ${selected.size} ${selected.size === 1 ? "staff member" : "staff members"} can deliver this service.`
                        : "Services without assigned staff are not publicly bookable. Add at least one staff member to activate routing."}
                  </p>
                </div>
                <span className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1",
                  projectedReady
                    ? "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40"
                    : projectedPartial
                      ? "bg-amber-50/80 text-amber-800 ring-amber-200/40"
                      : "bg-surface-inset text-ink-muted ring-border/50",
                )}>
                  {projectedReady ? "Ready" : projectedPartial ? "Partial" : "Inactive"}
                </span>
              </div>
            </div>

            {/* Department filter */}
            {deptOptions.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  Filter by department
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <DeptFilterChip
                    label="All"
                    active={deptFilter === "all"}
                    onClick={() => setDeptFilter("all")}
                  />
                  {deptOptions.map((d) => (
                    <DeptFilterChip
                      key={d.id}
                      label={d.name}
                      icon={Building2}
                      active={deptFilter === d.id}
                      onClick={() => setDeptFilter(d.id)}
                    />
                  ))}
                  {allStaff.some((u) => !u.departmentId) && (
                    <DeptFilterChip
                      label="No department"
                      active={deptFilter === "none"}
                      onClick={() => setDeptFilter("none")}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Currently assigned */}
            {assigned.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                    Currently assigned
                  </div>
                  <span className="text-[10.5px] tabular-nums text-ink-subtle">
                    {assigned.length} {assigned.length === 1 ? "member" : "members"}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-1.5">
                  {assigned.map((u) => (
                    <li key={u.id}>
                      <StaffAssignRow
                        staff={u}
                        on
                        disabled={!isAdmin}
                        onToggle={() => toggle(u.id)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Available */}
            <div>
              <div className="flex items-baseline justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                  {assigned.length > 0 ? "Available" : "Workforce"}
                </div>
                <span className="text-[10.5px] tabular-nums text-ink-subtle">
                  {available.length} {available.length === 1 ? "member" : "members"}
                </span>
              </div>
              {available.length === 0 && allStaff.length === 0 ? (
                <div className="mt-1.5 rounded-xl border border-dashed border-border bg-surface-inset/30 p-4 text-center text-[12px] text-ink-muted">
                  <Users className="mx-auto mb-2 h-5 w-5 text-ink-subtle" strokeWidth={1.5} />
                  No staff in workspace yet.
                  <div className="mt-2">
                    <Link
                      href="/dashboard/staff"
                      className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-accent hover:underline"
                    >
                      Open staff workspace
                      <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
                    </Link>
                  </div>
                </div>
              ) : available.length === 0 ? (
                <div className="mt-1.5 rounded-xl border border-dashed border-border bg-surface-inset/30 p-3 text-center text-[11.5px] text-ink-muted">
                  No additional staff match this filter.
                </div>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {available.map((u) => (
                    <li key={u.id}>
                      <StaffAssignRow
                        staff={u}
                        on={false}
                        disabled={!isAdmin}
                        onToggle={() => toggle(u.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Footer */}
          {isAdmin && (
            <div className="flex items-center justify-between border-t border-border p-4">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12.5px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  busy ? "cursor-not-allowed opacity-50" : "hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
                )}
              >
                {busy ? (
                  <>
                    <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Saving…
                  </>
                ) : (
                  <>
                    <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
                    Save assignments
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ─── Share Service panel — booking link distribution ──────────────
//
// Operational sharing surface for a single service. Read-only:
// no API mutations happen here. The panel composes URLs from
// existing data + the existing public booking routes.
//
// URL composition (uses existing routes — no new pages, no schema):
//   Public service URL : /u/{tenantSlug}/{serviceSlug}
//   Staff-pinned URL   : /u/{tenantSlug}/{serviceSlug}?staff={userId}
//   Embed URL          : /embed/{tenantSlug}/{serviceSlug}
//
// Honest scope:
//   - Staff URLs use the existing ?staff=<userId> convention to
//     preserve booking architecture. Users have no slug column today
//     and we are deliberately not adding one.
//   - Embed URL is rendered with the public route, but the actual
//     snippet builder ("paste this iframe into your site") is
//     scaffolded as Coming Soon — we have the route, not the
//     snippet generator.
//   - When a service is not publicly bookable, the panel still
//     shows the URLs so admins can stage them, but with a calm
//     amber notice making the operational consequence clear.

function ShareServicePanel({
  svc,
  onClose,
  tenantSlug,
  tenantName,
}: {
  svc: Svc | null;
  onClose: () => void;
  tenantSlug: string | null;
  tenantName: string | null;
}) {
  const open = svc !== null;

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const slug = svc?.slug ?? null;

  const publicUrl = tenantSlug && slug ? `${origin}/u/${tenantSlug}/${slug}` : "";
  const embedUrl  = tenantSlug && slug ? `${origin}/embed/${tenantSlug}/${slug}` : "";

  const readiness = svc ? deriveReadiness(svc) : "inactive";
  const publiclyBookable = svc !== null && readiness === "ready" && svc.staff.length > 0;
  const inactive = svc !== null && svc.isActive !== 1;
  const noStaff = svc !== null && svc.staff.length === 0;

  return (
    <Drawer open={open} onClose={onClose} side="right" size="xl" ariaLabel="Share service booking link">
      {!svc ? null : (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-brand-subtle/35 via-surface to-surface p-5">
            <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-[0_2px_8px_rgba(53,157,243,0.30)]"
                  style={{ backgroundColor: serviceColor(svc.id, svc.color) }}
                  aria-hidden
                >
                  <Share2 className="h-5 w-5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                    Share booking link
                  </div>
                  <h2 className="mt-0.5 truncate text-[17px] font-semibold tracking-tight text-ink">
                    {svc.name}
                  </h2>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    {tenantName ?? "Workspace"} &middot; distribute these URLs anywhere — email, Slack, your site, calendar invites.
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
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {/* Bookability status */}
            <div className={cn(
              "relative overflow-hidden rounded-2xl border p-3 ring-1",
              publiclyBookable
                ? "border-emerald-200/40 bg-emerald-50/40 ring-emerald-200/30"
                : "border-amber-200/40 bg-amber-50/40 ring-amber-200/30",
            )}>
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
              <div className="flex items-start gap-2.5">
                <div className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg shadow-soft",
                  publiclyBookable ? "bg-emerald-500 text-white" : "bg-amber-500 text-white",
                )}>
                  {publiclyBookable ? <Globe className="h-3.5 w-3.5" strokeWidth={2} /> : <Lock className="h-3.5 w-3.5" strokeWidth={2} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={cn(
                    "text-[10px] font-semibold uppercase tracking-[0.10em]",
                    publiclyBookable ? "text-emerald-700" : "text-amber-800",
                  )}>
                    {publiclyBookable ? "Publicly bookable" : "Not publicly bookable"}
                  </div>
                  <p className={cn(
                    "mt-0.5 text-[12px] leading-relaxed",
                    publiclyBookable ? "text-emerald-800/90" : "text-amber-900/90",
                  )}>
                    {publiclyBookable
                      ? "Customers landing on these URLs can complete a booking through the normal scheduling flow."
                      : inactive
                        ? "This service is currently inactive. Reactivate it in Edit service before sharing."
                        : noStaff
                          ? "Public booking unavailable until workforce assignment is complete. Use the Assign staff action on the service card."
                          : "Scheduling routing requires operational setup. Configure routing or assign staff to activate booking coverage."}
                  </p>
                </div>
              </div>
            </div>

            {/* Public service URL */}
            <ShareUrlBlock
              label="Public service URL"
              hint="Anyone with the link can book this service through the public booking page."
              url={publicUrl}
              icon={Globe}
              iconTint="brand"
              disabled={!publicUrl}
            />

            {/* Staff-pinned URLs */}
            {svc.staff.length > 0 ? (
              <div>
                <div className="flex items-baseline justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                    Staff-pinned URLs
                  </div>
                  <span className="text-[10.5px] tabular-nums text-ink-subtle">
                    {svc.staff.length} {svc.staff.length === 1 ? "member" : "members"}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                  Each link pins the booking to a specific staff member. Useful for personal scheduling, consultant pages, and direct sales handoffs.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {svc.staff.map((u) => (
                    <li key={u.userId}>
                      <StaffShareRow
                        name={u.name}
                        url={publicUrl ? `${publicUrl}?staff=${u.userId}` : ""}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-surface-inset/30 p-3 text-center text-[11.5px] text-ink-muted">
                <Users className="mx-auto mb-1.5 h-4 w-4 text-ink-subtle" strokeWidth={1.5} />
                Staff-pinned links activate once you assign staff to this service.
              </div>
            )}

            {/* Embed URL — scaffolded */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Embed URL
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                The dedicated embed route — use it to render the booking widget inside your own site.
              </p>
              <ShareUrlRow url={embedUrl} disabled={!embedUrl} />
              <div className="mt-2 rounded-lg border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11px] leading-relaxed text-ink-subtle">
                <Code2 className="mr-1 inline-block h-3 w-3" strokeWidth={1.75} />
                <span className="font-semibold uppercase tracking-wider text-ink-muted">Coming soon &middot; </span>
                A one-click iframe snippet generator with sizing presets and brand-color tokens.
              </div>
            </div>

            {/* Future routing scaffold */}
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Routing &amp; distribution
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                Round robin, department routing, weighted routing, VIP and overflow rules are configured in the routing workspace.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Link
                  href="/dashboard/settings/routing"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
                >
                  <Settings className="h-3 w-3" strokeWidth={2} />
                  Open routing settings
                  <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
                </Link>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end border-t border-border p-4">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ─── Share URL primitives ─────────────────────────────────────────

function ShareUrlBlock({
  label,
  hint,
  url,
  icon: Icon,
  iconTint,
  disabled,
}: {
  label: string;
  hint: string;
  url: string;
  icon: LucideIcon;
  iconTint: "brand" | "neutral";
  disabled?: boolean;
}) {
  const iconBg = iconTint === "brand"
    ? "bg-brand-subtle text-brand-accent ring-brand-accent/15"
    : "bg-surface-inset text-ink-muted ring-border/40";
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className={cn("inline-flex h-6 w-6 items-center justify-center rounded-md ring-1", iconBg)}>
          <Icon className="h-3 w-3" strokeWidth={2} />
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</div>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{hint}</p>
      <ShareUrlRow url={url} disabled={disabled} />
    </div>
  );
}

function ShareUrlRow({ url, disabled }: { url: string; disabled?: boolean }) {
  async function handleCopy() {
    if (disabled || !url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast("Booking link copied.", "success");
    } catch {
      toast("Could not copy — please copy manually", "error");
    }
  }

  return (
    <div className="mt-1.5 flex items-stretch gap-1.5">
      <code className={cn(
        "flex-1 truncate rounded-lg border bg-surface-inset/60 px-3 py-2 font-mono text-[11.5px]",
        disabled ? "border-border/60 text-ink-subtle" : "border-border text-ink",
      )}>
        {disabled ? "(unavailable — workspace slug missing)" : url || "(loading…)"}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        disabled={disabled || !url}
        title="Copy link"
        aria-label="Copy link"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-2.5 text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          disabled || !url
            ? "cursor-not-allowed opacity-50"
            : "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft",
        )}
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <a
        href={disabled || !url ? undefined : url}
        target="_blank"
        rel="noreferrer"
        aria-disabled={disabled || !url}
        title="Open in new tab"
        aria-label="Open in new tab"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-2.5 text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          disabled || !url
            ? "cursor-not-allowed opacity-50"
            : "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft",
        )}
        onClick={(e) => {
          if (disabled || !url) e.preventDefault();
        }}
      >
        <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
      </a>
    </div>
  );
}

function StaffShareRow({ name, url }: { name: string; url: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0]!)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast(`Booking link for ${name} copied.`, "success");
    } catch {
      toast("Could not copy — please copy manually", "error");
    }
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-accent to-brand-hover text-[10px] font-semibold text-white shadow-[0_2px_6px_rgba(53,157,243,0.20)]">
        {initials || "?"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold tracking-tight text-ink">{name}</div>
        <code className="block truncate text-[10.5px] font-mono text-ink-subtle">{url || "(unavailable)"}</code>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={handleCopy}
          disabled={!url}
          title={`Copy link for ${name}`}
          aria-label={`Copy link for ${name}`}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            url ? "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink" : "cursor-not-allowed opacity-50",
          )}
        >
          <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <a
          href={url || undefined}
          target="_blank"
          rel="noreferrer"
          title="Open in new tab"
          aria-label={`Open ${name}'s booking page`}
          onClick={(e) => { if (!url) e.preventDefault(); }}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            url ? "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink" : "cursor-not-allowed opacity-50",
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
        </a>
      </div>
    </div>
  );
}

function DeptFilterChip({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon?: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        active
          ? "bg-brand-subtle/70 text-brand-accent ring-brand-accent/30 shadow-[0_2px_6px_rgba(53,157,243,0.15)]"
          : "bg-surface text-ink-muted ring-border/50 hover:bg-surface-inset hover:text-ink",
      )}
    >
      {Icon && <Icon className={cn("h-3 w-3", active ? "text-brand-accent" : "text-ink-subtle")} strokeWidth={2} />}
      {label}
    </button>
  );
}

function StaffAssignRow({
  staff,
  on,
  disabled,
  onToggle,
}: {
  staff: StaffOption;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const initials = staff.name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0]!)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        on
          ? "ring-1 ring-brand-accent/30 shadow-[0_2px_6px_rgba(53,157,243,0.10)]"
          : "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={onToggle}
        className="h-4 w-4 accent-brand-accent"
      />
      {/* Avatar */}
      <div className="relative shrink-0">
        {staff.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={staff.avatarUrl}
            alt=""
            className="h-8 w-8 rounded-full object-cover ring-1 ring-border/40"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-accent to-brand-hover text-[10px] font-semibold text-white shadow-[0_2px_6px_rgba(53,157,243,0.20)]">
            {initials || "?"}
          </div>
        )}
        {on && (
          <span aria-hidden className="absolute -bottom-0.5 -right-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-surface">
            <CheckCircle2 className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold tracking-tight text-ink">{staff.name}</div>
        <div className="mt-0.5 truncate text-[10.5px] text-ink-subtle">
          {staff.departmentName ? (
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-2.5 w-2.5 text-brand-accent" strokeWidth={2} />
              {staff.departmentName}
            </span>
          ) : (
            <span className="italic">No department</span>
          )}
        </div>
      </div>
    </label>
  );
}

// ─── In-drawer Booking & sharing block ────────────────────────────
// Compact surface inside the Edit Service drawer. Shows the public
// service URL with copy + open actions, and a calm pointer to the
// rich ShareServicePanel on the card for per-staff URLs + embed.
// Doesn't duplicate the full share panel — keeps the drawer focused
// on configuration.

function DrawerBookingShare({
  svc,
  tenantSlug,
  isActive,
  selectedStaffCount,
}: {
  svc: Svc;
  tenantSlug: string | null;
  /** Local staged "isActive" from the drawer form — preview before save. */
  isActive: boolean;
  /** Local staged staff selection count — preview before save. */
  selectedStaffCount: number;
}) {
  const path = tenantSlug && svc.slug ? `/u/${tenantSlug}/${svc.slug}` : "";
  const fullUrl =
    path && typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
  const bookable = isActive && selectedStaffCount > 0;

  async function copy() {
    if (!fullUrl) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast("Booking link copied.", "success");
    } catch {
      toast("Could not copy — please copy manually", "error");
    }
  }

  return (
    <div className="space-y-2">
      {/* Status row */}
      <div className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ring-1",
        bookable
          ? "bg-emerald-50/60 text-emerald-800/90 ring-emerald-200/40"
          : "bg-amber-50/50 text-amber-900/90 ring-amber-200/40",
      )}>
        {bookable
          ? <Globe className="h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2} />
          : <Lock className="h-3 w-3 shrink-0 text-amber-600" strokeWidth={2} />
        }
        <span className="min-w-0 flex-1 leading-relaxed">
          {!isActive
            ? "Activate the service above to make booking links live."
            : selectedStaffCount === 0
              ? "Assign at least one staff member to activate public booking."
              : "Publicly bookable — anyone with the link can book."}
        </span>
      </div>

      {/* Public service URL with copy + open */}
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Public service URL
        </div>
        <div className="flex items-stretch gap-1.5">
          <code className={cn(
            "min-w-0 flex-1 truncate rounded-md border bg-surface-inset/60 px-2.5 py-1.5 font-mono text-[11.5px]",
            fullUrl ? "border-border text-ink" : "border-border/60 text-ink-subtle",
          )}>
            {fullUrl || "(workspace slug unavailable)"}
          </code>
          <button
            type="button"
            onClick={copy}
            disabled={!fullUrl}
            title="Copy booking link"
            aria-label="Copy booking link"
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-surface px-2.5 text-ink-muted transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              fullUrl
                ? "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
                : "cursor-not-allowed opacity-50",
            )}
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <a
            href={fullUrl || undefined}
            target="_blank"
            rel="noreferrer"
            title="Open booking page"
            aria-label="Open booking page"
            onClick={(e) => { if (!fullUrl) e.preventDefault(); }}
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-surface px-2.5 text-ink-muted transition-all duration-[160ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              fullUrl
                ? "hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-soft"
                : "cursor-not-allowed opacity-50",
            )}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          </a>
        </div>
      </div>

      {/* Pointer to full share panel */}
      <p className="text-[11px] leading-relaxed text-ink-subtle">
        For staff-pinned URLs (one link per teammate) and the embed scaffold,
        open the <Share2 className="inline-block h-3 w-3 align-[-0.15em]" strokeWidth={1.75} /> share panel on the service card.
      </p>
    </div>
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

