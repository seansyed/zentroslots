"use client";

import * as React from "react";
import Link from "next/link";
import {
  Building2,
  MapPin,
  Globe,
  Video,
  Phone,
  Mail,
  Users,
  Layers,
  CalendarRange,
  Upload,
  Trash2,
  Pencil,
  Plus,
  X,
  AlertTriangle,
  Eye,
  ArrowUpRight,
  Sparkles,
  Workflow,
  MapPinned,
  Repeat,
} from "lucide-react";

import {
  Avatar,
  Button,
  Drawer,
  Skeleton,
  toast,
} from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import TimezonePicker from "@/components/ui/TimezonePicker";

// ─── LocationsClient (filename: LocationsManager.tsx — kept to
// avoid breaking imports) — Phase 15A premium operational delivery
// hubs.
//
// Behavior at a glance:
//   • Read-anyone, write-admin/manager (parent passes `isAdmin`).
//   • Plan-aware create CTA: Free shows premium upgrade banner.
//   • Existing locations are NEVER hidden when plan changes — only
//     creating NEW ones is gated.
//   • Premium drawer for create + edit (replaces the inline form).
//   • Logo upload uses the same multipart contract as staff avatars.

type LocationType = "physical" | "virtual" | "hybrid";

// Booking visibility — UI scaffold per IMPORTANT ADDITION #1.
// Not persisted yet; UI surface is reserved for routing intelligence
// once the backend route lands. Three calm modes:
//   • publicly_bookable — appears on public booking pages
//   • internal — admin-only / staff-only bookings
//   • routing_hub — used as a routing-only endpoint
type BookingVisibility = "publicly_bookable" | "internal" | "routing_hub";

type Loc = {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  locationType: LocationType;
  logoUrl: string | null;
  notes: string | null;
  staffCount: number;
  serviceCount: number;
  bookingsLast30d: number;
};

type Plan = { id: string; name: string; maxLocations: number };

const TYPE_META: Record<
  LocationType,
  { label: string; icon: typeof Building2; description: string }
> = {
  physical: { label: "Physical", icon: MapPin, description: "In-person delivery at a specific address." },
  virtual:  { label: "Virtual",  icon: Video,  description: "Online-only delivery hub (Meet, Zoom, Teams, etc.)." },
  hybrid:   { label: "Hybrid",   icon: Globe,  description: "Both in-person and virtual delivery from the same hub." },
};

// ─── Top-level client ─────────────────────────────────────────────

