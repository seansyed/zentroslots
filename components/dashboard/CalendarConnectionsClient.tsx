"use client";

import * as React from "react";
import Link from "next/link";
import {
  CalendarSync,
  Cable,
  Activity,
  ShieldAlert,
  CheckCircle2,
  AlertCircle,
  CircleSlash,
  Clock,
  Users,
  ChevronRight,
  ExternalLink,
  Search,
  RefreshCw,
  Webhook,
  Wifi,
  WifiOff,
  Repeat,
  Copy,
  Gauge,
  Route,
  FileText,
  Sparkles,
  Trash2,
  Video,
  type LucideIcon,
} from "lucide-react";

import { Avatar, Button, toast } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

// ─── Public types (consumed by page.tsx) ──────────────────────────

export type StaffLite = {
  id: string;
  name: string;
  displayName: string;
  email: string;
  role: "admin" | "manager" | "staff";
  title: string | null;
  avatarUrl: string | null;
  timezone: string;
};

export type ConnectionRow = {
  id: string;
  userId: string;
  provider: string;
  status: "active" | "needs_reconnect" | "disconnected";
  accountEmail: string | null;
  calendarId: string;
  /** Last sync ATTEMPT (any outcome) — denormalized on the row */
  lastSyncedAt: string | null;
  /** Last sync that actually completed with status='ok'. Derived
   *  server-side from calendar_sync_logs (Phase 17B). Stricter
   *  signal than lastSyncedAt — only counts successful operations. */
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Wave C.1 — consecutive non-auth failure counter. Drives the
   *  "degraded" health state independently of lastError (the latter
   *  is cleared on the next success; this counter is only cleared
   *  by an `ok` outcome). */
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
};

/** Honest booking-impact aggregates — Phase 17B refinement #6.
 *  Counts only, no fabricated narrative. Server computes these
 *  by joining service_staff with the healthy-connection set. */
export type BookingImpact = {
  /** Workforce members without a healthy connection */
  disconnectedStaffCount: number;
  /** Services where >=1 assigned staff is uncovered */
  servicesAtRiskCount: number;
  /** Services where 100% of assigned staff is uncovered (blocker) */
  servicesUncoveredCount: number;
};

export type SyncLogRow = {
  id: string;
  connectionId: string | null;
  userId: string | null;
  bookingId: string | null;
  provider: string;
  kind: string;
  status: string;
  errorClass: string | null;
  errorMessage: string | null;
  externalEventId: string | null;
  latencyMs: number | null;
  createdAt: string;
};

export type CalendarKpis = {
  workforceCount: number;
  connectedStaffCount: number;
  healthyCount: number;
  reconnectRequiredCount: number;
  disconnectedCount: number;
  withWarningCount: number;
  errorsLast7d: number;
  syncEventsLast24h: number;
  providerDistribution: Array<{ provider: string; count: number }>;
};

// ─── Provider + status meta ───────────────────────────────────────

function prettyProvider(p: string): string {
  switch (p) {
    case "google":
      return "Google Calendar";
    case "microsoft":  // Wave C — canonical provider id in calendar_connections
    case "outlook":
    case "office365":
      return "Microsoft Outlook";
    case "apple":
      return "iCloud";
    case "teams":
      return "Microsoft Teams";
    case "zoom":
      return "Zoom";
    default:
      return p.charAt(0).toUpperCase() + p.slice(1);
  }
}

function providerConferencing(p: string): string {
  if (p === "google") return "Google Meet";
  if (p === "microsoft" || p === "outlook" || p === "office365") return "Microsoft Teams";
  return "—";
}

/** Soft chip tone for the provider — independent of the brand SVG.
 *  Used on the small provider chips inside the distribution strip
 *  + table row labels where we want a calm wrapper around the icon. */
function providerTone(p: string): string {
  if (p === "google") return "bg-sky-50 text-sky-700 ring-sky-200/60";
  if (p === "microsoft" || p === "outlook" || p === "office365")
    return "bg-indigo-50 text-indigo-700 ring-indigo-200/60";
  if (p === "teams") return "bg-violet-50 text-violet-700 ring-violet-200/60";
  if (p === "zoom") return "bg-sky-50 text-sky-700 ring-sky-200/60";
  if (p === "apple") return "bg-rose-50 text-rose-700 ring-rose-200/60";
  return "bg-surface-inset text-ink-muted ring-border/40";
}

// ─── Provider visual identity (Phase 17B refinement #2) ──────────
//
// Inline brand SVGs let us render every supported provider with
// recognizable visual identity even before connection. Disconnected
// providers render in monochrome ("we know about it, not yet
// integrated") while connected providers paint in brand color.

// Wave C — `microsoft` is the canonical provider id stored in
// calendar_connections.provider. `outlook` is kept as a UI catalog
// entry for visual symmetry; it points to the same connection model
// under the hood.
type ProviderId = "google" | "outlook" | "teams" | "zoom";
type ProviderKind = "calendar" | "conferencing";
type ProviderTone = "color" | "mono";

