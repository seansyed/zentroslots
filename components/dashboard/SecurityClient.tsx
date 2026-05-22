"use client";

/**
 * Security Center — premium operational security workspace.
 *
 * Composition (Phases 1, 2, 3, 4, 5, 8, 12 of the Security Transformation
 * brief — Phases 6/7 permissions UX rewrite + Phase 9 future-ready
 * placeholders + Phase 10/11 microinteractions/a11y polish are deferred
 * follow-ups; existing permissions tables retained as-is).
 *
 * Top-down:
 *   1. Hero with security posture badge + last-monitored timestamp
 *   2. Executive KPI strip (6 cards)
 *   3. Two-column work area:
 *        left = sessions cards + security timeline
 *        right = insights panel (sticky)
 *   4. Effective permissions snapshot (kept — wrapped in premium card)
 *   5. Tenant user permissions manager (kept — admin-only)
 *   6. Revoke-all confirmation modal (kept) + new individual revoke
 *      confirmation per Phase 12 hardening
 *
 * Data contract is unchanged — same props the server page has always
 * passed. NO auth rewrites, NO RBAC regressions, additive UX only.
 */

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eye,
  Globe,
  Info,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Mail,
  Monitor,
  RefreshCw,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  TrendingUp,
  UserCog,
  Users,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────

type SessionRow = {
  jti: string;
  loggedInAt: string;
  ipAddress: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  isCurrent: boolean;
  revoked: boolean;
};

type EventRow = {
  id: string;
  eventType: string;
  sessionJti: string | null;
  ipAddress: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ResetRow = {
  id: string;
  requestedIp: string | null;
  createdAt: string;
  consumedAt: string | null;
  consumedIp: string | null;
};

type TenantUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  effective: Record<string, boolean>;
  overrides: Record<string, boolean>;
  isCaller: boolean;
};

type Props = {
  userEmail: string;
  canManage: boolean;
  permissions: Record<string, boolean>;
  permissionFlags?: string[];
  tenantUsers?: TenantUserRow[];
  activeSessions: SessionRow[];
  recentLogins: EventRow[];
  failedLogins: EventRow[];
  suspicious: EventRow[];
  resetHistory: ResetRow[];
  events: EventRow[];
};

// ─── Root ─────────────────────────────────────────────────────────────