export default function LocationsManager({
  initial,
  isAdmin,
  defaultTimezone,
  plan,
}: {
  initial: Loc[];
  isAdmin: boolean;
  defaultTimezone: string;
  plan: Plan;
}) {
  const [rows, setRows] = React.useState<Loc[]>(initial);
  const [openId, setOpenId] = React.useState<string | "new" | null>(null);

  async function reload() {
    try {
      const r = await fetch("/api/locations");
      const d = await r.json();
      if (Array.isArray(d)) setRows(d);
    } catch {
      // ignore — UI keeps last good state
    }
  }

  const isUnlimited = plan.maxLocations < 0;
  const activeCount = rows.filter((r) => r.isActive).length;
  const atCapacity = !isUnlimited && activeCount >= plan.maxLocations;
  const planAllowsLocations = plan.maxLocations !== 0;
  const canCreate = isAdmin && planAllowsLocations && !atCapacity;

  const counts = React.useMemo(() => {
    const physical = rows.filter((r) => r.locationType === "physical" && r.isActive).length;
    const virtual = rows.filter((r) => r.locationType === "virtual" && r.isActive).length;
    const hybrid = rows.filter((r) => r.locationType === "hybrid" && r.isActive).length;
    const inactive = rows.filter((r) => !r.isActive).length;
    // Honest operational signals (Phase 15B refinement #1).
    // Every chip below derives from a real column — no fabricated
    // metrics. "Routing active" means at least one booking has been
    // routed to a location in the last 30 days.
    const staffed = rows.filter((r) => r.isActive && r.staffCount > 0).length;
    const totalCoverage = rows
      .filter((r) => r.isActive)
      .reduce((sum, r) => sum + r.staffCount, 0);
    const bookings30d = rows
      .filter((r) => r.isActive)
      .reduce((sum, r) => sum + r.bookingsLast30d, 0);
    const routingActive = bookings30d > 0;
    return {
      physical, virtual, hybrid, inactive,
      total: rows.length, active: activeCount,
      staffed, totalCoverage, bookings30d, routingActive,
    };
  }, [rows, activeCount]);

  return (
    <div className="mt-4 space-y-5">
      {/* Hero — refinement #1 (Phase 15C).
          Layered depth: ultra-soft operational gradient wash + a
          faint topology dot pattern + radial glow halo behind the
          chips. Richer vertical breathing (p-6 vs p-5). Every layer
          is pointer-events-none so the interactive surface remains
          unaffected. */}
      <PremiumCard className="relative overflow-hidden p-6">
        {/* Ultra-soft operational gradient wash */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(53,157,243,0.04)_0%,rgba(255,255,255,0)_55%,rgba(124,58,237,0.04)_100%)]"
        />
        {/* Subtle topology — dotted background, extremely low opacity */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.045]"
          style={{
            backgroundImage:
              "radial-gradient(circle, currentColor 1px, transparent 1px)",
            backgroundSize: "18px 18px",
            color: "rgb(15 23 42)",
          }}
        />
        {/* Ambient glows */}
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-16 -bottom-16 h-48 w-48 rounded-full bg-violet-200/20 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
              Operational delivery hubs
            </div>
            <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">
              Locations
            </h1>
            <p className="mt-1.5 max-w-xl text-[12.5px] leading-relaxed text-ink-muted">
              Offices, virtual delivery hubs, and operational service regions. Each location can hold
              staff, services, and customer bookings.
            </p>
          </div>
          {/* Chip cluster sits over a faint radial glow halo — gives
              the metrics card-like presence without a hard border. */}
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute -inset-3 rounded-2xl bg-[radial-gradient(circle_at_50%_50%,rgba(53,157,243,0.06)_0%,rgba(53,157,243,0)_70%)]"
            />
            <div className="relative flex max-w-full flex-wrap items-center gap-1.5">
              <CountChip icon={Building2} label={`${counts.active} ${counts.active === 1 ? "active hub" : "active hubs"}`} tone="brand" />
              {counts.staffed > 0 && (
                <CountChip icon={Users} label={`${counts.staffed} staffed`} tone="emerald" />
              )}
              {counts.totalCoverage > 0 && (
                <CountChip icon={Layers} label={`${counts.totalCoverage} ${counts.totalCoverage === 1 ? "team member" : "team members"}`} tone="neutral" />
              )}
              <RoutingStatusChip active={counts.routingActive} bookings30d={counts.bookings30d} />
              {counts.physical > 0 && <CountChip icon={MapPin} label={`${counts.physical} physical`} tone="neutral" />}
              {counts.virtual > 0 && <CountChip icon={Video} label={`${counts.virtual} virtual`} tone="violet" />}
              {counts.hybrid > 0 && <CountChip icon={Globe} label={`${counts.hybrid} hybrid`} tone="emerald" />}
              {counts.inactive > 0 && <CountChip icon={X} label={`${counts.inactive} archived`} tone="muted" />}
              <PlanChip plan={plan} activeCount={activeCount} />
            </div>
          </div>
        </div>
        {/* Operational tagline */}
        <p className="relative mt-4 border-t border-border/30 pt-3 text-[11.5px] italic text-ink-subtle">
          Locations route bookings, anchor staff coverage, and shape regional scheduling intelligence.
        </p>
      </PremiumCard>

      {/* Plan-gated banner */}
      {!planAllowsLocations && (
        <PremiumCard className="relative overflow-hidden p-4">
          <span aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-amber-200/30 blur-3xl" />
          <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100/70 text-amber-800 ring-1 ring-amber-200/40">
                <Sparkles className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-800">
                  Available on paid plans
                </div>
                <h2 className="mt-0.5 text-[14.5px] font-semibold tracking-tight text-ink">
                  Locations are available on paid plans
                </h2>
                <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink-muted">
                  Create multiple offices, virtual delivery hubs, and operational service regions.
                  Route bookings by location, brand each hub independently, and prepare for regional
                  scheduling intelligence.
                </p>
              </div>
            </div>
            <Link
              href="/dashboard/billing"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-[0_1px_3px_rgba(15,23,42,0.10)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
            >
              Upgrade plan
              <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
            </Link>
          </div>
        </PremiumCard>
      )}

      {/* Toolbar */}
      {rows.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] text-ink-subtle">
            {counts.active} {counts.active === 1 ? "location" : "locations"} ready for routing.
          </div>
          {isAdmin && (
            <Button
              onClick={() => setOpenId("new")}
              size="sm"
              disabled={!canCreate}
              title={
                !planAllowsLocations
                  ? "Available on paid plans"
                  : atCapacity
                    ? `Plan cap reached (${activeCount}/${plan.maxLocations})`
                    : undefined
              }
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
              Add location
            </Button>
          )}
        </div>
      )}

      {/* Grid or empty state */}
      {rows.length === 0 ? (
        <EmptyState
          canCreate={canCreate}
          planAllowsLocations={planAllowsLocations}
          onCreate={() => setOpenId("new")}
        />
      ) : (
        <FadeIn>
          <ul
            className={cn(
              "grid grid-cols-1 gap-3",
              rows.length >= 3 ? "sm:grid-cols-2 xl:grid-cols-3" : rows.length === 2 ? "lg:grid-cols-2" : "",
            )}
          >
            {rows.map((loc, i) => (
              <li
                key={loc.id}
                style={{ animation: `zm-row-in 0.42s cubic-bezier(0.16,1,0.3,1) ${Math.min(i, 8) * 50}ms both` }}
              >
                <LocationCard loc={loc} canEdit={isAdmin} onOpen={() => setOpenId(loc.id)} />
              </li>
            ))}
          </ul>
        </FadeIn>
      )}

      {/* Architectural roadmap — refinements #4 + #5 + #7.
          Softer surface gradient, ambient corner glows, dotted
          divider above the grid for blueprint feel. */}
      <PremiumCard className="relative overflow-hidden bg-[linear-gradient(180deg,rgba(255,255,255,1)_0%,rgba(248,250,252,0.6)_100%)] p-6">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-violet-200/15 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-12 -bottom-12 h-40 w-40 rounded-full bg-brand-accent/8 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/65 to-transparent" />

        <div className="relative flex items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
              Architectural roadmap
            </div>
            <h3 className="mt-1 text-[15px] font-semibold tracking-tight text-ink">
              Routing intelligence on top of locations
            </h3>
            <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
              Each capability layers cleanly on the existing per-location foundation — no engine
              rewrites, no schema churn. Order reflects the natural delivery sequence.
            </p>
          </div>
        </div>

        {/* Dotted section divider — visual grouping refinement */}
        <div className="relative mt-5">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[radial-gradient(circle,theme(colors.border)_1px,transparent_1px)] bg-[length:8px_1px] bg-repeat-x opacity-60"
          />
        </div>

        <div className="relative mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ScaffoldTile icon={MapPinned} title="Nearest-location booking" caption="Route customers to their closest physical hub." />
          <ScaffoldTile icon={Workflow} title="Regional routing" caption="Service-area + ZIP / country mapping rules." />
          <ScaffoldTile icon={Globe} title="Timezone-aware hubs" caption="Match customers to the hub in their local hours." />
          <ScaffoldTile icon={Layers} title="Room scheduling" caption="Per-location resources and rooms with their own availability." />
          <ScaffoldTile icon={Repeat} title="Multi-office scheduling" caption="One booking spans staff from multiple locations." />
          <ScaffoldTile icon={Building2} title="Location branding" caption="Per-hub colors, logos, and booking-page identity." />
        </div>
      </PremiumCard>

      <LocationDrawer
        openId={openId}
        onClose={() => setOpenId(null)}
        onSaved={() => { setOpenId(null); reload(); }}
        existing={rows}
        defaultTimezone={defaultTimezone}
        canEdit={isAdmin}
        canCreate={canCreate}
        planAllowsLocations={planAllowsLocations}
      />
    </div>
  );
}