const PROVIDER_CATALOG: Array<{
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  live: boolean;       // true when our backend can OAuth + sync
  brandColor: string;  // hex used by the icon when rendered "color"
  rationale: string;   // microcopy for tooltips on inactive providers
}> = [
  {
    id: "google",
    name: "Google Calendar",
    kind: "calendar",
    live: true,
    brandColor: "#4285F4",
    rationale: "Two-way sync + Google Meet auto-links.",
  },
  {
    id: "outlook",
    name: "Outlook Calendar",
    kind: "calendar",
    live: true, // Wave C — Microsoft Graph adapter shipped
    brandColor: "#0078D4",
    rationale: "Two-way sync via Microsoft Graph + Teams meeting links.",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    kind: "conferencing",
    live: true, // Wave C — rides on the Outlook connection
    brandColor: "#6264A7",
    rationale: "Auto-created when a service uses the Teams video provider; piggybacks on the staff's Outlook connection.",
  },
  {
    id: "zoom",
    name: "Zoom",
    kind: "conferencing",
    live: false,
    brandColor: "#2D8CFF",
    rationale: "OAuth + meeting auto-create on the roadmap.",
  },
];

function ProviderIcon({
  id,
  tone,
  className,
}: {
  id: ProviderId | string;
  tone: ProviderTone;
  className?: string;
}) {
  // Color resolves from catalog when available; falls back to
  // ink-subtle for unknown providers we still want to render.
  //
  // Wave C — `microsoft` (the DB provider id) is aliased to `outlook`
  // for icon lookup so connection rows persisted with `provider="microsoft"`
  // render the Outlook glyph + Microsoft blue.
  const lookupId = id === "microsoft" ? "outlook" : id;
  const meta = PROVIDER_CATALOG.find((p) => p.id === lookupId);
  const fill = tone === "color" ? meta?.brandColor ?? "#94a3b8" : "#94a3b8";
  const common = { className: cn("inline-block", className), fill };
  switch (lookupId) {
    case "google":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d={
            "M21.6 12.227c0-.668-.06-1.31-.172-1.927H12v3.643h5.4a4.62 4.62 0 01-2.004 3.03v2.515h3.24c1.896-1.748 2.964-4.323 2.964-7.261z"
          } fill={tone === "color" ? "#4285F4" : fill} />
          <path d={
            "M12 22c2.7 0 4.964-.895 6.617-2.412l-3.24-2.514c-.9.604-2.05.964-3.377.964-2.595 0-4.79-1.752-5.575-4.108H3.066v2.583A9.997 9.997 0 0012 22z"
          } fill={tone === "color" ? "#34A853" : fill} />
          <path d={
            "M6.425 13.93A6.014 6.014 0 016.108 12c0-.67.115-1.32.317-1.93V7.487H3.066A9.997 9.997 0 002 12c0 1.614.387 3.142 1.066 4.513l3.36-2.583z"
          } fill={tone === "color" ? "#FBBC05" : fill} />
          <path d={
            "M12 5.962c1.467 0 2.787.504 3.823 1.494l2.866-2.866C16.96 2.99 14.694 2 12 2A9.997 9.997 0 003.066 7.487l3.36 2.583C7.21 7.714 9.405 5.962 12 5.962z"
          } fill={tone === "color" ? "#EA4335" : fill} />
        </svg>
      );
    case "outlook":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M13 4h7a1 1 0 011 1v14a1 1 0 01-1 1h-7V4z" fill={tone === "color" ? "#0078D4" : fill} />
          <path d="M3 5.5l10-1.5v16l-10-1.5v-13z" fill={tone === "color" ? "#106EBE" : fill} />
          <text x="5" y="14.5" fontSize="6" fontWeight="700" fill="#fff" fontFamily="system-ui">O</text>
        </svg>
      );
    case "teams":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <path d="M7 6h10v3H7zM7 9h10v9.5A2.5 2.5 0 0114.5 21h-5A2.5 2.5 0 017 18.5V9z" fill={tone === "color" ? "#6264A7" : fill} />
          <path d="M14 4a3 3 0 11-6 0 3 3 0 016 0z" fill={tone === "color" ? "#6264A7" : fill} opacity="0.85" />
          <path d="M20 9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" fill={tone === "color" ? "#5054A2" : fill} opacity="0.7" />
        </svg>
      );
    case "zoom":
      return (
        <svg viewBox="0 0 24 24" {...common}>
          <rect x="2.5" y="6" width="13.5" height="12" rx="2" fill={tone === "color" ? "#2D8CFF" : fill} />
          <path d="M21.5 7.4v9.2a.6.6 0 01-.95.49L17 14.6v-5.2l3.55-2.49a.6.6 0 01.95.49z" fill={tone === "color" ? "#2D8CFF" : fill} />
        </svg>
      );
    default:
      // Unknown provider — render initial in a soft chip
      return (
        <span className={cn("inline-flex items-center justify-center rounded text-[10px] font-bold text-ink-muted", className)}>
          {String(id).charAt(0).toUpperCase()}
        </span>
      );
  }
}

