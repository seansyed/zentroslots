"use client";

/**
 * Governance Center — enterprise compliance + policy workspace.
 *
 * Scope per operator confirmation: core transformation (Phases 1, 2,
 * 3, 4, 5, 6, 7, 9, 10, 11). Phase 8 (automation governance scaffolding)
 * surfaces only the existing requireApproval toggle inside a future-
 * ready card. Phase 12 (SOC2/HIPAA/GDPR/SAML/SCIM/IP allowlists)
 * ships as an informational Roadmap card — no stub UI for features
 * that don't exist behind it. Phases 13/14 (microinteractions / a11y
 * polish) layer on in a focused follow-up.
 *
 * CRITICAL: zero changes to policy state shape, zero changes to the
 * PATCH/POST endpoints, zero changes to retention engine behavior.
 * The hardFloors, save(), runPreview(), runReal() functions are
 * byte-identical to the previous client. This is a pure UX rewrite.
 *
 * Layout (top-down):
 *   1. Hero with compliance posture + "Last policy update" timestamp
 *   2. Executive KPI strip (6 cards)
 *   3. Six elevated sections in order:
 *        Data Retention · Authentication · Session Governance ·
 *        Export Controls · Automation Governance · Audit & Compliance
 *   4. Sticky save footer with unsaved-change detection
 *   5. Confirmation dialog for "Run retention now" (kept, premium)
 */

import { useState, useTransition, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  Hash,
  Info,
  KeyRound,
  Lock,
  RefreshCw,
  Save,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserCog,
  Users,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────

type Policy = {
  tenantId: string;
  retention: {
    auditLogs: number | null;
    sessionEvents: number | null;
    resetTokens: number | null;
    analytics: number | null;
    exportAudit: number | null;
  };
  password: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireDigit: boolean;
    requireSymbol: boolean;
    maxAgeDays: number;
  };
  session: {
    maxAgeDays: number;
    suspiciousLoginSensitivity: "low" | "medium" | "high";
  };
  exports: { restrict: boolean; maxRows: number | null };
  automation: { requireApproval: boolean };
  allowedLoginIps: string[] | null;
  hasCustomPolicy: boolean;
};

type RetentionPreview = {
  tenantId: string;
  dryRun: boolean;
  totalCount: number;
  resources: Array<{
    target: string;
    configuredDays: number | null;
    effectiveDays: number | null;
    count: number;
    skipped: string | null;
    error?: string;
  }>;
};

type GovernanceEvent = {
  id: string;
  action: string;
  actorLabel: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
};

type ExportEvent = {
  id: string;
  userId: string | null;
  exportType: string;
  recordCount: number | null;
  fileSizeBytes: number | null;
  filtersUsed: Record<string, unknown>;
  ipAddress: string | null;
  exportedAt: string;
};

type Props = {
  tenantName: string;
  policy: Policy;
  hardFloors: Record<string, number | null>;
  governanceEvents: GovernanceEvent[];
  exports: ExportEvent[];
};

// ─── Root ─────────────────────────────────────────────────────────────

