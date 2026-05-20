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
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
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
    case "outlook":
    case "office365":
      return "Outlook";
    case "apple":
      return "iCloud";
    default:
      return p.charAt(0).toUpperCase() + p.slice(1);
  }
}

function providerConferencing(p: string): string {
  if (p === "google") return "Google Meet";
  if (p === "outlook" || p === "office365") return "Teams";
  return "—";
}

function providerInitial(p: string): { initial: string; tone: string } {
  if (p === "google")
    return { initial: "G", tone: "bg-sky-50 text-sky-700 ring-sky-200/60" };
  if (p === "outlook" || p === "office365")
    return { initial: "O", tone: "bg-indigo-50 text-indigo-700 ring-indigo-200/60" };
  if (p === "apple")
    return { initial: "A", tone: "bg-rose-50 text-rose-700 ring-rose-200/60" };
  return { initial: p.charAt(0).toUpperCase(), tone: "bg-surface-inset text-ink-muted ring-border/40" };
}

// Operational health derivation. Honest combination of the
// connection.status + recent lastError signal. Never fabricated.
type HealthState = "healthy" | "warning" | "reconnect" | "disconnected" | "error";
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
    return {
      state: "reconnect",
      label: "Reconnect required",
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
      hint: c.lastError ?? "Token expired or revoked",
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
  flashConnected,
  flashError,
}: {
  viewerId: string;
  viewerRole: "admin" | "manager" | "staff";
  workforce: StaffLite[];
  connections: ConnectionRow[];
  logs: SyncLogRow[];
  kpis: CalendarKpis;
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
  //   • Staff without a connection get an "Awaiting setup" row
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

      {/* Provider distribution */}
      {kpis.providerDistribution.length > 0 && (
        <ProviderDistribution distribution={kpis.providerDistribution} workforceCount={kpis.workforceCount} />
      )}

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
          const initial = providerInitial(d.provider);
          const pct = workforceCount > 0 ? Math.round((d.count / workforceCount) * 100) : 0;
          return (
            <span
              key={d.provider}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1",
                initial.tone,
              )}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface/70 text-[9px] font-bold">
                {initial.initial}
              </span>
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
    // Awaiting setup row — calm, no buttons firing OAuth.
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

        <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
          <WifiOff className="h-3 w-3" strokeWidth={1.75} />
          Awaiting setup
        </span>

        <div className="hidden text-[10.5px] text-ink-subtle md:block">
          No provider connected yet
        </div>

        <Link
          href={profileHref}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-all duration-[200ms] hover:bg-surface-inset"
        >
          {isSelf ? "Set up in profile" : "Open profile"}
          <ChevronRight className="h-3 w-3" strokeWidth={2} />
        </Link>
      </li>
    );
  }

  const health = deriveHealth(connection);
  const tokenHealth = deriveTokenHealth(connection);
  const initial = providerInitial(connection.provider);
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

      {/* Provider */}
      <div className="flex items-center gap-1.5">
        <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded ring-1 text-[10px] font-bold", initial.tone)}>
          {initial.initial}
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

      {/* Status */}
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ring-1",
          health.tone,
        )}
        title={health.hint}
      >
        <HealthIcon className="h-3 w-3" strokeWidth={1.75} />
        {health.label}
      </span>

      {/* Last sync + calendar id */}
      <div className="hidden flex-col md:flex">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Last sync</span>
        <span className="text-[11.5px] font-medium tabular-nums text-ink">
          {connection.lastSyncedAt ? timeAgo(connection.lastSyncedAt) : "—"}
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