// Operational health derivation. Honest combination of the
// connection.status + recent lastError + consecutiveFailures signals.
// Never fabricated.
type HealthState = "healthy" | "warning" | "degraded" | "reconnect" | "disconnected" | "error";
function deriveHealth(c: ConnectionRow): {
  state: HealthState;
  label: string;
  tone: string;
  hint?: string;
} {
  if (c.status === "disconnected") {
    return {
      state: "disconnected",
      label: "Disconnected",
      tone: "bg-surface-inset text-ink-subtle ring-border/40",
    };
  }
  if (c.status === "needs_reconnect") {
    // Wave C.1 — provider-specific reconnect copy. Microsoft connections
    // are particularly important because they also produce Teams meeting
    // links; staff need to know that BOTH calendar sync AND Teams
    // generation are paused until they reconnect.
    const providerHint =
      c.provider === "microsoft" || c.provider === "outlook"
        ? "Reconnect Outlook to resume Outlook sync + Teams meeting links."
        : c.provider === "google"
        ? "Reconnect Google Calendar to resume sync + Google Meet links."
        : null;
    return {
      state: "reconnect",
      label: "Reconnect required",
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
      hint: c.lastError ?? providerHint ?? "Token expired or revoked",
    };
  }
  // Wave C.1 — `degraded` (active but >=1 consecutive non-auth failure)
  // is a softer signal than `warning` (lastError still trailing). Both
  // are non-blocking; degraded means "we retried and recovered" while
  // warning means "the last attempt errored." Surface both so admins
  // can spot intermittent Graph/Google issues before they cascade.
  if (c.consecutiveFailures > 0 && !c.lastError) {
    return {
      state: "degraded",
      label: c.consecutiveFailures === 1
        ? "1 transient failure recovered"
        : `${c.consecutiveFailures} transient failures recovered`,
      tone: "bg-sky-50 text-sky-700 ring-sky-200/40",
      hint: "Calendar sync recovered automatically. No action needed.",
    };
  }
  if (c.lastError) {
    // Active but error trailing — sync delayed / provider error.
    return {
      state: "warning",
      label: "Sync issue detected",
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
      hint: c.lastError,
    };
  }
  return {
    state: "healthy",
    label: "Healthy",
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
  };
}

// Token health is a separate signal: are we likely to need a
// reconnect soon? Conservative — we only flip to "expiring" on
// needs_reconnect (a hard signal). The schema doesn't expose
// refresh-token-exp explicitly so we don't fabricate a window.
function deriveTokenHealth(c: ConnectionRow): { label: string; tone: string } {
  if (c.status === "disconnected") return { label: "—", tone: "text-ink-subtle" };
  if (c.status === "needs_reconnect")
    return { label: "Expired", tone: "text-amber-700" };
  if (c.lastError) return { label: "At risk", tone: "text-amber-700" };
  return { label: "Healthy", tone: "text-emerald-700" };
}

// ─── Date helpers ─────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const KIND_LABEL: Record<string, string> = {
  create: "Created event",
  update: "Updated event",
  delete: "Deleted event",
  freebusy: "Read busy time",
  connect: "Connected",
  disconnect: "Disconnected",
};

// ─── Top-level component ──────────────────────────────────────────