export default function SecurityClient(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  // Derived posture + KPIs (memoized — these are pure reads over props).
  const posture = useMemo(() => derivePosture(props), [props]);
  const kpis = useMemo(() => deriveKpis(props), [props]);
  const insights = useMemo(() => deriveInsights(props), [props]);
  const timeline = useMemo(() => buildTimeline(props), [props]);

  async function revokeOne(jti: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/auth/sessions/${encodeURIComponent(jti)}/revoke`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not revoke session.");
      setConfirmRevoke(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke session.");
    }
  }

  async function revokeAll() {
    setError(null);
    try {
      const res = await fetch("/api/auth/sessions/revoke-all", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not revoke sessions.");
      setConfirmAll(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke sessions.");
    }
  }

  return (
    <div className="mt-2 space-y-5 pb-12">
      {/* Inline error stays visible across re-renders */}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      <Hero
        userEmail={props.userEmail}
        canManage={props.canManage}
        posture={posture}
      />

      <KpiStrip kpis={kpis} canManage={props.canManage} />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* LEFT — operational surfaces (2/3 width) */}
        <div className="space-y-5 lg:col-span-2">
          <SessionsSection
            sessions={props.activeSessions}
            canManage={props.canManage}
            pending={pending}
            onRevoke={(jti) => setConfirmRevoke(jti)}
            onRevokeAll={() => setConfirmAll(true)}
          />

          <TimelineSection items={timeline} />
        </div>

        {/* RIGHT — insights (1/3 width, sticky on desktop) */}
        <aside className="lg:col-span-1">
          <div className="lg:sticky lg:top-6">
            <InsightsPanel insights={insights} />
          </div>
        </aside>
      </div>

      {/* Effective permissions — kept (Phase 6 UX rewrite deferred).
          Wrapped in a premium card so it stops looking like a raw table. */}
      <PermissionsSection permissions={props.permissions} />

      {/* Password reset history — secondary, collapsed by default */}
      <ResetHistorySection rows={props.resetHistory} />

      {/* Tenant user permissions manager — unchanged behavior (Phase 7
          UX rewrite deferred). Only renders for canManage; existing
          self-protection + caller-permission gating preserved. */}
      {props.canManage && props.tenantUsers && props.permissionFlags && (
        <TenantPermissionsSection
          users={props.tenantUsers}
          flags={props.permissionFlags}
          callerPermissions={props.permissions}
          onChanged={() => startTransition(() => router.refresh())}
          onError={(msg) => setError(msg)}
        />
      )}

      {/* Confirmation dialogs (Phase 12 hardening) */}
      {confirmRevoke && (
        <ConfirmDialog
          icon={LogOut}
          title="Revoke this session?"
          body="The selected session will be signed out immediately on its device. The user will need to sign in again to regain access."
          confirmLabel="Revoke session"
          tone="danger"
          pending={pending}
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => revokeOne(confirmRevoke)}
        />
      )}
      {confirmAll && (
        <ConfirmDialog
          icon={ShieldAlert}
          title="Sign out all other sessions?"
          body="Every active session for your account on every other device will be signed out immediately. You will stay signed in here."
          confirmLabel="Sign out all"
          tone="danger"
          pending={pending}
          onCancel={() => setConfirmAll(false)}
          onConfirm={revokeAll}
        />
      )}
    </div>
  );
}

// ─── Hero (Phase 1) ───────────────────────────────────────────────────

type Posture = {
  level: "secure" | "watch" | "alert";
  label: string;
  hint: string;
  Icon: LucideIcon;
  tone: { ring: string; chip: string; dot: string; bg: string; text: string };
};

function Hero({
  userEmail,
  canManage,
  posture,
}: {
  userEmail: string;
  canManage: boolean;
  posture: Posture;
}) {
  const now = new Date();
  const Icon = posture.Icon;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      {/* Ambient depth */}
      <div
        aria-hidden
        className={
          "pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl " +
          (posture.level === "alert"
            ? "bg-rose-200/40"
            : posture.level === "watch"
              ? "bg-amber-200/40"
              : "bg-emerald-200/40")
        }
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />

      <div className="relative px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <span className={"grid h-12 w-12 shrink-0 place-items-center rounded-2xl ring-1 " + posture.tone.bg + " " + posture.tone.text + " " + posture.tone.ring}>
              <Icon className="h-6 w-6" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
                  <Shield className="h-3 w-3" strokeWidth={2.25} />
                  Account security
                </span>
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1 " +
                    posture.tone.chip
                  }
                  title={posture.hint}
                >
                  <span
                    aria-hidden
                    className={"inline-block h-1.5 w-1.5 rounded-full " + posture.tone.dot}
                  />
                  {posture.label}
                </span>
                {!canManage && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200/50">
                    <Eye className="h-3 w-3" />
                    Read-only
                  </span>
                )}
              </div>
              <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">
                Security Center
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
                Monitor account activity, permissions, sessions, authentication
                events, and operational security for{" "}
                <span className="font-medium text-ink">{userEmail}</span>.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
                  <Activity className="h-3 w-3 text-emerald-600" strokeWidth={2.25} />
                  Monitored continuously
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
                  <Clock className="h-3 w-3" strokeWidth={2} />
                  Last refreshed {fmtRelative(now.toISOString())}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
                  <ShieldCheck className="h-3 w-3 text-brand-accent" strokeWidth={2.25} />
                  TLS + audited
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── KPI strip (Phase 2) ──────────────────────────────────────────────

type KpiSet = {
  activeSessions: number;
  securityScore: number;
  failedLogins30: number;
  auditEvents30: number;
  suspicious30: number;
  permissionOverrides: number;
};

function KpiStrip({ kpis, canManage }: { kpis: KpiSet; canManage: boolean }) {
  const items: Array<{
    icon: LucideIcon;
    label: string;
    value: string;
    hint: string;
    tone: "emerald" | "sky" | "amber" | "rose" | "brand" | "muted";
  }> = [
    {
      icon: Monitor,
      label: "Active sessions",
      value: String(kpis.activeSessions),
      hint: kpis.activeSessions === 1 ? "Just this device" : "Across devices",
      tone: kpis.activeSessions > 1 ? "sky" : "emerald",
    },
    {
      icon: ShieldCheck,
      label: "Security score",
      value: `${kpis.securityScore}`,
      hint: scoreHint(kpis.securityScore),
      tone:
        kpis.securityScore >= 90
          ? "emerald"
          : kpis.securityScore >= 70
            ? "sky"
            : kpis.securityScore >= 50
              ? "amber"
              : "rose",
    },
    {
      icon: XCircle,
      label: "Failed logins (30d)",
      value: String(kpis.failedLogins30),
      hint: kpis.failedLogins30 === 0 ? "Clean window" : "Review recommended",
      tone: kpis.failedLogins30 === 0 ? "emerald" : kpis.failedLogins30 < 5 ? "amber" : "rose",
    },
    {
      icon: Activity,
      label: "Audit events (30d)",
      value: String(kpis.auditEvents30),
      hint: "Logins, role changes, resets",
      tone: kpis.auditEvents30 > 0 ? "brand" : "muted",
    },
    {
      icon: AlertTriangle,
      label: "Suspicious alerts",
      value: String(kpis.suspicious30),
      hint: kpis.suspicious30 === 0 ? "No flagged activity" : "Investigate immediately",
      tone: kpis.suspicious30 === 0 ? "emerald" : "rose",
    },
    {
      icon: UserCog,
      label: "Permission overrides",
      value: canManage ? String(kpis.permissionOverrides) : "—",
      hint: canManage ? "Active per-user overrides" : "Admin view only",
      tone: canManage && kpis.permissionOverrides > 0 ? "amber" : "muted",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => (
        <KpiCard key={it.label} {...it} />
      ))}
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  tone: "emerald" | "sky" | "amber" | "rose" | "brand" | "muted";
}) {
  const toneClass: Record<typeof tone, string> = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200/50",
    sky: "bg-sky-50 text-sky-700 ring-sky-200/50",
    amber: "bg-amber-50 text-amber-700 ring-amber-200/50",
    rose: "bg-rose-50 text-rose-700 ring-rose-200/50",
    brand: "bg-brand-subtle/60 text-brand-accent ring-brand-accent/20",
    muted: "bg-surface-inset text-ink-subtle ring-border/40",
  };
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-3.5 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[22px] font-semibold tracking-tight text-ink tabular-nums">
            {value}
          </div>
          <div className="mt-1 text-[10.5px] text-ink-muted">{hint}</div>
        </div>
        <span className={"inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 " + toneClass[tone]}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
    </div>
  );
}

// ─── Sessions section (Phase 4) ───────────────────────────────────────

function SessionsSection({
  sessions,
  canManage,
  pending,
  onRevoke,
  onRevokeAll,
}: {
  sessions: SessionRow[];
  canManage: boolean;
  pending: boolean;
  onRevoke: (jti: string) => void;
  onRevokeAll: () => void;
}) {
  return (
    <section>
      <SectionHeader
        icon={Monitor}
        title="Active sessions"
        subtitle="Every device currently signed in to your account."
        action={
          canManage && sessions.filter((s) => !s.isCurrent && !s.revoked).length > 0 ? (
            <button
              onClick={onRevokeAll}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-1.5 text-[12px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out all others
            </button>
          ) : null
        }
      />
      {sessions.length === 0 ? (
        <PremiumEmpty
          icon={ShieldCheck}
          tone="positive"
          title="Session tracking is ready"
          body="Your current cookie was issued before security tracking was enabled. Your next sign-in will start full session telemetry."
        />
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {sessions.map((s) => (
            <SessionCard key={s.jti} session={s} canManage={canManage} pending={pending} onRevoke={onRevoke} />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionCard({
  session,
  canManage,
  pending,
  onRevoke,
}: {
  session: SessionRow;
  canManage: boolean;
  pending: boolean;
  onRevoke: (jti: string) => void;
}) {
  const ua = parseUserAgent(session.userAgent);
  const DeviceIcon = ua.deviceIcon;
  return (
    <div
      className={
        "relative overflow-hidden rounded-2xl border bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:shadow-soft " +
        (session.isCurrent
          ? "border-emerald-200/60 ring-1 ring-emerald-200/50"
          : session.revoked
            ? "border-border/60 opacity-70"
            : "border-border/60 hover:-translate-y-0.5")
      }
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <DeviceIcon className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold tracking-tight text-ink">
              {ua.label}
            </span>
            {session.isCurrent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
                <CheckCircle2 className="h-2.5 w-2.5" strokeWidth={2.5} />
                This device
              </span>
            )}
            {session.revoked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                Revoked
              </span>
            )}
            {!session.isCurrent && !session.revoked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-sky-700 ring-1 ring-sky-200/50">
                Active
              </span>
            )}
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-muted">
            <span className="flex items-center gap-1">
              <Globe className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
              {session.ipAddress ?? "Unknown IP"}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
              {fmtRelative(session.loggedInAt)}
            </span>
          </div>
          {session.userAgent && (
            <div className="mt-2 truncate font-mono text-[10px] text-ink-subtle" title={session.userAgent}>
              {session.userAgent}
            </div>
          )}
        </div>
      </div>
      {canManage && !session.isCurrent && !session.revoked && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => onRevoke(session.jti)}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-surface px-2.5 py-1 text-[11px] font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" /> Revoke
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Security timeline (Phase 5) ──────────────────────────────────────

type TimelineItem = {
  id: string;
  eventType: string;
  severity: "info" | "success" | "warn" | "alert";
  title: string;
  meta?: string;
  ip?: string | null;
  device?: string | null;
  createdAt: string;
};

function TimelineSection({ items }: { items: TimelineItem[] }) {
  return (
    <section>
      <SectionHeader
        icon={Activity}
        title="Security activity"
        subtitle="Logins, failed attempts, password resets, and audit events on this account."
      />
      {items.length === 0 ? (
        <PremiumEmpty
          icon={ShieldCheck}
          tone="positive"
          title="Quiet window"
          body="No security events recorded in the last 30 days. Activity will appear here as it happens."
        />
      ) : (
        <ol className="mt-3 space-y-2">
          {items.map((it) => (
            <TimelineRow key={it.id} item={it} />
          ))}
        </ol>
      )}
    </section>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const sev = SEVERITY_TONES[item.severity];
  const Icon = sev.Icon;
  return (
    <li className="group flex items-start gap-3 rounded-xl border border-border/60 bg-surface p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft">
      <span className={"mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 " + sev.iconClass}>
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={"inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] ring-1 " + sev.pillClass}>
            {item.eventType.replace(/_/g, " ")}
          </span>
          <span className="text-[12px] font-medium text-ink">{item.title}</span>
        </div>
        {item.meta && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{item.meta}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-ink-subtle">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" strokeWidth={2} />
            {fmtRelative(item.createdAt)}
          </span>
          {item.ip && (
            <span className="flex items-center gap-1">
              <Globe className="h-2.5 w-2.5" strokeWidth={2} />
              {item.ip}
            </span>
          )}
          {item.device && (
            <span className="flex items-center gap-1">
              <Monitor className="h-2.5 w-2.5" strokeWidth={2} />
              {item.device}
            </span>
          )}
        </div>
      </div>
      <span aria-hidden className="self-center opacity-0 transition-opacity group-hover:opacity-100">
        <ChevronRight className="h-4 w-4 text-ink-subtle" strokeWidth={2} />
      </span>
    </li>
  );
}

const SEVERITY_TONES: Record<TimelineItem["severity"], { Icon: LucideIcon; iconClass: string; pillClass: string }> = {
  info: {
    Icon: Info,
    iconClass: "bg-surface-inset text-ink-subtle ring-border/40",
    pillClass: "bg-surface-inset text-ink-muted ring-border/40",
  },
  success: {
    Icon: CheckCircle2,
    iconClass: "bg-emerald-50 text-emerald-700 ring-emerald-200/50",
    pillClass: "bg-emerald-50 text-emerald-700 ring-emerald-200/50",
  },
  warn: {
    Icon: AlertTriangle,
    iconClass: "bg-amber-50 text-amber-700 ring-amber-200/50",
    pillClass: "bg-amber-50 text-amber-700 ring-amber-200/50",
  },
  alert: {
    Icon: ShieldAlert,
    iconClass: "bg-rose-50 text-rose-700 ring-rose-200/50",
    pillClass: "bg-rose-50 text-rose-700 ring-rose-200/50",
  },
};

// ─── Insights panel (Phase 8) ─────────────────────────────────────────

type InsightItem = {
  id: string;
  Icon: LucideIcon;
  tone: "positive" | "neutral" | "warn";
  title: string;
  body: string;
};

function InsightsPanel({ insights }: { insights: InsightItem[] }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-surface p-4 shadow-soft">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Intelligence
          </div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Security insights</h2>
        </div>
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">
        Real-time signals from your account telemetry.
      </p>
      <ul className="mt-3 space-y-2">
        {insights.map((i) => {
          const Icon = i.Icon;
          const tone =
            i.tone === "positive"
              ? "bg-emerald-50 text-emerald-700 ring-emerald-200/50"
              : i.tone === "warn"
                ? "bg-amber-50 text-amber-700 ring-amber-200/50"
                : "bg-surface-inset text-ink-subtle ring-border/40";
          return (
            <li
              key={i.id}
              className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-surface-inset/30 p-3"
            >
              <span className={"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 " + tone}>
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="text-[12px] font-semibold tracking-tight text-ink">{i.title}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{i.body}</p>
              </div>
            </li>
          );
        })}
      </ul>
      {/* Future-ready footer — informational only, not implemented per
          Phase 9 scope deferral. Surfaces the roadmap so enterprise
          viewers see "this is coming" rather than "this is missing." */}
      <div className="mt-4 rounded-xl border border-dashed border-border/70 bg-surface-inset/30 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
          Roadmap
        </div>
        <ul className="mt-1.5 space-y-1 text-[11px] text-ink-muted">
          <li className="flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
            MFA / TOTP enrollment
          </li>
          <li className="flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
            SSO / SAML for Enterprise
          </li>
          <li className="flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
            Device trust + IP allowlists
          </li>
          <li className="flex items-center gap-1.5">
            <Lock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
            Compliance log export
          </li>
        </ul>
      </div>
    </div>
  );
}

// ─── Effective permissions snapshot (Phase 6 deferred — cosmetic wrap) ─

function PermissionsSection({ permissions }: { permissions: Record<string, boolean> }) {
  const granted = Object.entries(permissions).filter(([, v]) => v);
  const denied = Object.entries(permissions).filter(([, v]) => !v);
  return (
    <section>
      <SectionHeader
        icon={KeyRound}
        title="Your effective permissions"
        subtitle="Resolved from your role + any individual overrides."
      />
      <div className="mt-3 overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-sm">
        <div className="grid gap-px bg-border/40 sm:grid-cols-2">
          <PermissionGroup
            tone="positive"
            label={`Granted · ${granted.length}`}
            entries={granted}
          />
          <PermissionGroup
            tone="muted"
            label={`Not granted · ${denied.length}`}
            entries={denied}
          />
        </div>
      </div>
    </section>
  );
}

function PermissionGroup({
  tone,
  label,
  entries,
}: {
  tone: "positive" | "muted";
  label: string;
  entries: Array<[string, boolean]>;
}) {
  return (
    <div className="bg-surface p-4">
      <div className={"text-[10px] font-semibold uppercase tracking-[0.10em] " + (tone === "positive" ? "text-emerald-700" : "text-ink-subtle")}>
        {label}
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-subtle">None.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {entries.map(([flag]) => (
            <li
              key={flag}
              className="flex items-center justify-between rounded-md px-2 py-1 font-mono text-[11px] text-ink hover:bg-surface-inset/50"
            >
              <span className="truncate">{flag}</span>
              {tone === "positive" ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2.25} />
              ) : (
                <X className="h-3 w-3 shrink-0 text-ink-subtle" strokeWidth={2} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Reset history (collapsed, secondary) ─────────────────────────────

function ResetHistorySection({ rows }: { rows: ResetRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <SectionHeader
        icon={Mail}
        title="Password reset history"
        subtitle="Every reset request on this account. Consumed tokens cannot be reused."
      />
      <div className="mt-3 overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-surface-inset/60 text-left text-[10px] uppercase tracking-[0.10em] text-ink-subtle">
            <tr>
              <th className="px-3 py-2 font-semibold">Requested</th>
              <th className="px-3 py-2 font-semibold">From IP</th>
              <th className="px-3 py-2 font-semibold">Consumed</th>
              <th className="px-3 py-2 font-semibold">Consumed IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/40 text-[12px]">
                <td className="px-3 py-2 text-ink">{fmtRelative(r.createdAt)}</td>
                <td className="px-3 py-2 text-ink-muted">{r.requestedIp ?? "—"}</td>
                <td className="px-3 py-2 text-ink-muted">{r.consumedAt ? fmtRelative(r.consumedAt) : "—"}</td>
                <td className="px-3 py-2 text-ink-muted">{r.consumedIp ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Tenant user permissions (UNCHANGED behavior — Phase 7 deferred) ──

function TenantPermissionsSection({
  users,
  flags,
  callerPermissions,
  onChanged,
  onError,
}: {
  users: TenantUserRow[];
  flags: string[];
  callerPermissions: Record<string, boolean>;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  return (
    <section>
      <SectionHeader
        icon={Users}
        title="User permissions"
        subtitle="Per-user overrides for granular permission flags. Self-protected — you cannot modify your own permissions, and you cannot grant flags you don't hold."
      />
      <div className="mt-3 overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-sm">
        <TenantUserPermissionsTable
          users={users}
          flags={flags}
          callerPermissions={callerPermissions}
          onChanged={onChanged}
          onError={onError}
        />
      </div>
    </section>
  );
}

function TenantUserPermissionsTable(props: {
  users: TenantUserRow[];
  flags: string[];
  callerPermissions: Record<string, boolean>;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function patchOverride(userId: string, flag: string, value: boolean | null) {
    const key = `${userId}|${flag}`;
    setPendingKey(key);
    props.onError("");
    try {
      const res = await fetch(`/api/tenant/users/${encodeURIComponent(userId)}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        props.onError(data?.error ?? "Could not update permissions.");
        return;
      }
      props.onChanged();
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Could not update permissions.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface-inset/60 text-left text-[10px] uppercase tracking-[0.10em] text-ink-subtle">
          <tr>
            <th className="px-3 py-2 font-semibold">User</th>
            <th className="px-3 py-2 font-semibold">Role</th>
            {props.flags.map((f) => (
              <th key={f} className="px-3 py-2 text-center font-mono text-[9.5px] normal-case font-semibold">
                {f.replace(/^can/, "")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.users.map((u) => (
            <tr key={u.id} className="border-t border-border/40">
              <td className="px-3 py-2">
                <div className="text-[13px] font-medium text-ink">
                  {u.name}
                  {u.isCaller && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle"
                      title="Self-protected — you cannot modify your own permissions"
                    >
                      <Lock className="h-2.5 w-2.5" />
                      you
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-muted">{u.email}</div>
              </td>
              <td className="px-3 py-2 text-[11px]">
                <span className="inline-flex items-center rounded-full bg-brand-subtle/60 px-2 py-0.5 font-mono text-[10px] font-semibold text-brand-accent ring-1 ring-brand-accent/15">
                  {u.role}
                </span>
              </td>
              {props.flags.map((f) => {
                const effective = u.effective[f];
                const hasOverride = Object.prototype.hasOwnProperty.call(u.overrides, f);
                const callerCan = props.callerPermissions[f] === true;
                const cellKey = `${u.id}|${f}`;
                const busy = pendingKey === cellKey;
                const disabled = u.isCaller || busy;
                return (
                  <td key={f} className="px-3 py-2 text-center">
                    <div className="flex flex-col items-center gap-1">
                      <span
                        className={
                          "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold " +
                          (effective ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/50" : "bg-surface-inset text-ink-subtle ring-1 ring-border/40")
                        }
                      >
                        {effective ? "✓" : "—"}
                      </span>
                      {hasOverride && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-600">
                          override
                        </span>
                      )}
                      {!u.isCaller && (
                        <div className="flex gap-0.5">
                          <button
                            disabled={disabled || !callerCan}
                            onClick={() => patchOverride(u.id, f, true)}
                            title={callerCan ? "Grant" : "You don't hold this permission"}
                            className="rounded border border-border/50 px-1 py-0.5 text-[9px] hover:bg-emerald-50 disabled:opacity-30"
                          >
                            grant
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() => patchOverride(u.id, f, false)}
                            className="rounded border border-border/50 px-1 py-0.5 text-[9px] hover:bg-rose-50 disabled:opacity-30"
                          >
                            revoke
                          </button>
                          {hasOverride && (
                            <button
                              disabled={disabled}
                              onClick={() => patchOverride(u.id, f, null)}
                              title="Clear override (use role default)"
                              className="rounded border border-border/50 px-1 py-0.5 text-[9px] hover:bg-surface-inset disabled:opacity-30"
                            >
                              clear
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Confirmation dialog (Phase 12) ───────────────────────────────────

function ConfirmDialog({
  icon: Icon,
  title,
  body,
  confirmLabel,
  tone,
  pending,
  onCancel,
  onConfirm,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  confirmLabel: string;
  tone: "danger" | "neutral";
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span
            className={
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 " +
              (tone === "danger"
                ? "bg-rose-50 text-rose-700 ring-rose-200/50"
                : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15")
            }
          >
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{body}</p>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-inset"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={pending}
            className={
              "rounded-md px-3 py-1.5 text-[12px] font-semibold shadow-sm transition-colors disabled:opacity-50 " +
              (tone === "danger"
                ? "bg-rose-600 text-white hover:bg-rose-700"
                : "bg-brand-accent text-white hover:bg-brand-accent/90")
            }
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared section header + premium empty state ──────────────────────

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 max-w-2xl text-[11.5px] text-ink-muted">{subtitle}</p>
          )}
        </div>
      </div>
      {action}
    </header>
  );
}

function PremiumEmpty({
  icon: Icon,
  tone,
  title,
  body,
}: {
  icon: LucideIcon;
  tone: "positive" | "neutral";
  title: string;
  body: string;
}) {
  return (
    <div
      className={
        "mt-3 rounded-2xl border p-5 text-center " +
        (tone === "positive"
          ? "border-emerald-200/50 bg-emerald-50/40"
          : "border-dashed border-border bg-surface-inset/30")
      }
    >
      <span
        className={
          "mx-auto inline-flex h-10 w-10 items-center justify-center rounded-2xl ring-1 " +
          (tone === "positive"
            ? "bg-emerald-100 text-emerald-700 ring-emerald-200/50"
            : "bg-surface text-ink-subtle ring-border/40")
        }
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <h3 className={"mt-3 text-[13px] font-semibold tracking-tight " + (tone === "positive" ? "text-emerald-900" : "text-ink")}>
        {title}
      </h3>
      <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

// ─── Derived state helpers ────────────────────────────────────────────

function derivePosture(p: Props): Posture {
  const suspiciousCount = p.suspicious.length;
  const failedCount = p.failedLogins.length;
  if (suspiciousCount > 0) {
    return {
      level: "alert",
      label: "Action required",
      hint: "Suspicious activity detected in the last 30 days — review immediately.",
      Icon: ShieldAlert,
      tone: {
        ring: "shadow-[0_0_0_4px_rgba(244,63,94,0.18)]",
        chip: "bg-rose-50 text-rose-700 ring-rose-200/55",
        dot: "bg-rose-500",
        bg: "bg-rose-50",
        text: "text-rose-700",
      },
    };
  }
  if (failedCount >= 5) {
    return {
      level: "watch",
      label: "Monitor",
      hint: `${failedCount} failed login attempts in the last 30 days — verify they're you.`,
      Icon: Shield,
      tone: {
        ring: "shadow-[0_0_0_4px_rgba(245,158,11,0.18)]",
        chip: "bg-amber-50 text-amber-700 ring-amber-200/55",
        dot: "bg-amber-500",
        bg: "bg-amber-50",
        text: "text-amber-700",
      },
    };
  }
  return {
    level: "secure",
    label: "Secure",
    hint: "No suspicious activity. All signals green.",
    Icon: ShieldCheck,
    tone: {
      ring: "shadow-[0_0_0_4px_rgba(16,185,129,0.18)]",
      chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/55",
      dot: "bg-emerald-500",
      bg: "bg-emerald-50",
      text: "text-emerald-700",
    },
  };
}

function deriveKpis(p: Props): KpiSet {
  // Security score: start at 100, deduct for failed/suspicious/overrides.
  // Caps at 0; no extra credit (a clean account is already 100).
  let score = 100;
  score -= Math.min(40, p.failedLogins.length * 3);
  score -= Math.min(60, p.suspicious.length * 20);
  const overrides = countOverrides(p.tenantUsers ?? []);
  const activeSessions = p.activeSessions.filter((s) => !s.revoked).length;
  return {
    activeSessions,
    securityScore: Math.max(0, score),
    failedLogins30: p.failedLogins.length,
    auditEvents30: p.events.length,
    suspicious30: p.suspicious.length,
    permissionOverrides: overrides,
  };
}

function countOverrides(users: TenantUserRow[]): number {
  let n = 0;
  for (const u of users) {
    n += Object.keys(u.overrides ?? {}).length;
  }
  return n;
}

function scoreHint(score: number): string {
  if (score >= 95) return "Excellent";
  if (score >= 85) return "Strong";
  if (score >= 70) return "Good";
  if (score >= 50) return "Review needed";
  return "Action required";
}

function deriveInsights(p: Props): InsightItem[] {
  const out: InsightItem[] = [];

  // Suspicious activity
  if (p.suspicious.length === 0) {
    out.push({
      id: "suspicious",
      Icon: ShieldCheck,
      tone: "positive",
      title: "No suspicious activity",
      body: "Nothing flagged in the last 30 days. Continue monitoring.",
    });
  } else {
    out.push({
      id: "suspicious",
      Icon: ShieldAlert,
      tone: "warn",
      title: `${p.suspicious.length} suspicious event${p.suspicious.length === 1 ? "" : "s"}`,
      body: "Review the security timeline below and revoke any sessions you don't recognize.",
    });
  }

  // Stale sessions (older than 14 days, not the current device)
  const now = Date.now();
  const stale = p.activeSessions.filter((s) => {
    if (s.isCurrent || s.revoked) return false;
    const ageDays = (now - new Date(s.loggedInAt).getTime()) / 86_400_000;
    return ageDays > 14;
  }).length;
  if (stale > 0) {
    out.push({
      id: "stale",
      Icon: Clock,
      tone: "neutral",
      title: `${stale} inactive session${stale === 1 ? "" : "s"} >14d old`,
      body: "Consider signing them out if you don't recognize the device.",
    });
  } else {
    out.push({
      id: "stale-clean",
      Icon: Monitor,
      tone: "positive",
      title: "Sessions look fresh",
      body: "No idle session has been open for more than 14 days.",
    });
  }

  // Failed logins
  if (p.failedLogins.length > 0) {
    out.push({
      id: "failed",
      Icon: XCircle,
      tone: p.failedLogins.length >= 5 ? "warn" : "neutral",
      title: `${p.failedLogins.length} failed login${p.failedLogins.length === 1 ? "" : "s"} (30d)`,
      body: "Rate-limited at the API. If these weren't you, change your password.",
    });
  }

  // Recent password reset
  const mostRecentReset = p.resetHistory[0];
  if (mostRecentReset) {
    const ageDays = Math.floor(
      (now - new Date(mostRecentReset.createdAt).getTime()) / 86_400_000,
    );
    out.push({
      id: "reset",
      Icon: KeyRound,
      tone: "neutral",
      title: `Password reset ${ageDays === 0 ? "today" : `${ageDays}d ago`}`,
      body: mostRecentReset.consumedAt
        ? "Token was used — your password is current."
        : "Token was issued but never consumed. Safe to ignore.",
    });
  }

  // MFA roadmap signal (future-ready, not a real check)
  out.push({
    id: "mfa-roadmap",
    Icon: Settings2,
    tone: "neutral",
    title: "MFA / TOTP coming soon",
    body: "Enterprise MFA enrollment will land in a follow-up release.",
  });

  return out;
}

function buildTimeline(p: Props): TimelineItem[] {
  // Merge suspicious + failed + events into one chronological stream.
  // events already includes login + other audit types; dedupe by id.
  const seen = new Set<string>();
  const merged: TimelineItem[] = [];
  const push = (e: EventRow, severity: TimelineItem["severity"]) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    merged.push({
      id: e.id,
      eventType: e.eventType,
      severity,
      title: humanizeEvent(e),
      meta: typeof e.metadata?.summary === "string" ? e.metadata.summary : undefined,
      ip: e.ipAddress,
      device: e.deviceLabel,
      createdAt: e.createdAt,
    });
  };
  for (const e of p.suspicious) push(e, "alert");
  for (const e of p.failedLogins) push(e, "warn");
  for (const e of p.events) {
    const sev: TimelineItem["severity"] =
      e.eventType === "login_failed"
        ? "warn"
        : e.eventType === "suspicious_login"
          ? "alert"
          : e.eventType === "login"
            ? "success"
            : "info";
    push(e, sev);
  }
  merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // Cap render so very chatty accounts don't blow out the page.
  return merged.slice(0, 30);
}

function humanizeEvent(e: EventRow): string {
  switch (e.eventType) {
    case "login":
      return "Signed in successfully";
    case "login_failed":
      return "Failed sign-in attempt";
    case "suspicious_login":
      return "Suspicious sign-in flagged";
    case "logout":
      return "Signed out";
    case "session_revoked":
      return "Session revoked";
    case "password_reset_requested":
      return "Password reset requested";
    case "password_reset_consumed":
      return "Password reset completed";
    case "password_changed":
      return "Password changed";
    case "permission_granted":
      return "Permission granted";
    case "permission_revoked":
      return "Permission revoked";
    case "role_changed":
      return "Role changed";
    default:
      return e.eventType.replace(/_/g, " ");
  }
}

// ─── User-agent parsing (cheap heuristic — no external lib) ───────────

function parseUserAgent(ua: string | null): {
  label: string;
  deviceIcon: LucideIcon;
} {
  if (!ua) return { label: "Unknown device", deviceIcon: Monitor };
  const s = ua.toLowerCase();
  const isMobile = /(iphone|android.*mobile|windows phone)/.test(s);
  const isTablet = /(ipad|android(?!.*mobile))/.test(s);
  const browser =
    /edg\//.test(s)
      ? "Edge"
      : /firefox/.test(s)
        ? "Firefox"
        : /chrome/.test(s)
          ? "Chrome"
          : /safari/.test(s)
            ? "Safari"
            : "Browser";
  const os = /windows nt/.test(s)
    ? "Windows"
    : /mac os x|macintosh/.test(s)
      ? "macOS"
      : /android/.test(s)
        ? "Android"
        : /iphone|ipad|ipod/.test(s)
          ? "iOS"
          : /linux/.test(s)
            ? "Linux"
            : "Unknown OS";
  const Icon = isMobile ? Smartphone : isTablet ? Tablet : Monitor;
  return { label: `${browser} on ${os}`, deviceIcon: Icon };
}

// ─── Time formatting ──────────────────────────────────────────────────

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Silence unused-import warnings for icons reserved for future surfaces.
void LogIn;
void RefreshCw;
void TrendingUp;
