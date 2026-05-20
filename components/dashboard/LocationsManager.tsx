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
    return { physical, virtual, hybrid, inactive, total: rows.length, active: activeCount };
  }, [rows, activeCount]);

  return (
    <div className="mt-4 space-y-5">
      {/* Hero */}
      <PremiumCard className="relative overflow-hidden p-5">
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Operational delivery hubs
            </div>
            <h1 className="mt-0.5 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
              Locations
            </h1>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-ink-muted">
              Offices, virtual delivery hubs, and operational service regions. Each location can hold
              staff, services, and customer bookings.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <CountChip icon={Building2} label={`${counts.active} active`} tone="brand" />
            {counts.physical > 0 && <CountChip icon={MapPin} label={`${counts.physical} physical`} tone="neutral" />}
            {counts.virtual > 0 && <CountChip icon={Video} label={`${counts.virtual} virtual`} tone="violet" />}
            {counts.hybrid > 0 && <CountChip icon={Globe} label={`${counts.hybrid} hybrid`} tone="emerald" />}
            {counts.inactive > 0 && <CountChip icon={X} label={`${counts.inactive} archived`} tone="muted" />}
            <PlanChip plan={plan} activeCount={activeCount} />
          </div>
        </div>
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

      {/* v2 scaffolds */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          v2 routing foundations
        </div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-muted">
          Once locations are in place, the routing engine can layer regional intelligence on top
          without rewriting the slot generator.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50/80 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-amber-800 ring-1 ring-amber-200/40">
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
          ? "bg-amber-50/80 text-amber-800 ring-amber-200/40"
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
    <PremiumCard className="relative overflow-hidden p-6">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-violet-200/30 blur-3xl" />
      <div className="relative mx-auto max-w-xl text-center">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-subtle/70 text-brand-accent shadow-soft ring-1 ring-brand-accent/15">
          <Building2 className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <h2 className="mt-3 text-[18px] font-semibold tracking-tight text-ink">
          Create your first operational location
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
          Locations are the operational delivery hubs your workspace runs through — physical
          offices, virtual delivery hubs, or hybrid regions. They power booking routing,
          per-region branding, and service distribution.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-2 text-left sm:grid-cols-3">
          <EmptyTile icon={MapPin} title="Offices" caption="Physical addresses where customers meet your team." />
          <EmptyTile icon={Video} title="Virtual hubs" caption="Online-only delivery via Meet, Zoom, or Teams." />
          <EmptyTile icon={Globe} title="Service regions" caption="Hybrid operations spanning multiple modes." />
        </div>
        {canCreate ? (
          <div className="mt-5">
            <Button onClick={onCreate} size="md">
              <Plus className="mr-1.5 h-4 w-4" strokeWidth={2} />
              Add your first location
            </Button>
          </div>
        ) : !planAllowsLocations ? (
          <div className="mt-5">
            <Link
              href="/dashboard/billing"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-accent px-4 py-2 text-[12.5px] font-semibold text-white shadow-[0_1px_3px_rgba(15,23,42,0.10)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
            >
              Upgrade to unlock locations
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
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

function EmptyTile({
  icon: Icon,
  title,
  caption,
}: {
  icon: typeof Building2;
  title: string;
  caption: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start gap-2">
        <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div>
          <div className="text-[12px] font-semibold tracking-tight text-ink">{title}</div>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{caption}</p>
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
        "group relative overflow-hidden rounded-2xl border bg-surface shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        inactive
          ? "border-border opacity-80 hover:opacity-100"
          : "border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
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
    <div className="relative overflow-hidden rounded-xl border border-dashed border-border bg-surface-inset/30 p-3">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-2.5">
        <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle ring-1 ring-border/40">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-[12px] font-semibold tracking-tight text-ink">{title}</h4>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
              Soon
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