// ─── Hero chips ───────────────────────────────────────────────────

function CountChip({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof Building2;
  label: string;
  tone: "brand" | "neutral" | "violet" | "emerald" | "muted";
}) {
  const cls =
    tone === "brand"   ? "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15" :
    tone === "violet"  ? "bg-violet-50/80 text-violet-700 ring-violet-300/40" :
    tone === "emerald" ? "bg-emerald-50/80 text-emerald-700 ring-emerald-300/40" :
    tone === "muted"   ? "bg-surface-inset text-ink-subtle ring-border/40" :
                         "bg-surface text-ink-muted ring-border/60";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", cls)}>
      <Icon className="h-3 w-3" strokeWidth={2} />
      {label}
    </span>
  );
}

// Routing status chip — honest derivation from bookings.locationId
// volume in the last 30 days. When zero, surfaces the "inactive"
// state calmly (not as a warning) so the operator immediately sees
// whether location-aware routing is in flight.
function RoutingStatusChip({
  active,
  bookings30d,
}: {
  active: boolean;
  bookings30d: number;
}) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50/80 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 ring-1 ring-emerald-300/40">
        <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        Routing {bookings30d} · 30d
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-inset px-2 py-0.5 text-[10.5px] font-medium text-ink-subtle ring-1 ring-border/40">
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-ink-subtle/40" />
      Booking routing inactive
    </span>
  );
}