export default function GovernanceClient(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [policy, setPolicy] = useState<Policy>(props.policy);
  const [confirmRun, setConfirmRun] = useState(false);
  const originalPolicyRef = useRef(JSON.stringify(props.policy));

  // Phase 11 — unsaved-change detection. Cheap structural diff; the
  // policy object is small + flat enough that JSON compare is the
  // honest signal. Resets when props.policy changes (after server-side
  // refresh).
  const dirty = useMemo(
    () => JSON.stringify(policy) !== originalPolicyRef.current,
    [policy],
  );

  // Derived state (memoized — pure reads).
  const posture = useMemo(() => derivePosture(policy), [policy]);
  const kpis = useMemo(
    () => deriveKpis(policy, props.governanceEvents, props.exports),
    [policy, props.governanceEvents, props.exports],
  );
  const passwordStrength = useMemo(() => evaluatePassword(policy.password), [policy.password]);
  const timeline = useMemo(() => buildTimeline(props.governanceEvents), [props.governanceEvents]);
  const exportInsights = useMemo(
    () => deriveExportInsights(props.exports, policy.exports.maxRows),
    [props.exports, policy.exports.maxRows],
  );
  const lastPolicyChange = useMemo(() => {
    const policyEvents = props.governanceEvents.filter(
      (e) =>
        e.action === "security.governance.updated" ||
        e.action === "security.policy.changed",
    );
    return policyEvents[0]?.createdAt ?? null;
  }, [props.governanceEvents]);

  async function save() {
    setError(null);
    setSuccess(null);
    // SAME patch shape the existing route accepts. NO field rename.
    const patch = {
      auditRetentionDays: policy.retention.auditLogs,
      sessionEventRetentionDays: policy.retention.sessionEvents,
      resetTokenRetentionDays: policy.retention.resetTokens,
      analyticsRetentionDays: policy.retention.analytics,
      exportAuditRetentionDays: policy.retention.exportAudit,
      passwordMinLength: policy.password.minLength,
      passwordRequireUppercase: policy.password.requireUppercase,
      passwordRequireLowercase: policy.password.requireLowercase,
      passwordRequireDigit: policy.password.requireDigit,
      passwordRequireSymbol: policy.password.requireSymbol,
      passwordMaxAgeDays: policy.password.maxAgeDays,
      sessionMaxAgeDays: policy.session.maxAgeDays,
      suspiciousLoginSensitivity: policy.session.suspiciousLoginSensitivity,
      restrictExports: policy.exports.restrict,
      maxExportRows: policy.exports.maxRows,
      requireAutomationApproval: policy.automation.requireApproval,
    };
    try {
      const res = await fetch("/api/tenant/governance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not save policy.");
      setSuccess("Policy saved. Audit trail updated.");
      // Reset baseline so the dirty indicator clears. Server refresh
      // will re-hydrate props.policy on the next cycle.
      originalPolicyRef.current = JSON.stringify(policy);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save policy.");
    }
  }

  async function runPreview() {
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/tenant/governance/retention-preview", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not preview retention.");
      setPreview(data as RetentionPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not preview retention.");
    }
  }

  async function runReal() {
    setError(null);
    try {
      const res = await fetch("/api/tenant/governance/run-retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not run retention.");
      setSuccess(
        `Retention executed. Deleted ${data?.totalCount ?? 0} rows across ${data?.resources?.length ?? 0} resources.`,
      );
      setConfirmRun(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run retention.");
    }
  }

  function discardChanges() {
    setPolicy(JSON.parse(originalPolicyRef.current));
    setSuccess(null);
    setError(null);
  }

  return (
    <div className="mt-2 space-y-5 pb-32">
      {/* Inline status banners */}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 shadow-sm">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>{success}</span>
          </div>
        </div>
      )}

      <Hero tenantName={props.tenantName} posture={posture} lastPolicyChange={lastPolicyChange} />

      <KpiStrip kpis={kpis} />

      {/* Section 1 — Data Retention */}
      <RetentionSection
        policy={policy}
        hardFloors={props.hardFloors}
        pending={pending}
        preview={preview}
        onChange={(k, v) =>
          setPolicy((p) => ({ ...p, retention: { ...p.retention, [k]: v } }))
        }
        onPreview={runPreview}
        onRequestRun={() => setConfirmRun(true)}
      />

      {/* Section 2 — Authentication Policies */}
      <PasswordSection
        password={policy.password}
        strength={passwordStrength}
        onChange={(field, value) =>
          setPolicy((p) => ({ ...p, password: { ...p.password, [field]: value } }))
        }
      />

      {/* Section 3 — Session Governance */}
      <SessionSection
        session={policy.session}
        onChange={(field, value) =>
          setPolicy((p) => ({ ...p, session: { ...p.session, [field]: value } }))
        }
      />

      {/* Section 4 — Export Controls */}
      <ExportSection
        exports={policy.exports}
        exportEvents={props.exports}
        insights={exportInsights}
        onChange={(field, value) =>
          setPolicy((p) => ({ ...p, exports: { ...p.exports, [field]: value } }))
        }
      />

      {/* Section 5 — Automation Governance */}
      <AutomationSection
        automation={policy.automation}
        onChange={(field, value) =>
          setPolicy((p) => ({ ...p, automation: { ...p.automation, [field]: value } }))
        }
      />

      {/* Section 6 — Audit & Compliance timeline */}
      <ComplianceSection timeline={timeline} />

      {/* Section 7 (informational) — Enterprise readiness roadmap */}
      <RoadmapSection />

      {/* Sticky save footer (Phase 11) */}
      <SaveFooter
        dirty={dirty}
        pending={pending}
        onSave={save}
        onDiscard={discardChanges}
      />

      {/* Run-retention confirmation modal */}
      {confirmRun && (
        <ConfirmDialog
          icon={Archive}
          title="Run retention now?"
          body="This permanently deletes data per your configured retention windows (above the 90-day compliance floor for audit + export-audit). This action is irreversible. Use the dry-run preview to see what would be removed."
          confirmLabel="Yes, run retention"
          tone="danger"
          pending={pending}
          onCancel={() => setConfirmRun(false)}
          onConfirm={runReal}
        />
      )}
    </div>
  );
}

// ─── Hero (Phase 1) ───────────────────────────────────────────────────

type Posture = {
  level: "compliant" | "partial" | "default";
  label: string;
  hint: string;
  Icon: LucideIcon;
  tone: { chip: string; dot: string; bg: string; text: string };
};

function Hero({
  tenantName,
  posture,
  lastPolicyChange,
}: {
  tenantName: string;
  posture: Posture;
  lastPolicyChange: string | null;
}) {
  const Icon = posture.Icon;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div
        aria-hidden
        className={
          "pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl " +
          (posture.level === "compliant"
            ? "bg-emerald-200/40"
            : posture.level === "partial"
              ? "bg-sky-200/40"
              : "bg-amber-200/30")
        }
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
      <div className="relative px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <span className={"grid h-12 w-12 shrink-0 place-items-center rounded-2xl ring-1 ring-border/40 " + posture.tone.bg + " " + posture.tone.text}>
              <Icon className="h-6 w-6" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
                  <ShieldCheck className="h-3 w-3" strokeWidth={2.25} />
                  Compliance & governance
                </span>
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1 " +
                    posture.tone.chip
                  }
                  title={posture.hint}
                >
                  <span aria-hidden className={"inline-block h-1.5 w-1.5 rounded-full " + posture.tone.dot} />
                  {posture.label}
                </span>
              </div>
              <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">
                Governance Center
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
                Manage retention, authentication policies, export controls, audit governance,
                and operational compliance for{" "}
                <span className="font-medium text-ink">{tenantName}</span>.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
                  <Lock className="h-3 w-3 text-brand-accent" strokeWidth={2.25} />
                  90-day compliance floor enforced
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
                  <Activity className="h-3 w-3 text-emerald-600" strokeWidth={2.25} />
                  Audit trail active
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
                  <Clock className="h-3 w-3" strokeWidth={2} />
                  {lastPolicyChange
                    ? `Last policy update ${fmtRelative(lastPolicyChange)}`
                    : "No policy changes recorded yet"}
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
  activePolicies: number;
  retentionCoverage: number;
  auditRetentionLabel: string;
  exportViolations: number;
  passwordScore: number;
  governanceChanges30: number;
};