export default function CalendarConnectionsClient({
  viewerId,
  viewerRole,
  workforce,
  connections: initialConnections,
  logs: initialLogs,
  kpis,
  bookingImpact,
  flashConnected,
  flashError,
}: {
  viewerId: string;
  viewerRole: "admin" | "manager" | "staff";
  workforce: StaffLite[];
  connections: ConnectionRow[];
  logs: SyncLogRow[];
  kpis: CalendarKpis;
  bookingImpact: BookingImpact;
  flashConnected: string | null;
  flashError: string | null;
}) {
  const [connections, setConnections] = React.useState(initialConnections);
  const [logs, setLogs] = React.useState(initialLogs);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const isAdmin = viewerRole === "admin" || viewerRole === "manager";

  React.useEffect(() => {
    if (flashConnected) toast(`${prettyProvider(flashConnected)} connected`, "success");
    if (flashError) toast(`Connection failed: ${flashError}`, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/tenant/calendar-status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { connections: ConnectionRow[]; logs: SyncLogRow[] };
      setConnections(data.connections);
      setLogs(data.logs);
    } catch {
      // silent
    } finally {
      setRefreshing(false);
    }
  }

  async function forceDisconnect(c: ConnectionRow) {
    const label = c.userName ?? c.userEmail ?? "this staff member";
    if (!confirm(`Force-disconnect ${prettyProvider(c.provider)} for ${label}?\n\nThis is an incident-recovery action. The owner can reconnect from their Staff Profile afterwards.`)) {
      return;
    }
    setBusyId(c.id);
    try {
      const res = await fetch("/api/calendar/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: c.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Disconnect failed");
      toast("Connection terminated", "success");
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  // Compose the per-staff sync table:
  //   • One row per workforce member
  //   • Pull the latest connection if multiple exist for the same
  //     user (sorted by updatedAt desc on the server)
  //   • Staff without a connection get a "Not connected" row
  const tableRows = React.useMemo<TableRow[]>(() => {
    const latestByUser = new Map<string, ConnectionRow>();
    for (const c of connections) {
      if (!latestByUser.has(c.userId)) latestByUser.set(c.userId, c);
    }
    return workforce.map((s) => {
      const c = latestByUser.get(s.id) ?? null;
      return { staff: s, connection: c };
    });
  }, [workforce, connections]);

  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tableRows;
    return tableRows.filter((r) => {
      if (r.staff.displayName.toLowerCase().includes(q)) return true;
      if (r.staff.email.toLowerCase().includes(q)) return true;
      if (r.staff.role.includes(q)) return true;
      if (r.connection) {
        if (r.connection.provider.toLowerCase().includes(q)) return true;
        if ((r.connection.accountEmail ?? "").toLowerCase().includes(q)) return true;
        if (r.connection.status.includes(q)) return true;
      } else if ("awaiting".includes(q) || "unset".includes(q)) {
        return true;
      }
      return false;
    });
  }, [tableRows, query]);

  return (
    <div className="space-y-5 pb-24">
      {/* Hero */}
      <InfraHero isAdmin={isAdmin} viewerName={workforce.find((w) => w.id === viewerId)?.displayName ?? "you"} />

      {/* Architecture banner — explains the ownership model up-front */}
      <OwnershipBanner />

      {/* KPI strip */}
      <KpiStrip kpis={kpis} />

      {/* Supported provider catalog (Phase 17B refinement #2) —
          renders BEFORE distribution so even tenants with zero
          connections see what infrastructure speaks. */}
      <ProviderCatalog activeProviders={kpis.providerDistribution.map((d) => d.provider)} />

      {/* Provider distribution — only when we have real data */}
      {kpis.providerDistribution.length > 0 && (
        <ProviderDistribution distribution={kpis.providerDistribution} workforceCount={kpis.workforceCount} />
      )}

      {/* Booking impact intelligence (Phase 17B refinement #6) */}
      {isAdmin && <BookingImpactSection impact={bookingImpact} kpis={kpis} />}

      {/* Workforce sync table */}
      <PremiumCard className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3.5 sm:px-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Workforce sync
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
              Per-staff calendar health
            </h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              {isAdmin
                ? "Every workforce member's connection. Setup + reconnects happen on the Staff Profile."
                : "Your calendar connection. Setup + reconnects happen on your Staff Profile."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" strokeWidth={1.75} />
              <input
                type="text"
                placeholder="Filter staff, provider, status…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-[220px] rounded-md border border-border bg-surface py-1.5 pl-7 pr-2.5 text-[12px] placeholder:text-ink-subtle"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw
                className={cn("mr-1 h-3 w-3", refreshing && "animate-spin")}
                strokeWidth={2}
              />
              Refresh
            </Button>
          </div>
        </div>

        {filteredRows.length === 0 ? (
          <EmptyTable hasAny={tableRows.length > 0} />
        ) : (
          <ul className="divide-y divide-border/60">
            {filteredRows.map((r) => (
              <SyncTableRow
                key={r.staff.id}
                row={r}
                viewerId={viewerId}
                isAdmin={isAdmin}
                busy={busyId === r.connection?.id}
                onForceDisconnect={() => r.connection && forceDisconnect(r.connection)}
              />
            ))}
          </ul>
        )}
      </PremiumCard>

      {/* Recent sync activity */}
      <RecentActivity logs={logs} workforce={workforce} />

      {/* Future scaffolds */}
      <FutureScaffolds />
    </div>
  );
}

type TableRow = { staff: StaffLite; connection: ConnectionRow | null };

// ─── Hero ────────────────────────────────────────────────────────

function InfraHero({ isAdmin, viewerName }: { isAdmin: boolean; viewerName: string }) {
  return (
    <PremiumCard className="relative overflow-hidden p-5">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-12 bottom-0 h-32 w-32 rounded-full bg-indigo-500/8 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-indigo-700 ring-1 ring-indigo-200/40">
            <Activity className="h-3 w-3" strokeWidth={2} />
            Sync infrastructure observability
          </div>
          <h1 className="mt-2.5 text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">
            Calendar infrastructure
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            Workforce-wide sync health, provider distribution, and recent event activity.{" "}
            {isAdmin
              ? "Setup belongs on each staff member's profile — this surface monitors what's running."
              : `Hi ${viewerName} — manage your own calendar from your Staff Profile.`}
          </p>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Ownership banner ───────────────────────────────────────────

function OwnershipBanner() {
  return (
    <PremiumCard className="p-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
          <Route className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Ownership architecture</div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Calendars are staff-owned · the workspace observes the infrastructure
          </h2>
          <div className="mt-2 grid grid-cols-1 gap-2 text-[11.5px] leading-relaxed text-ink-muted sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink">
                <Users className="h-3 w-3 text-brand-accent" strokeWidth={2} />
                Staff Profile · setup &amp; reconnects
              </div>
              <p className="mt-1 text-[11px] text-ink-muted">
                Each workforce member owns their connections — Google Calendar, Outlook, conferencing
                defaults, and reconnects all live on the staff profile.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-surface px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink">
                <Gauge className="h-3 w-3 text-indigo-600" strokeWidth={2} />
                This page · monitoring &amp; recovery
              </div>
              <p className="mt-1 text-[11px] text-ink-muted">
                Workspace-wide health visibility. Admins use this to spot reconnect requirements, error
                rates, and connection coverage across the workforce.
              </p>
            </div>
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── KPI strip ─────────────────────────────────────────────────

function KpiStrip({ kpis }: { kpis: CalendarKpis }) {
  const items: Array<{ icon: LucideIcon; label: string; value: string; sub?: string; tone: string }> = [
    {
      icon: Cable,
      label: "Connected staff",
      value: String(kpis.connectedStaffCount),
      sub: kpis.workforceCount > 0 ? `of ${kpis.workforceCount}` : undefined,
      tone: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15",
    },
    {
      icon: CheckCircle2,
      label: "Healthy",
      value: String(kpis.healthyCount),
      sub: kpis.connectedStaffCount > 0 ? `of ${kpis.connectedStaffCount}` : undefined,
      tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
    },
    {
      icon: AlertCircle,
      label: "Reconnect required",
      value: String(kpis.reconnectRequiredCount),
      sub: kpis.withWarningCount > 0 ? `+${kpis.withWarningCount} warning` : undefined,
      tone: kpis.reconnectRequiredCount === 0
        ? "bg-surface-inset text-ink-subtle ring-border/40"
        : "bg-amber-50 text-amber-700 ring-amber-200/40",
    },
    {
      icon: ShieldAlert,
      label: "Errors · last 7 days",
      value: String(kpis.errorsLast7d),
      tone: kpis.errorsLast7d === 0
        ? "bg-surface-inset text-ink-subtle ring-border/40"
        : "bg-rose-50 text-rose-700 ring-rose-200/40",
    },
    {
      icon: Activity,
      label: "Sync events · 24h",
      value: String(kpis.syncEventsLast24h),
      tone: "bg-indigo-50 text-indigo-700 ring-indigo-200/40",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <PremiumCard key={it.label} className="relative overflow-hidden p-3">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{it.label}</div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-[20px] font-semibold leading-none tabular-nums tracking-tight text-ink">{it.value}</span>
                  {it.sub && <span className="text-[10.5px] text-ink-subtle">{it.sub}</span>}
                </div>
              </div>
              <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1", it.tone)}>
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
            </div>
          </PremiumCard>
        );
      })}
    </div>
  );
}

// ─── Provider distribution strip ────────────────────────────────

function ProviderDistribution({
  distribution,
  workforceCount,
}: {
  distribution: Array<{ provider: string; count: number }>;
  workforceCount: number;
}) {
  return (
    <PremiumCard className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Provider distribution</div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Which calendars are in play</h2>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {distribution.map((d) => {
          const pct = workforceCount > 0 ? Math.round((d.count / workforceCount) * 100) : 0;
          return (
            <span
              key={d.provider}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1",
                providerTone(d.provider),
              )}
            >
              <ProviderIcon id={d.provider} tone="color" className="h-3.5 w-3.5" />
              <span>{prettyProvider(d.provider)}</span>
              <span className="font-semibold tabular-nums">{d.count}</span>
              {pct > 0 && <span className="text-ink-subtle">·</span>}
              {pct > 0 && <span className="tabular-nums text-ink-muted">{pct}%</span>}
            </span>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// ─── Provider catalog (Phase 17B refinement #2) ───────────────────
//
// Renders every provider the infrastructure speaks. Active providers
// (=at least one connection in the tenant) get full color. Inactive
// or not-yet-shipped providers get a calm monochrome treatment with
// an honest "Coming soon" pill. This teaches the operator the
// supported infrastructure surface without fabricating Connect
// buttons.

function ProviderCatalog({ activeProviders }: { activeProviders: string[] }) {
  const active = new Set(activeProviders);
  return (
    <PremiumCard className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Supported infrastructure</div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Provider catalog</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Calendar + conferencing providers the workforce can connect to. Live providers paint in brand color;
            roadmap providers stay monochrome with a honest &quot;Coming soon&quot; pill.
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PROVIDER_CATALOG.map((p) => {
          const isActive = p.live && active.has(p.id);
          const isLive = p.live;
          return (
            <div
              key={p.id}
              className={cn(
                "relative overflow-hidden rounded-xl border p-3 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                isActive
                  ? "border-border bg-surface hover:-translate-y-0.5 hover:shadow-soft"
                  : "border-dashed border-border bg-surface-inset/30",
              )}
              title={isLive ? undefined : p.rationale}
            >
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1",
                    isActive ? providerTone(p.id) : "bg-surface text-ink-subtle ring-border/40",
                  )}
                >
                  <ProviderIcon id={p.id} tone={isActive ? "color" : "mono"} className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn("text-[12.5px] font-semibold tracking-tight", isActive ? "text-ink" : "text-ink-muted")}>
                      {p.name}
                    </span>
                    {isLive ? (
                      <span className={cn(
                        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1",
                        isActive
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                          : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15",
                      )}>
                        {isActive ? "Live" : "Available"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">
                    {p.kind === "calendar" ? "Calendar provider" : "Conferencing provider"} · {p.rationale}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// ─── Booking impact intelligence (Phase 17B refinement #6) ────────
//
// Honest aggregates from the server. Renders distinct "all green"
// vs "degraded" treatments — never fabricates a problem when none
// exists. Counts only; we don't tell the operator WHICH service
// is at risk here (that belongs on the Service page).

function BookingImpactSection({
  impact,
  kpis,
}: {
  impact: BookingImpact;
  kpis: CalendarKpis;
}) {
  const allHealthy =
    impact.disconnectedStaffCount === 0 &&
    impact.servicesAtRiskCount === 0 &&
    impact.servicesUncoveredCount === 0;

  if (allHealthy) {
    return (
      <PremiumCard className="p-4">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/40 shadow-[0_0_18px_rgba(16,185,129,0.20)]">
            <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Booking impact</div>
            <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Workforce connectivity is healthy</h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              {kpis.connectedStaffCount > 0
                ? "Every connected staff member has a healthy sync, and no services are running with degraded calendar coverage."
                : "No calendar connections to assess yet. As staff link their providers, this section reports any coverage gaps that would affect booking quality."}
            </p>
          </div>
        </div>
      </PremiumCard>
    );
  }

  const tiles: Array<{ icon: LucideIcon; label: string; value: string; tone: string; caption: string }> = [
    {
      icon: WifiOff,
      label: "Disconnected staff",
      value: String(impact.disconnectedStaffCount),
      tone: impact.disconnectedStaffCount === 0
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
        : "bg-amber-50 text-amber-700 ring-amber-200/40",
      caption: impact.disconnectedStaffCount === 0
        ? "Every workforce member has a healthy connection."
        : "Bookings still work — calendar sync features (busy-time skew, auto event-create) are inactive for these staff.",
    },
    {
      icon: AlertCircle,
      label: "Services with partial coverage",
      value: String(impact.servicesAtRiskCount),
      tone: impact.servicesAtRiskCount === 0
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
        : "bg-amber-50 text-amber-700 ring-amber-200/40",
      caption: "At least one assigned staff is uncovered. Routing still works; calendar-aware features degrade.",
    },
    {
      icon: ShieldAlert,
      label: "Services with zero healthy coverage",
      value: String(impact.servicesUncoveredCount),
      tone: impact.servicesUncoveredCount === 0
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
        : "bg-rose-50 text-rose-700 ring-rose-200/40",
      caption: "No assigned staff has a healthy sync. Worth a manager nudge — these services are flying blind on calendar data.",
    },
  ];

  return (
    <PremiumCard className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Booking impact</div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Connectivity-driven coverage signals
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Honest counts only — bookings continue to function without calendar sync, but calendar-aware features
            (busy-time skew, auto event-create, Meet auto-link) require a healthy connection.
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <div key={t.label} className="rounded-xl border border-border bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{t.label}</div>
                  <div className="mt-1 text-[20px] font-semibold leading-none tabular-nums tracking-tight text-ink">{t.value}</div>
                </div>
                <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1", t.tone)}>
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                </span>
              </div>
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">{t.caption}</p>
            </div>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// ─── Workforce sync row ────────────────────────────────────────

function SyncTableRow({
  row,
  viewerId,
  isAdmin,
  busy,
  onForceDisconnect,
}: {
  row: TableRow;
  viewerId: string;
  isAdmin: boolean;
  busy: boolean;
  onForceDisconnect: () => void;
}) {
  const { staff, connection } = row;
  const isSelf = staff.id === viewerId;
  const profileHref = `/dashboard/staff?focus=${staff.id}`;

  if (!connection) {
    // "Not connected" row — calm, no buttons firing OAuth (Phase
    // 17B language pass: "Awaiting setup" -> "Not connected").
    return (
      <li className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Avatar name={staff.displayName} src={staff.avatarUrl} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-semibold text-ink">{staff.displayName}</span>
              <RoleBadge role={staff.role} />
              {isSelf && (
                <span className="inline-flex items-center rounded-full bg-brand-subtle/70 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-brand-accent ring-1 ring-brand-accent/15">
                  you
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-muted">
              {staff.title ?? staff.email}
            </div>
          </div>
        </div>

        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100/80 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-600 ring-1 ring-slate-200/60">
          <WifiOff className="h-3 w-3" strokeWidth={1.75} />
          Not connected
        </span>

        <div className="hidden text-[10.5px] text-ink-subtle md:block">
          No calendar provider linked
        </div>

        <Link
          href={profileHref}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-all duration-[200ms] hover:bg-surface-inset"
        >
          {isSelf ? "Connect on profile" : "Open profile"}
          <ChevronRight className="h-3 w-3" strokeWidth={2} />
        </Link>
      </li>
    );
  }

  const health = deriveHealth(connection);
  const tokenHealth = deriveTokenHealth(connection);
  const HealthIcon = health.state === "healthy"
    ? CheckCircle2
    : health.state === "warning"
      ? AlertCircle
      : health.state === "reconnect"
        ? ShieldAlert
        : CircleSlash;

  return (
    <li className="group flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors duration-[200ms] hover:bg-surface-inset/30 sm:px-5">
      {/* Staff */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar name={staff.displayName} src={staff.avatarUrl} size="sm" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-ink">{staff.displayName}</span>
            <RoleBadge role={staff.role} />
            {isSelf && (
              <span className="inline-flex items-center rounded-full bg-brand-subtle/70 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-brand-accent ring-1 ring-brand-accent/15">
                you
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-muted">
            <Clock className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={1.75} />
            <span className="tabular-nums">{staff.timezone}</span>
          </div>
        </div>
      </div>

      {/* Provider — brand SVG, color when healthy, mono when degraded */}
      <div className="flex items-center gap-1.5">
        <span className={cn(
          "inline-flex h-6 w-6 items-center justify-center rounded ring-1",
          providerTone(connection.provider),
        )}>
          <ProviderIcon
            id={connection.provider}
            tone={health.state === "healthy" ? "color" : "mono"}
            className="h-4 w-4"
          />
        </span>
        <div className="flex flex-col">
          <span className="text-[12px] font-medium text-ink">{prettyProvider(connection.provider)}</span>
          {connection.accountEmail && (
            <span className="truncate max-w-[200px] text-[10px] text-ink-subtle" title={connection.accountEmail}>
              {connection.accountEmail}
            </span>
          )}
        </div>
      </div>

      {/* Status — Phase 17B refined palette + ambient glow on healthy */}
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ring-1",
          health.tone,
          health.state === "healthy" && "shadow-[0_0_12px_rgba(16,185,129,0.20)]",
        )}
        title={health.hint}
      >
        <HealthIcon className="h-3 w-3" strokeWidth={1.75} />
        {health.label}
      </span>

      {/* Last successful sync (Phase 17B refinement #4) —
          stricter signal than connection.lastSyncedAt; falls back
          to lastSyncedAt when no successful log exists yet. */}
      <div className="hidden flex-col md:flex">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Last successful sync</span>
        <span className="text-[11.5px] font-medium tabular-nums text-ink">
          {connection.lastSuccessfulSyncAt
            ? `Synced ${timeAgo(connection.lastSuccessfulSyncAt)}`
            : connection.lastSyncedAt
              ? `Attempted ${timeAgo(connection.lastSyncedAt)}`
              : "Never synced"}
        </span>
      </div>

      {/* Conferencing */}
      <div className="hidden flex-col lg:flex">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Conferencing</span>
        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink">
          <Video className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={1.75} />
          {providerConferencing(connection.provider)}
        </span>
      </div>

      {/* Token health */}
      <div className="hidden flex-col lg:flex">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Token</span>
        <span className={cn("text-[11.5px] font-medium", tokenHealth.tone)}>{tokenHealth.label}</span>
      </div>

      {/* Actions — non-destructive primary, low-emphasis recovery */}
      <div className="ml-auto flex items-center gap-1.5">
        <Link
          href={profileHref}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-all duration-[200ms] hover:bg-surface-inset"
        >
          {health.state === "reconnect" ? "Reconnect on profile" : "Manage on profile"}
          <ExternalLink className="h-2.5 w-2.5" strokeWidth={2} />
        </Link>
        {isAdmin && health.state !== "disconnected" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onForceDisconnect}
            title="Force-disconnect (incident recovery)"
          >
            <Trash2 className="h-3 w-3" strokeWidth={1.75} />
          </Button>
        )}
      </div>
    </li>
  );
}

function RoleBadge({ role }: { role: "admin" | "manager" | "staff" }) {
  if (role === "staff") return null;
  const tone =
    role === "admin"
      ? "bg-violet-50 text-violet-700 ring-violet-200/40"
      : "bg-sky-50 text-sky-700 ring-sky-200/40";
  return (
    <span className={cn("inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.06em] ring-1", tone)}>
      {role}
    </span>
  );
}

function EmptyTable({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="px-5 py-10 text-center">
      <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
        <Wifi className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <p className="mt-2.5 text-[13px] font-semibold tracking-tight text-ink">
        {hasAny ? "No matches for that filter" : "No workforce members yet"}
      </p>
      <p className="mt-1 text-[11.5px] text-ink-muted">
        {hasAny
          ? "Try a different name, provider, or status."
          : "Invite staff from the Staff workspace, then their connection status will appear here."}
      </p>
    </div>
  );
}

// ─── Recent sync activity ───────────────────────────────────────

function RecentActivity({ logs, workforce }: { logs: SyncLogRow[]; workforce: StaffLite[] }) {
  const byId = React.useMemo(
    () => new Map(workforce.map((s) => [s.id, s])),
    [workforce],
  );
  return (
    <PremiumCard className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3.5 sm:px-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Recent sync activity
          </div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
            Last 50 events
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Engine-side activity log. Useful for tracing why a calendar entry didn&apos;t appear or what happened on a connect attempt.
          </p>
        </div>
      </div>
      {logs.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl bg-surface-inset text-ink-subtle ring-1 ring-border/40">
            <FileText className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <p className="mt-2.5 text-[13px] font-semibold tracking-tight text-ink">No sync events yet</p>
          <p className="mt-1 text-[11.5px] text-ink-muted">
            The first time a booking lands or a free/busy probe runs, the log will populate here.
          </p>
        </div>
      ) : (
        <ul className="max-h-[360px] divide-y divide-border/60 overflow-y-auto">
          {logs.map((l) => {
            const staff = l.userId ? byId.get(l.userId) ?? null : null;
            const statusTone =
              l.status === "ok"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
                : l.status === "failed"
                  ? "bg-rose-50 text-rose-700 ring-rose-200/40"
                  : "bg-surface-inset text-ink-subtle ring-border/40";
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[11.5px] sm:px-5">
                <span className="tabular-nums text-ink-subtle">{timeAgo(l.createdAt)}</span>
                {staff && (
                  <span className="inline-flex items-center gap-1.5 text-ink">
                    <Avatar name={staff.displayName} src={staff.avatarUrl} size="xs" />
                    <span className="truncate font-medium">{staff.displayName}</span>
                  </span>
                )}
                <span className="text-ink-muted">{prettyProvider(l.provider)}</span>
                <span className="text-ink-subtle">·</span>
                <span className="text-ink">{KIND_LABEL[l.kind] ?? l.kind}</span>
                <span className={cn("inline-flex items-center rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em] ring-1", statusTone)}>
                  {l.status}
                </span>
                {typeof l.latencyMs === "number" && (
                  <span className="text-[10px] tabular-nums text-ink-subtle">{l.latencyMs}ms</span>
                )}
                {l.errorMessage && (
                  <span className="ml-auto max-w-[260px] truncate text-[10.5px] text-rose-700" title={l.errorMessage}>
                    {l.errorClass ?? "error"}: {l.errorMessage}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PremiumCard>
  );
}

// ─── Future scaffolds ─────────────────────────────────────────

function FutureScaffolds() {
  const tiles: { icon: LucideIcon; title: string; caption: string }[] = [
    { icon: Webhook,    title: "Webhook diagnostics",       caption: "Inbound provider webhook trace + replay for missed events." },
    { icon: Wifi,       title: "Provider outage monitor",   caption: "Status-page tap-in so we know it's Google, not us." },
    { icon: Repeat,     title: "Sync retry queues",         caption: "Per-connection backoff queue with manual retry controls." },
    { icon: Copy,       title: "Duplicate-event prevention", caption: "Idempotency layer to stop double-creates on flapping syncs." },
    { icon: Gauge,      title: "Rate-limit monitoring",     caption: "Per-provider quota tracking with budget alarms." },
    { icon: Route,      title: "Event delivery tracing",    caption: "Per-booking lifecycle: created -> synced -> updated -> deleted." },
    { icon: FileText,   title: "Calendar write logs",       caption: "Searchable archive of every external mutation we performed." },
    { icon: Sparkles,   title: "Provider failover",         caption: "Auto-route writes to a secondary provider when the primary is down." },
  ];
  return (
    <PremiumCard className="p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Future infrastructure surfaces</div>
      <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h2>
      <p className="mt-0.5 text-[11.5px] text-ink-muted">
        Observability + recovery primitives that ship as their backends land. Honest scaffolding — no
        fabricated controls.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <div key={t.title} className="relative overflow-hidden rounded-xl border border-dashed border-border bg-surface-inset/30 p-3">
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              <div className="flex items-start gap-2.5">
                <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle ring-1 ring-border/40">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold tracking-tight text-ink">{t.title}</span>
                    <span className="inline-flex items-center rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                      Coming soon
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{t.caption}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// Silence unused-import warnings for icons we intentionally
// import for visual consistency but don't use directly.
void CalendarSync;