function PlanChip({ plan, activeCount }: { plan: Plan; activeCount: number }) {
  const isUnlimited = plan.maxLocations < 0;
  const isZero = plan.maxLocations === 0;
  if (isUnlimited) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50/80 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-emerald-700 ring-1 ring-emerald-300/40">
        {plan.name} · unlimited
      </span>
    );
  }
  if (isZero) {
    // Refinement #2: this is upgrade CONTEXT, not a warning state.
    // Softer amber, smaller weight, less saturation. Lowercase
    // "upgrade required" rather than uppercase shout.
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50/40 px-2 py-0.5 text-[10px] font-medium text-amber-700/85 ring-1 ring-amber-200/30">
        <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-amber-400/70" />
        {plan.name} · upgrade required
      </span>
    );
  }
  const atCap = activeCount >= plan.maxLocations;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ring-1",
        atCap
          ? "bg-amber-50/60 text-amber-700/90 ring-amber-200/35"
          : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15",
      )}
    >
      {plan.name} · {activeCount}/{plan.maxLocations}
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────

function EmptyState({
  canCreate,
  planAllowsLocations,
  onCreate,
}: {
  canCreate: boolean;
  planAllowsLocations: boolean;
  onCreate: () => void;
}) {
  return (
    <PremiumCard className="relative overflow-hidden p-8">
      {/* Ambient corner glows — refinement #3 */}
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-violet-200/30 blur-3xl" />
      <div className="relative mx-auto max-w-xl text-center">
        {/* Center icon — refinement #3.
            Soft radial halo behind the medallion gives it operational
            warmth. Slightly larger (h-14 vs h-12) and ringed in
            brand-accent for stronger presence. */}
        <div className="relative mx-auto inline-flex h-14 w-14 items-center justify-center">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -m-3 rounded-full bg-[radial-gradient(circle_at_50%_50%,rgba(53,157,243,0.18)_0%,rgba(53,157,243,0)_70%)]"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-pulse rounded-2xl bg-brand-accent/8 blur-md"
          />
          <span className="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-subtle to-brand-subtle/50 text-brand-accent shadow-[0_4px_18px_rgba(53,157,243,0.18)] ring-1 ring-brand-accent/25">
            <Building2 className="h-6 w-6" strokeWidth={1.75} />
          </span>
        </div>
        <h2 className="mt-4 text-[18px] font-semibold tracking-tight text-ink">
          Create your first operational location
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          Locations are the operational delivery hubs your workspace runs through — physical
          offices, virtual delivery hubs, or hybrid regions. They power booking routing,
          per-region branding, and service distribution.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
          <EmptyTile icon={MapPin} title="Offices" caption="Physical addresses where customers meet your team." tone="brand" />
          <EmptyTile icon={Video} title="Virtual hubs" caption="Online-only delivery via Meet, Zoom, or Teams." tone="violet" />
          <EmptyTile icon={Globe} title="Service regions" caption="Hybrid operations spanning multiple modes." tone="emerald" />
        </div>
        {canCreate ? (
          <div className="mt-5">
            <Button onClick={onCreate} size="md">
              <Plus className="mr-1.5 h-4 w-4" strokeWidth={2} />
              Add your first location
            </Button>
          </div>
        ) : !planAllowsLocations ? (
          /* Softer, SECONDARY upgrade CTA (refinement #2).
             The primary upgrade button lives in the banner above —
             we don't repeat the same visual weight twice on one
             page. Here we render a calm text link with the same
             destination, sized down to "supporting context". */
          <div className="mt-5">
            <Link
              href="/dashboard/billing"
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-accent transition-opacity duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:opacity-80"
            >
              See plans that include locations
              <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
            </Link>
          </div>
        ) : (
          <p className="mt-5 text-[11.5px] text-ink-subtle">
            Read-only. Admins and managers can add locations.
          </p>
        )}
      </div>
    </PremiumCard>
  );
}