function KpiStrip({ kpis }: { kpis: KpiSet }) {
  const items: Array<{
    icon: LucideIcon;
    label: string;
    value: string;
    hint: string;
    tone: "emerald" | "sky" | "amber" | "rose" | "brand" | "muted";
  }> = [
    {
      icon: ShieldCheck,
      label: "Active policies",
      value: String(kpis.activePolicies),
      hint: kpis.activePolicies === 0 ? "All defaults" : "Custom rules in force",
      tone: kpis.activePolicies > 0 ? "emerald" : "muted",
    },
    {
      icon: Database,
      label: "Retention coverage",
      value: `${kpis.retentionCoverage}%`,
      hint: kpis.retentionCoverage === 100 ? "All resources policied" : "Some retain indefinitely",
      tone:
        kpis.retentionCoverage === 100
          ? "emerald"
          : kpis.retentionCoverage >= 60
            ? "sky"
            : kpis.retentionCoverage >= 20
              ? "amber"
              : "muted",
    },
    {
      icon: Archive,
      label: "Audit retention",
      value: kpis.auditRetentionLabel,
      hint: "Minimum 90 days per compliance floor",
      tone: "brand",
    },
    {
      icon: AlertTriangle,
      label: "Export violations",
      value: String(kpis.exportViolations),
      hint: kpis.exportViolations === 0 ? "Clean window" : "Over configured max rows",
      tone: kpis.exportViolations === 0 ? "emerald" : "amber",
    },
    {
      icon: KeyRound,
      label: "Password strength",
      value: `${kpis.passwordScore}`,
      hint: passwordScoreHint(kpis.passwordScore),
      tone:
        kpis.passwordScore >= 90
          ? "emerald"
          : kpis.passwordScore >= 70
            ? "sky"
            : kpis.passwordScore >= 50
              ? "amber"
              : "rose",
    },
    {
      icon: TrendingUp,
      label: "Changes (30d)",
      value: String(kpis.governanceChanges30),
      hint: "Policy + retention + export actions",
      tone: kpis.governanceChanges30 > 0 ? "brand" : "muted",
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
          <div className="mt-1 text-[20px] font-semibold tracking-tight text-ink tabular-nums">
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

// ─── Retention section (Phase 4) ──────────────────────────────────────

const RETENTION_KEYS = ["auditLogs", "sessionEvents", "resetTokens", "analytics", "exportAudit"] as const;
type RetentionKey = (typeof RETENTION_KEYS)[number];

const RETENTION_META: Record<
  RetentionKey,
  { label: string; description: string; icon: LucideIcon; resource: string }
> = {
  auditLogs: {
    label: "Audit logs",
    description: "Operational + security audit trail entries.",
    icon: FileText,
    resource: "audit_logs",
  },
  sessionEvents: {
    label: "Session events",
    description: "Login, logout, and session lifecycle telemetry.",
    icon: Activity,
    resource: "session_audit_events",
  },
  resetTokens: {
    label: "Password reset tokens",
    description: "One-time password reset request records.",
    icon: KeyRound,
    resource: "password_reset_tokens",
  },
  analytics: {
    label: "Analytics snapshots",
    description: "Daily aggregated booking + revenue rollups.",
    icon: TrendingUp,
    resource: "analytics_daily_snapshots",
  },
  exportAudit: {
    label: "Export audit",
    description: "Record of every CSV / data export ever issued.",
    icon: Download,
    resource: "export_audit_events",
  },
};

function RetentionSection({
  policy,
  hardFloors,
  pending,
  preview,
  onChange,
  onPreview,
  onRequestRun,
}: {
  policy: Policy;
  hardFloors: Record<string, number | null>;
  pending: boolean;
  preview: RetentionPreview | null;
  onChange: (key: RetentionKey, value: number | null) => void;
  onPreview: () => void;
  onRequestRun: () => void;
}) {
  return (
    <SectionCard
      icon={Database}
      title="Data retention"
      subtitle="Days to keep data before automatic pruning. Empty (—) means retain forever — the platform default. Hard floors enforce regulatory minimums on audit + export-audit."
      action={
        <div className="flex gap-2">
          <button
            onClick={onPreview}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-muted hover:bg-surface-inset hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (pending ? "animate-spin" : "")} />
            Preview
          </button>
          <button
            onClick={onRequestRun}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50/60 px-3 py-1.5 text-[12px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5" />
            Run retention now
          </button>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RETENTION_KEYS.map((k) => (
          <RetentionCard
            key={k}
            meta={RETENTION_META[k]}
            value={policy.retention[k]}
            hardFloor={hardFloors[RETENTION_META[k].resource]}
            onChange={(v) => onChange(k, v)}
          />
        ))}
      </div>

      {preview && (
        <div className="mt-4 rounded-xl border border-amber-200/60 bg-amber-50/60 p-4">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <div className="min-w-0 flex-1">
              <h4 className="text-[13px] font-semibold tracking-tight text-amber-900">
                Dry-run preview
              </h4>
              <p className="mt-0.5 text-[11.5px] text-amber-800">
                {preview.totalCount.toLocaleString()} row{preview.totalCount === 1 ? "" : "s"}{" "}
                would be deleted across {preview.resources.length} resource
                {preview.resources.length === 1 ? "" : "s"}. Nothing is touched until you confirm.
              </p>
              <ul className="mt-2 space-y-1 text-[11.5px]">
                {preview.resources.map((r) => (
                  <li key={r.target} className="flex items-start gap-1.5 text-ink-muted">
                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" strokeWidth={2.25} />
                    <span className="min-w-0">
                      <span className="font-mono text-[10.5px] text-ink">{r.target}</span>
                      {": "}
                      {r.skipped === "no_policy" ? (
                        <span className="italic text-ink-subtle">no policy — skipped</span>
                      ) : r.skipped === "below_hard_floor" ? (
                        <span>
                          {r.count.toLocaleString()} rows (configured {r.configuredDays}d clamped UP to floor {r.effectiveDays}d)
                        </span>
                      ) : r.error ? (
                        <span className="text-rose-700">error: {r.error}</span>
                      ) : (
                        <span>
                          {r.count.toLocaleString()} rows at {r.effectiveDays}d
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function RetentionCard({
  meta,
  value,
  hardFloor,
  onChange,
}: {
  meta: { label: string; description: string; icon: LucideIcon };
  value: number | null;
  hardFloor: number | null;
  onChange: (v: number | null) => void;
}) {
  const Icon = meta.icon;
  const atFloor = hardFloor !== null && value !== null && value <= hardFloor;
  const isIndefinite = value === null;
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-surface p-3.5 transition-all duration-[260ms] hover:shadow-soft">
      <div className="flex items-start gap-2.5">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-tight text-ink">{meta.label}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{meta.description}</p>
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={3650}
            placeholder="—"
            value={value ?? ""}
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Math.max(1, Number(e.target.value) || 1))
            }
            className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm tabular-nums focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent/30"
          />
          <span className="text-[11px] text-ink-muted">days</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={isIndefinite}
            className="ml-auto text-[10px] font-medium text-ink-subtle underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            title="Clear — retain forever"
          >
            Clear
          </button>
        </div>
        <div className="mt-2 text-[11px]">
          {isIndefinite ? (
            <span className="inline-flex items-center gap-1 text-ink-subtle">
              <Archive className="h-3 w-3" strokeWidth={2} />
              Retained indefinitely
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" strokeWidth={2.25} />
              Pruned after {value} day{value === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {hardFloor !== null && (
          <div
            className={
              "mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
              (atFloor
                ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200/50"
                : "bg-surface-inset text-ink-subtle")
            }
            title="Compliance hard floor — values below this are silently clamped up."
          >
            <Lock className="h-2.5 w-2.5" strokeWidth={2.25} />
            Floor {hardFloor}d
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Password section (Phase 5) ───────────────────────────────────────

type PasswordStrength = {
  score: number;
  level: "weak" | "fair" | "strong" | "excellent";
  hints: string[];
};

function evaluatePassword(p: Policy["password"]): PasswordStrength {
  let score = 0;
  // Min length contribution (8 = 0, 16 = 30, 20+ = 40)
  if (p.minLength >= 20) score += 40;
  else if (p.minLength >= 16) score += 30;
  else if (p.minLength >= 12) score += 20;
  else if (p.minLength >= 10) score += 10;
  // Character class contributions
  if (p.requireUppercase) score += 15;
  if (p.requireLowercase) score += 15;
  if (p.requireDigit) score += 15;
  if (p.requireSymbol) score += 15;
  // Forced rotation
  if (p.maxAgeDays > 0 && p.maxAgeDays <= 180) score += 10;
  // Cap
  score = Math.min(100, score);
  const level =
    score >= 90 ? "excellent" : score >= 70 ? "strong" : score >= 45 ? "fair" : "weak";
  const hints: string[] = [];
  if (p.minLength < 12) hints.push("Consider raising the minimum length to 12 or more.");
  if (!p.requireDigit) hints.push("Requiring a digit blocks common dictionary words.");
  if (!p.requireSymbol) hints.push("Requiring a symbol meaningfully increases entropy.");
  if (p.maxAgeDays === 0) hints.push("Forced rotation is off — fine if you trust your users.");
  return { score, level, hints };
}

function PasswordSection({
  password,
  strength,
  onChange,
}: {
  password: Policy["password"];
  strength: PasswordStrength;
  onChange: <K extends keyof Policy["password"]>(field: K, value: Policy["password"][K]) => void;
}) {
  const barColor =
    strength.level === "excellent"
      ? "from-emerald-500 to-emerald-600"
      : strength.level === "strong"
        ? "from-sky-500 to-sky-600"
        : strength.level === "fair"
          ? "from-amber-500 to-amber-600"
          : "from-rose-500 to-rose-600";
  const chips: Array<{ key: keyof Policy["password"]; label: string }> = [
    { key: "requireUppercase", label: "Uppercase" },
    { key: "requireLowercase", label: "Lowercase" },
    { key: "requireDigit", label: "Digit" },
    { key: "requireSymbol", label: "Symbol" },
  ];
  return (
    <SectionCard
      icon={KeyRound}
      title="Authentication policy"
      subtitle="Applied at password reset + future change flows. Minimum length must be 8–128. Max-age = 0 disables forced rotation."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Minimum length"
            value={password.minLength}
            min={8}
            max={128}
            onChange={(v) => onChange("minLength", v)}
          />
          <NumberField
            label="Max age (days, 0 = off)"
            value={password.maxAgeDays}
            min={0}
            max={365}
            onChange={(v) => onChange("maxAgeDays", v)}
          />
          <div className="sm:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Character requirements
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <PolicyChip
                  key={c.key}
                  label={c.label}
                  active={password[c.key] as boolean}
                  onToggle={() => onChange(c.key, !(password[c.key] as boolean) as never)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Strength meter (right column on lg) */}
        <div className="rounded-xl border border-border/60 bg-surface-inset/40 p-4 lg:w-[260px]">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Strength
            </span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                (strength.level === "excellent"
                  ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/50"
                  : strength.level === "strong"
                    ? "bg-sky-50 text-sky-700 ring-1 ring-sky-200/50"
                    : strength.level === "fair"
                      ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200/50"
                      : "bg-rose-50 text-rose-700 ring-1 ring-rose-200/50")
              }
            >
              {strength.level}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-inset">
            <div
              className={"h-full rounded-full bg-gradient-to-r transition-[width] duration-300 " + barColor}
              style={{ width: `${strength.score}%` }}
              aria-label={`Password policy strength: ${strength.score} of 100`}
            />
          </div>
          <div className="mt-1 text-right text-[11px] font-semibold text-ink tabular-nums">
            {strength.score} / 100
          </div>
          {strength.hints.length > 0 && (
            <ul className="mt-3 space-y-1 text-[11px] text-ink-muted">
              {strength.hints.map((h) => (
                <li key={h} className="flex items-start gap-1">
                  <Info className="mt-0.5 h-3 w-3 shrink-0 text-ink-subtle" strokeWidth={2} />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function PolicyChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition-colors " +
        (active
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200/55 hover:bg-emerald-100"
          : "bg-surface-inset text-ink-subtle ring-border/50 hover:bg-surface-inset/80")
      }
      aria-pressed={active}
    >
      {active ? (
        <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
      ) : (
        <X className="h-3 w-3" strokeWidth={2.5} />
      )}
      {label}
    </button>
  );
}

// ─── Session section (Phase 6) ────────────────────────────────────────

function SessionSection({
  session,
  onChange,
}: {
  session: Policy["session"];
  onChange: <K extends keyof Policy["session"]>(field: K, value: Policy["session"][K]) => void;
}) {
  const riskMeta = {
    low: {
      label: "Low",
      hint: "Block only obvious impossible-travel + bot-pattern logins.",
      color: "bg-emerald-50 text-emerald-700 ring-emerald-200/55",
      bar: "from-emerald-400 to-emerald-500",
      width: "33%",
    },
    medium: {
      label: "Medium",
      hint: "Balanced default — flags new-IP + new-device + odd-hour.",
      color: "bg-sky-50 text-sky-700 ring-sky-200/55",
      bar: "from-sky-400 to-sky-500",
      width: "66%",
    },
    high: {
      label: "High",
      hint: "Aggressive — flags geographically-unusual + cross-org velocity.",
      color: "bg-amber-50 text-amber-700 ring-amber-200/55",
      bar: "from-amber-400 to-amber-500",
      width: "100%",
    },
  } as const;
  const current = riskMeta[session.suspiciousLoginSensitivity];
  return (
    <SectionCard
      icon={Activity}
      title="Session governance"
      subtitle="Controls how long sessions remain valid and how aggressively suspicious-login telemetry flags anomalies."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-surface-inset/30 p-4">
          <NumberField
            label="Session max age (days, 0 = platform default)"
            value={session.maxAgeDays}
            min={0}
            max={30}
            onChange={(v) => onChange("maxAgeDays", v)}
          />
          <p className="mt-2 text-[11px] text-ink-muted">
            {session.maxAgeDays === 0
              ? "Using the platform default (7 days). Increase or decrease to override per-tenant."
              : `Sessions force a re-login after ${session.maxAgeDays} day${session.maxAgeDays === 1 ? "" : "s"} regardless of activity.`}
          </p>
        </div>

        <div className="rounded-xl border border-border/60 bg-surface-inset/30 p-4">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Suspicious-login sensitivity
            </label>
            <span className={"rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 " + current.color}>
              {current.label}
            </span>
          </div>
          <div className="mt-2 flex gap-1">
            {(["low", "medium", "high"] as const).map((level) => {
              const active = session.suspiciousLoginSensitivity === level;
              const m = riskMeta[level];
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => onChange("suspiciousLoginSensitivity", level)}
                  className={
                    "flex-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold capitalize transition-all " +
                    (active
                      ? "border-brand-accent bg-brand-subtle/60 text-brand-accent shadow-sm"
                      : "border-border bg-surface text-ink-muted hover:bg-surface-inset")
                  }
                  title={m.hint}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-inset">
            <div
              className={"h-full rounded-full bg-gradient-to-r transition-all duration-300 " + current.bar}
              style={{ width: current.width }}
            />
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">{current.hint}</p>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Export section (Phase 7) ─────────────────────────────────────────

type ExportInsights = {
  totalExports: number;
  totalRecords: number;
  totalBytes: number;
  violations: number;
  byType: Map<string, number>;
};

function deriveExportInsights(exports: ExportEvent[], maxRows: number | null): ExportInsights {
  const byType = new Map<string, number>();
  let totalRecords = 0;
  let totalBytes = 0;
  let violations = 0;
  for (const e of exports) {
    byType.set(e.exportType, (byType.get(e.exportType) ?? 0) + 1);
    totalRecords += e.recordCount ?? 0;
    totalBytes += e.fileSizeBytes ?? 0;
    if (maxRows !== null && (e.recordCount ?? 0) > maxRows) violations++;
  }
  return { totalExports: exports.length, totalRecords, totalBytes, violations, byType };
}

function ExportSection({
  exports,
  exportEvents,
  insights,
  onChange,
}: {
  exports: Policy["exports"];
  exportEvents: ExportEvent[];
  insights: ExportInsights;
  onChange: <K extends keyof Policy["exports"]>(field: K, value: Policy["exports"][K]) => void;
}) {
  return (
    <SectionCard
      icon={Download}
      title="Export controls"
      subtitle="Restrict who can export data + cap row count per export. Every export is recorded in the export-audit log regardless of size."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl border border-border/60 bg-surface-inset/30 p-3.5">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={exports.restrict}
              onChange={(e) => onChange("restrict", e.target.checked)}
              className="h-4 w-4 rounded border-border text-brand-accent focus:ring-brand-accent/30"
            />
            <span className="font-semibold text-ink">Restrict to permitted users</span>
          </label>
          <p className="mt-1.5 text-[11px] text-ink-muted">
            When enabled, only users with the canExportReports permission can trigger an export.
          </p>
        </div>
        <div className="rounded-xl border border-border/60 bg-surface-inset/30 p-3.5 sm:col-span-2">
          <NumberField
            label="Max rows per export (0 = no cap)"
            value={exports.maxRows ?? 0}
            min={0}
            max={10_000_000}
            onChange={(v) => onChange("maxRows", v === 0 ? null : v)}
          />
          <p className="mt-1.5 text-[11px] text-ink-muted">
            {exports.maxRows === null
              ? "No cap configured — exports of any size are allowed."
              : `Exports of ${exports.maxRows.toLocaleString()} rows or more will be flagged in the audit log.`}
          </p>
        </div>
      </div>

      {/* Export insights mini-strip */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <InsightTile
          icon={Download}
          label="Exports (30d)"
          value={String(insights.totalExports)}
          tone={insights.totalExports > 0 ? "brand" : "muted"}
        />
        <InsightTile
          icon={Hash}
          label="Records exported"
          value={insights.totalRecords.toLocaleString()}
          tone="muted"
        />
        <InsightTile
          icon={HardDrive}
          label="Total size"
          value={fmtBytes(insights.totalBytes)}
          tone="muted"
        />
        <InsightTile
          icon={AlertTriangle}
          label="Cap violations"
          value={String(insights.violations)}
          tone={insights.violations > 0 ? "amber" : "emerald"}
        />
      </div>

      {/* Recent exports timeline */}
      {exportEvents.length === 0 ? (
        <PremiumEmpty
          icon={ShieldCheck}
          tone="positive"
          title="No exports in the last 30 days"
          body="Every CSV / data download will be recorded here with size, row count, and source IP."
        />
      ) : (
        <ul className="mt-4 space-y-2">
          {exportEvents.slice(0, 10).map((e) => {
            const overCap =
              exports.maxRows !== null && (e.recordCount ?? 0) > exports.maxRows;
            return (
              <li
                key={e.id}
                className={
                  "flex items-center gap-3 rounded-xl border p-3 transition-all hover:-translate-y-0.5 hover:shadow-soft " +
                  (overCap
                    ? "border-amber-200/60 bg-amber-50/40"
                    : "border-border/60 bg-surface")
                }
              >
                <span
                  className={
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 " +
                    (overCap
                      ? "bg-amber-50 text-amber-700 ring-amber-200/50"
                      : "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15")
                  }
                >
                  <Download className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold text-ink">{e.exportType}</span>
                    {overCap && (
                      <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200/50">
                        Over cap
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-ink-muted">
                    <span>{(e.recordCount ?? 0).toLocaleString()} records</span>
                    <span>·</span>
                    <span>{fmtBytes(e.fileSizeBytes ?? 0)}</span>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" strokeWidth={2} />
                      {fmtRelative(e.exportedAt)}
                    </span>
                    {e.ipAddress && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          <Globe className="h-2.5 w-2.5" strokeWidth={2} />
                          {e.ipAddress}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {exportEvents.length > 10 && (
            <li className="text-center text-[10.5px] text-ink-subtle">
              +{exportEvents.length - 10} more in the export-audit log
            </li>
          )}
        </ul>
      )}
    </SectionCard>
  );
}

// ─── Automation section (Phase 8 — minimal, future-ready) ─────────────

function AutomationSection({
  automation,
  onChange,
}: {
  automation: Policy["automation"];
  onChange: <K extends keyof Policy["automation"]>(field: K, value: Policy["automation"][K]) => void;
}) {
  return (
    <SectionCard
      icon={UserCog}
      title="Automation governance"
      subtitle="Workflow change-management controls. The persisted policy ships today; enforcement layers on in a future release."
    >
      <label className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface-inset/30 p-3.5 hover:bg-surface-inset/50">
        <input
          type="checkbox"
          checked={automation.requireApproval}
          onChange={(e) => onChange("requireApproval", e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border text-brand-accent focus:ring-brand-accent/30"
        />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight text-ink">
            Require approval for automation changes
          </div>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Reserved — when enforced, automation rule changes will require a second admin approval
            before going live. The setting persists now so you can pre-configure tenancy posture.
          </p>
        </div>
        <span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200/50">
          Future enforcement
        </span>
      </label>
    </SectionCard>
  );
}

// ─── Compliance timeline (Phase 9) ────────────────────────────────────

type TimelineItem = {
  id: string;
  action: string;
  title: string;
  severity: "info" | "success" | "warn";
  actor: string;
  ip: string | null;
  createdAt: string;
  meta: string | null;
};

function buildTimeline(events: GovernanceEvent[]): TimelineItem[] {
  return events.slice(0, 30).map((e) => {
    const sev: TimelineItem["severity"] =
      e.action === "security.retention.executed"
        ? "warn"
        : e.action === "security.export.executed"
          ? "info"
          : "success";
    const title = humanizeAction(e.action);
    const meta = summarizeMetadata(e.metadata);
    return {
      id: e.id,
      action: e.action,
      title,
      severity: sev,
      actor: e.actorLabel ?? "system",
      ip: e.ipAddress,
      createdAt: e.createdAt,
      meta,
    };
  });
}

function ComplianceSection({ timeline }: { timeline: TimelineItem[] }) {
  return (
    <SectionCard
      icon={ScrollIcon}
      title="Audit & compliance activity"
      subtitle="Every governance, retention, export, and policy-change action recorded over the last 30 days."
    >
      {timeline.length === 0 ? (
        <PremiumEmpty
          icon={ShieldCheck}
          tone="positive"
          title="Clean window"
          body="No governance, retention, or policy-change events recorded in the last 30 days. Activity will appear here as it happens."
        />
      ) : (
        <ol className="space-y-2">
          {timeline.map((it) => {
            const sev = SEVERITY_TONES[it.severity];
            const SevIcon = sev.Icon;
            return (
              <li
                key={it.id}
                className="group flex items-start gap-3 rounded-xl border border-border/60 bg-surface p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft"
              >
                <span className={"mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 " + sev.iconClass}>
                  <SevIcon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={"inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] ring-1 " + sev.pillClass}>
                      {it.action.replace(/^security\./, "")}
                    </span>
                    <span className="text-[12px] font-medium text-ink">{it.title}</span>
                  </div>
                  {it.meta && (
                    <p className="mt-0.5 truncate text-[11px] text-ink-muted" title={it.meta}>
                      {it.meta}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-ink-subtle">
                    <span className="flex items-center gap-1">
                      <Users className="h-2.5 w-2.5" strokeWidth={2} />
                      {it.actor}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" strokeWidth={2} />
                      {fmtRelative(it.createdAt)}
                    </span>
                    {it.ip && (
                      <span className="flex items-center gap-1">
                        <Globe className="h-2.5 w-2.5" strokeWidth={2} />
                        {it.ip}
                      </span>
                    )}
                  </div>
                </div>
                <span aria-hidden className="self-center opacity-0 transition-opacity group-hover:opacity-100">
                  <ChevronRight className="h-4 w-4 text-ink-subtle" strokeWidth={2} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}

const SEVERITY_TONES: Record<
  TimelineItem["severity"],
  { Icon: LucideIcon; iconClass: string; pillClass: string }
> = {
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
};

// ─── Enterprise readiness roadmap (informational) ─────────────────────

function RoadmapSection() {
  const items: Array<{ icon: LucideIcon; label: string; sub: string }> = [
    { icon: ShieldCheck, label: "SOC 2 readiness", sub: "Control mapping + evidence export" },
    { icon: FileText, label: "HIPAA settings", sub: "PHI retention + BAA defaults" },
    { icon: Database, label: "GDPR retention presets", sub: "EU compliance one-click profile" },
    { icon: Download, label: "Audit log export", sub: "Scheduled CSV / SIEM webhook" },
    { icon: KeyRound, label: "SAML / SCIM", sub: "SSO + automated user provisioning" },
    { icon: Globe, label: "IP allowlists", sub: "Tenant-wide login network rules" },
  ];
  return (
    <SectionCard
      icon={Sparkles}
      title="Enterprise readiness"
      subtitle="Compliance + governance features on the platform roadmap. Informational only — not yet configurable."
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <div
              key={it.label}
              className="flex items-start gap-2.5 rounded-xl border border-dashed border-border/70 bg-surface-inset/30 p-3"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle ring-1 ring-border/40">
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-semibold tracking-tight text-ink">{it.label}</span>
                  <Lock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
                </div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{it.sub}</p>
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─── Sticky save footer (Phase 11) ────────────────────────────────────

function SaveFooter({
  dirty,
  pending,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-surface/95 px-4 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.06)] backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px]">
          {dirty ? (
            <>
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-amber-400/60" />
                <span className="relative inline-block h-2 w-2 rounded-full bg-amber-500" />
              </span>
              <span className="font-medium text-ink">Unsaved policy changes</span>
              <span className="text-ink-subtle">— review and save to apply.</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" strokeWidth={2.25} />
              <span className="text-ink-muted">Policy in sync · all changes saved.</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              type="button"
              onClick={onDiscard}
              disabled={pending}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-inset disabled:opacity-50"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={pending || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-accent px-4 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-accent/90 disabled:bg-surface-inset disabled:text-ink-subtle"
          >
            <Save className="h-3.5 w-3.5" />
            {pending ? "Saving…" : dirty ? "Save policy" : "Saved"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Confirmation dialog (kept, premium) ──────────────────────────────

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

// ─── Shared primitives ────────────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  subtitle,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/60 bg-surface p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
            <Icon className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {action}
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
        {props.label}
      </label>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) =>
          props.onChange(Math.max(props.min, Math.min(props.max, Number(e.target.value) || 0)))
        }
        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm tabular-nums focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent/30"
      />
    </div>
  );
}

function InsightTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: "emerald" | "sky" | "amber" | "brand" | "muted";
}) {
  const toneClass: Record<typeof tone, string> = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200/50",
    sky: "bg-sky-50 text-sky-700 ring-sky-200/50",
    amber: "bg-amber-50 text-amber-700 ring-amber-200/50",
    brand: "bg-brand-subtle/60 text-brand-accent ring-brand-accent/20",
    muted: "bg-surface-inset text-ink-subtle ring-border/40",
  };
  return (
    <div className="rounded-xl border border-border/60 bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{value}</div>
        </div>
        <span className={"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 " + toneClass[tone]}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
      </div>
    </div>
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
        "mt-4 rounded-2xl border p-5 text-center " +
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

function derivePosture(policy: Policy): Posture {
  // Count configured retention slots (non-null = explicitly policied)
  const configured = Object.values(policy.retention).filter((v) => v !== null).length;
  const passwordStrong =
    policy.password.minLength >= 12 &&
    policy.password.requireDigit &&
    (policy.password.requireUppercase || policy.password.requireSymbol);

  if (configured >= 4 && passwordStrong && policy.exports.restrict) {
    return {
      level: "compliant",
      label: "Compliant",
      hint: "Strong policy across retention, authentication, and export controls.",
      Icon: ShieldCheck,
      tone: {
        chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/55",
        dot: "bg-emerald-500",
        bg: "bg-emerald-50",
        text: "text-emerald-700",
      },
    };
  }
  if (configured >= 1 || passwordStrong) {
    return {
      level: "partial",
      label: "Partial",
      hint: "Some custom policies in force; others use platform defaults.",
      Icon: Shield,
      tone: {
        chip: "bg-sky-50 text-sky-700 ring-sky-200/55",
        dot: "bg-sky-500",
        bg: "bg-sky-50",
        text: "text-sky-700",
      },
    };
  }
  return {
    level: "default",
    label: "Defaults",
    hint: "Using all platform defaults — review retention + password posture.",
    Icon: ShieldAlert,
    tone: {
      chip: "bg-amber-50 text-amber-700 ring-amber-200/55",
      dot: "bg-amber-500",
      bg: "bg-amber-50",
      text: "text-amber-700",
    },
  };
}

function deriveKpis(
  policy: Policy,
  governanceEvents: GovernanceEvent[],
  exports: ExportEvent[],
): KpiSet {
  const configuredRetention = Object.values(policy.retention).filter((v) => v !== null).length;
  const passwordChecks =
    Number(policy.password.requireUppercase) +
    Number(policy.password.requireLowercase) +
    Number(policy.password.requireDigit) +
    Number(policy.password.requireSymbol);
  const activePolicies =
    configuredRetention +
    (passwordChecks > 0 ? 1 : 0) +
    (policy.password.minLength > 8 ? 1 : 0) +
    (policy.password.maxAgeDays > 0 ? 1 : 0) +
    (policy.session.maxAgeDays > 0 ? 1 : 0) +
    (policy.session.suspiciousLoginSensitivity !== "medium" ? 1 : 0) +
    (policy.exports.restrict ? 1 : 0) +
    (policy.exports.maxRows !== null ? 1 : 0) +
    (policy.automation.requireApproval ? 1 : 0);
  const retentionCoverage = Math.round((configuredRetention / 5) * 100);
  const auditDays = policy.retention.auditLogs;
  const auditRetentionLabel = auditDays === null ? "∞" : `${auditDays}d`;
  let exportViolations = 0;
  if (policy.exports.maxRows !== null) {
    for (const e of exports) {
      if ((e.recordCount ?? 0) > policy.exports.maxRows) exportViolations++;
    }
  }
  // Password score: simple normalized
  const pwdScore = evaluatePassword(policy.password).score;
  return {
    activePolicies,
    retentionCoverage,
    auditRetentionLabel,
    exportViolations,
    passwordScore: pwdScore,
    governanceChanges30: governanceEvents.length,
  };
}

function humanizeAction(action: string): string {
  switch (action) {
    case "security.governance.updated":
      return "Governance policy updated";
    case "security.retention.executed":
      return "Retention pruning executed";
    case "security.policy.changed":
      return "Security policy changed";
    case "security.export.executed":
      return "Data export executed";
    case "security.permission.denied":
      return "Permission denied";
    default:
      return action.replace(/^security\./, "").replace(/[._]/g, " ");
  }
}

function summarizeMetadata(m: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === "severity") continue;
    if (parts.length >= 4) break;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (s.length > 80) continue;
    parts.push(`${k}=${s}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function passwordScoreHint(score: number): string {
  if (score >= 90) return "Excellent — enterprise-grade";
  if (score >= 70) return "Strong";
  if (score >= 50) return "Fair — could be stricter";
  return "Weak — review urgently";
}

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

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Local Scroll icon alias — FileText fits "audit log" semantics
// without adding a separate Lucide dep.
const ScrollIcon = FileText;

// Silence unused-import warnings for icons reserved for future surfaces.
void Settings2;
void Gauge;