// EmptyTile — refinement #4 (Phase 15C).
// Each onboarding tile feels like an intelligent operational module:
//   • Richer icon container — gradient + softer tone backdrop +
//     larger iconography (h-10 medallion, h-5 icon)
//   • Tonal background wash visible at rest, deepens on hover
//   • Soft operational shadow at rest, lifts on hover
//   • Full-card hover lift + tone-tinted border
function EmptyTile({
  icon: Icon,
  title,
  caption,
  tone,
}: {
  icon: typeof Building2;
  title: string;
  caption: string;
  tone: "brand" | "violet" | "emerald";
}) {
  const cfg =
    tone === "violet"
      ? {
          glow: "bg-violet-300/35",
          iconBg: "bg-gradient-to-br from-violet-50 to-violet-100/70",
          iconRing: "ring-violet-200/60",
          iconText: "text-violet-700",
          wash: "from-violet-50/40",
          border: "hover:border-violet-300/50",
          shadow: "shadow-[0_2px_8px_rgba(124,58,237,0.06)]",
        }
      : tone === "emerald"
        ? {
            glow: "bg-emerald-300/35",
            iconBg: "bg-gradient-to-br from-emerald-50 to-emerald-100/70",
            iconRing: "ring-emerald-200/60",
            iconText: "text-emerald-700",
            wash: "from-emerald-50/40",
            border: "hover:border-emerald-300/50",
            shadow: "shadow-[0_2px_8px_rgba(16,185,129,0.06)]",
          }
        : {
            glow: "bg-brand-accent/30",
            iconBg: "bg-gradient-to-br from-brand-subtle to-brand-subtle/50",
            iconRing: "ring-brand-accent/25",
            iconText: "text-brand-accent",
            wash: "from-brand-subtle/30",
            border: "hover:border-brand-accent/40",
            shadow: "shadow-[0_2px_8px_rgba(53,157,243,0.07)]",
          };
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-0.5 hover:shadow-lift",
        cfg.border,
        cfg.shadow,
      )}
    >
      {/* Tonal wash at rest — extremely soft */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 opacity-50 transition-opacity duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100",
          "bg-gradient-to-br to-transparent",
          cfg.wash,
        )}
      />
      {/* Hover glow */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-8 -top-8 h-20 w-20 rounded-full opacity-0 blur-2xl transition-opacity duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100",
          cfg.glow,
        )}
      />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/65 to-transparent" />
      <div className="relative flex items-start gap-3">
        <div
          className={cn(
            "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.04]",
            cfg.iconBg,
            cfg.iconRing,
            cfg.iconText,
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{caption}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Location card ────────────────────────────────────────────────

function LocationCard({
  loc,
  canEdit,
  onOpen,
}: {
  loc: Loc;
  canEdit: boolean;
  onOpen: () => void;
}) {
  const typeMeta = TYPE_META[loc.locationType];
  const TypeIcon = typeMeta.icon;
  const inactive = !loc.isActive;

  const bookingReady = loc.serviceCount > 0 && loc.staffCount > 0 && loc.isActive;
  const limitedCoverage = loc.staffCount < 2 && loc.isActive;

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-surface shadow-soft transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        inactive
          ? "border-border opacity-80 hover:opacity-100"
          : "border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      {/* Subtle ambient glow on hover — refinement #9 motion polish.
          Brand-tinted, almost invisible at rest, lifts the card into
          a calm operational glow on hover. */}
      {!inactive && (
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/0 blur-3xl transition-colors duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:bg-brand-accent/15" />
      )}
      <button
        type="button"
        onClick={onOpen}
        disabled={!canEdit}
        className="relative block w-full text-left p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40"
        aria-label={`Open ${loc.name}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={loc.name} src={loc.logoUrl ?? null} size="lg" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink">{loc.name}</h3>
                {inactive && (
                  <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                    Archived
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                <TypeIcon className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
                <span>{typeMeta.label}</span>
                {loc.timezone && (
                  <>
                    <span className="text-ink-subtle/60">·</span>
                    <span className="tabular-nums">{loc.timezone}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {loc.address && (
          <div className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-muted">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-ink-subtle" strokeWidth={2} />
            <span className="line-clamp-2">{loc.address}</span>
          </div>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2 text-[11.5px]">
          <Counter icon={Users} value={loc.staffCount} label="Staff" />
          <Counter icon={Layers} value={loc.serviceCount} label="Services" />
          <Counter icon={CalendarRange} value={loc.bookingsLast30d} label="30d bookings" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {!loc.isActive ? (
            <StateChip label="Inactive" tone="muted" />
          ) : (
            <>
              <StateChip label="Active" tone="positive" />
              {loc.locationType === "virtual" && <StateChip label="Virtual only" tone="violet" />}
              {loc.locationType === "hybrid" && <StateChip label="Hybrid" tone="emerald" />}
              {bookingReady && <StateChip label="Booking-ready" tone="brand" />}
              {limitedCoverage && <StateChip label="Limited coverage" tone="warning" />}
            </>
          )}
        </div>

        {/* Quick contact line */}
        {(loc.phone || loc.email) && (
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/60 pt-2 text-[11px] text-ink-subtle">
            {loc.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="h-3 w-3" strokeWidth={2} />
                {loc.phone}
              </span>
            )}
            {loc.email && (
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" strokeWidth={2} />
                {loc.email}
              </span>
            )}
          </div>
        )}
      </button>
    </article>
  );
}

function Counter({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Users;
  value: number;
  label: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
        <span className="tabular-nums text-[13px] font-semibold text-ink">{value}</span>
      </div>
      <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.06em] text-ink-subtle">{label}</div>
    </div>
  );
}

function StateChip({
  label,
  tone,
}: {
  label: string;
  tone: "brand" | "positive" | "warning" | "violet" | "emerald" | "muted";
}) {
  const cls =
    tone === "brand"    ? "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15" :
    tone === "positive" ? "bg-emerald-50/80 text-emerald-700 ring-emerald-300/40" :
    tone === "warning"  ? "bg-amber-50/80 text-amber-800 ring-amber-200/40" :
    tone === "violet"   ? "bg-violet-50/80 text-violet-700 ring-violet-300/40" :
    tone === "emerald"  ? "bg-emerald-50/80 text-emerald-700 ring-emerald-300/40" :
                          "bg-surface-inset text-ink-subtle ring-border/50";
  return (
    <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ring-1", cls)}>
      {label}
    </span>
  );
}

// ScaffoldTile — refinements #5 + #6 (Phase 15C).
// "Future operational blueprint" feel. Softer border at rest
// (border/30), nearly invisible until hover. Background contrast
// comes from a subtle ambient gradient rather than a hard border.
// "Planned" microcopy demoted to a smaller, lighter sentence-case
// modifier so the title always dominates the row.
function ScaffoldTile({
  icon: Icon,
  title,
  caption,
}: {
  icon: typeof Workflow;
  title: string;
  caption: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/30 bg-[linear-gradient(135deg,rgba(255,255,255,0.6)_0%,rgba(241,245,249,0.4)_100%)] p-3.5 backdrop-blur-[1px] transition-all duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-[2px] hover:border-border/70 hover:shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
      {/* Dotted top edge — blueprint texture, calmer than dashed. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-3 top-0 h-px bg-[radial-gradient(circle,theme(colors.border)_1px,transparent_1px)] bg-[length:6px_1px] bg-repeat-x opacity-50 transition-opacity duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-90" />
      {/* Hover ambient — warmer brand tint */}
      <span aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-20 w-20 rounded-full bg-brand-accent/0 blur-2xl transition-colors duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:bg-brand-accent/12" />
      <div className="relative flex items-start gap-2.5">
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/70 text-ink-subtle ring-1 ring-border/40 transition-all duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:bg-brand-subtle/60 group-hover:text-brand-accent group-hover:ring-brand-accent/20 group-hover:shadow-[0_1px_3px_rgba(53,157,243,0.10)]">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <h4 className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</h4>
            {/* Demoted "Planned" microcopy — refinement #6.
                Smaller, lighter, lowercase-ish weight so the title
                always reads first. */}
            <span className="text-[9px] font-medium tracking-wide text-ink-subtle/55">
              planned
            </span>
          </div>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{caption}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Drawer (create + edit) ───────────────────────────────────────

function LocationDrawer({
  openId,
  onClose,
  onSaved,
  existing,
  defaultTimezone,
  canEdit,
  canCreate,
  planAllowsLocations,
}: {
  openId: string | "new" | null;
  onClose: () => void;
  onSaved: () => void;
  existing: Loc[];
  defaultTimezone: string;
  canEdit: boolean;
  canCreate: boolean;
  planAllowsLocations: boolean;
}) {
  const isNew = openId === "new";
  const loc = openId && openId !== "new" ? existing.find((l) => l.id === openId) : null;

  const [name, setName] = React.useState("");
  const [locationType, setLocationType] = React.useState<LocationType>("physical");
  const [timezone, setTimezone] = React.useState<string | null>(defaultTimezone);
  const [address, setAddress] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [isActive, setIsActive] = React.useState(true);
  const [logoUrl, setLogoUrl] = React.useState<string | null>(null);
  const [visibility, setVisibility] = React.useState<BookingVisibility>("publicly_bookable");
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (loc) {
      setName(loc.name);
      setLocationType(loc.locationType);
      setTimezone(loc.timezone);
      setAddress(loc.address ?? "");
      setPhone(loc.phone ?? "");
      setEmail(loc.email ?? "");
      setNotes(loc.notes ?? "");
      setIsActive(loc.isActive);
      setLogoUrl(loc.logoUrl);
      setVisibility("publicly_bookable");
    } else if (isNew) {
      setName("");
      setLocationType("physical");
      setTimezone(defaultTimezone);
      setAddress("");
      setPhone("");
      setEmail("");
      setNotes("");
      setIsActive(true);
      setLogoUrl(null);
      setVisibility("publicly_bookable");
    }
  }, [openId, loc, isNew, defaultTimezone]);

  async function uploadLogo(file: File) {
    if (!canEdit || !loc) return;
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
      const r = await fetch(`/api/locations/${loc.id}/logo`, { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Upload failed");
      setLogoUrl(d.logoUrl);
      toast("Logo updated", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function removeLogo() {
    if (!canEdit || !loc || !logoUrl) return;
    setUploading(true);
    try {
      const r = await fetch(`/api/locations/${loc.id}/logo`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      setLogoUrl(null);
      toast("Logo removed", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      toast("Name is required", "error");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        locationType,
        timezone: timezone || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        ...(isNew ? {} : { isActive }),
      };
      const url = isNew ? "/api/locations" : `/api/locations/${loc!.id}`;
      const method = isNew ? "POST" : "PATCH";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Save failed");
      toast(isNew ? "Location created" : "Location updated", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!loc) return;
    if (!window.confirm("Archive this location? Past bookings keep their reference; new bookings can't choose it until you reactivate.")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/locations/${loc.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      toast(d?.deleted ? "Location deleted" : "Location archived", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) uploadLogo(f);
    e.target.value = "";
  }

  const open = Boolean(openId);
  const readOnly = isNew && !canCreate;
  const lockedReason = !planAllowsLocations ? "Locations are available on paid plans" : null;

  return (
    <Drawer open={open} onClose={onClose} side="right" size="lg" ariaLabel="Location editor">
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-brand-subtle/30 via-surface to-surface p-5">
          <div aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <Avatar name={name || "New location"} src={logoUrl} size="lg" />
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                  {isNew ? "New location" : "Edit location"}
                </div>
                <h2 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">
                  {isNew ? "Create operational hub" : (loc?.name ?? "")}
                </h2>
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
          {readOnly && lockedReason && (
            <div className="rounded-lg border border-amber-300/50 bg-amber-50/40 px-3 py-2.5 text-[12px] text-amber-900">
              <AlertTriangle className="mr-1 inline-block h-3.5 w-3.5" strokeWidth={2} />
              {lockedReason}. Upgrade your plan to create operational hubs.
            </div>
          )}

          {/* Logo zone — only for existing rows. New locations must
              save first so the upload endpoint has a row to target. */}
          {!isNew && loc && (
            <PremiumCard className="p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Identity</div>
              <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Location logo</h3>
              <div className="mt-3 flex items-center gap-4">
                <Avatar name={name} src={logoUrl} size="xl" />
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
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
                    {logoUrl ? "Replace" : "Upload"}
                  </Button>
                  {logoUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={removeLogo}
                      disabled={!canEdit || uploading}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                      Remove
                    </Button>
                  )}
                  <span className="text-[10.5px] text-ink-subtle">JPG, PNG, or WebP · Max 2 MB</span>
                </div>
              </div>
            </PremiumCard>
          )}

          {/* Core identity */}
          <PremiumCard className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Operational identity</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Name + type</h3>
            <div className="mt-3 space-y-3">
              <div>
                <label className="text-[11px] font-semibold text-ink-muted">Location name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canEdit || readOnly}
                  maxLength={120}
                  placeholder="e.g. Downtown Office"
                  className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-ink-muted">Type</label>
                <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(Object.keys(TYPE_META) as LocationType[]).map((t) => {
                    const meta = TYPE_META[t];
                    const Icon = meta.icon;
                    const on = locationType === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        disabled={!canEdit || readOnly}
                        onClick={() => setLocationType(t)}
                        className={cn(
                          "group flex items-start gap-2 rounded-lg border p-2.5 text-left transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                          on
                            ? "border-brand-accent/40 bg-brand-subtle/50 shadow-[0_1px_3px_rgba(15,23,42,0.06)]"
                            : "border-border bg-surface hover:border-border-strong",
                          (!canEdit || readOnly) && "opacity-60",
                        )}
                      >
                        <div className={cn(
                          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1",
                          on ? "bg-brand-accent text-white ring-brand-accent/40" : "bg-surface-inset text-ink-subtle ring-border/40",
                        )}>
                          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[12.5px] font-semibold tracking-tight text-ink">{meta.label}</div>
                          <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{meta.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-ink-muted">Primary timezone</label>
                <div className="mt-1">
                  <TimezonePicker
                    value={timezone}
                    onChange={setTimezone}
                    disabled={!canEdit || readOnly}
                  />
                </div>
                <span className="mt-1 block text-[10.5px] text-ink-subtle">
                  Used for regional booking intelligence and per-hub scheduling display.
                </span>
              </div>
            </div>
          </PremiumCard>

          {/* Contact */}
          <PremiumCard className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Contact</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Public contact details</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {locationType !== "virtual" && (
                <label className="block sm:col-span-2">
                  <span className="text-[11px] font-semibold text-ink-muted">Address</span>
                  <textarea
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    disabled={!canEdit || readOnly}
                    rows={2}
                    maxLength={500}
                    placeholder="123 Main Street, Suite 200, San Francisco, CA 94105"
                    className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
                  />
                </label>
              )}
              <label className="block">
                <span className="text-[11px] font-semibold text-ink-muted">
                  <Phone className="mr-1 inline-block h-3 w-3" strokeWidth={2} /> Phone
                </span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={!canEdit || readOnly}
                  maxLength={40}
                  placeholder="+1 (555) 010-4242"
                  className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
                />
              </label>
              <label className="block">
                <span className="text-[11px] font-semibold text-ink-muted">
                  <Mail className="mr-1 inline-block h-3 w-3" strokeWidth={2} /> Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!canEdit || readOnly}
                  maxLength={255}
                  placeholder="hello@example.com"
                  className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
                />
              </label>
            </div>
          </PremiumCard>

          {/* Booking visibility — UI scaffold (no backend yet) */}
          <PremiumCard className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                  Booking visibility
                </div>
                <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">How this hub appears in routing</h3>
                <p className="mt-1 text-[11.5px] text-ink-muted">
                  UI scaffold — the routing intelligence layer reads this once it ships. Saved
                  selection has no operational effect today.
                </p>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                Coming soon
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <VisibilityTile
                on={visibility === "publicly_bookable"}
                onChange={() => setVisibility("publicly_bookable")}
                disabled={!canEdit || readOnly}
                icon={Eye}
                title="Publicly bookable"
                caption="Appears on public booking pages."
              />
              <VisibilityTile
                on={visibility === "internal"}
                onChange={() => setVisibility("internal")}
                disabled={!canEdit || readOnly}
                icon={Building2}
                title="Internal only"
                caption="Staff-only / admin bookings."
              />
              <VisibilityTile
                on={visibility === "routing_hub"}
                onChange={() => setVisibility("routing_hub")}
                disabled={!canEdit || readOnly}
                icon={Workflow}
                title="Routing hub"
                caption="Routing-only endpoint, never shown directly."
              />
            </div>
          </PremiumCard>

          {/* Operational notes — admin-only, never public */}
          <PremiumCard className="p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Operational metadata</div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Internal notes</h3>
            <p className="mt-1 text-[11.5px] text-ink-muted">
              Admin-only. Never shown on public booking pages or customer-facing surfaces.
            </p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canEdit || readOnly}
              rows={3}
              maxLength={2000}
              placeholder="Parking notes, security protocols, opening procedures…"
              className="mt-3 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed disabled:bg-surface-inset"
            />
          </PremiumCard>

          {/* Active toggle — edit mode only */}
          {!isNew && (
            <PremiumCard className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Status</div>
                  <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
                    {isActive ? "Active" : "Archived"}
                  </h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    Archived locations stay attached to their historical bookings but can&rsquo;t be
                    selected for new ones.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isActive}
                  onClick={() => canEdit && setIsActive(!isActive)}
                  disabled={!canEdit}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                    isActive ? "bg-brand-accent" : "bg-surface-inset ring-1 ring-border",
                    !canEdit && "opacity-50",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "inline-block h-4 w-4 transform rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.20)] transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                      isActive ? "translate-x-[18px]" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>
            </PremiumCard>
          )}
        </div>

        {/* Footer */}
        {canEdit && (
          <div className="flex items-center justify-between gap-2 border-t border-border bg-surface/95 p-4 shadow-[0_-10px_24px_rgba(15,23,42,0.06)] backdrop-blur">
            {!isNew && loc ? (
              <Button variant="danger" size="sm" onClick={archive} disabled={busy}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                Archive
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={save} size="sm" disabled={busy || (isNew && !canCreate)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                {busy ? "Saving…" : isNew ? "Create location" : "Save changes"}
              </Button>
            </div>
          </div>
        )}

        {!canEdit && (
          <div className="border-t border-border bg-surface/95 p-4">
            <p className="text-center text-[11.5px] text-ink-subtle">
              Read-only. Admins and managers can edit locations.
            </p>
          </div>
        )}

        {!isNew && !loc && (
          <div className="flex-1 p-5">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="mt-4 h-24 w-full" />
          </div>
        )}
      </div>
    </Drawer>
  );
}

function VisibilityTile({
  on,
  onChange,
  disabled,
  icon: Icon,
  title,
  caption,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  icon: typeof Eye;
  title: string;
  caption: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-2.5 text-left transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        on
          ? "border-brand-accent/40 bg-brand-subtle/50"
          : "border-border bg-surface hover:border-border-strong",
        disabled && "opacity-60",
      )}
    >
      <div className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1",
        on ? "bg-brand-accent text-white ring-brand-accent/40" : "bg-surface-inset text-ink-subtle ring-border/40",
      )}>
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</div>
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{caption}</p>
      </div>
    </button>
  );
}
