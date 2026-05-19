"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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

export default function GovernanceClient(props: {
  policy: Policy;
  hardFloors: Record<string, number | null>;
  governanceEvents: Array<{
    id: string;
    action: string;
    actorLabel: string | null;
    metadata: Record<string, unknown>;
    ipAddress: string | null;
    createdAt: string;
  }>;
  exports: Array<{
    id: string;
    userId: string | null;
    exportType: string;
    recordCount: number | null;
    fileSizeBytes: number | null;
    filtersUsed: Record<string, unknown>;
    ipAddress: string | null;
    exportedAt: string;
  }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);

  // Local edit state — start from the loaded policy.
  const [policy, setPolicy] = useState<Policy>(props.policy);
  const [confirmRun, setConfirmRun] = useState(false);

  async function save() {
    setError(null);
    setSuccess(null);
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
      setSuccess("Policy saved.");
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
      setSuccess(`Retention executed. Deleted ${data?.totalCount ?? 0} rows across ${data?.resources?.length ?? 0} resources.`);
      setConfirmRun(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run retention.");
    }
  }

  return (
    <div className="mt-6 space-y-8">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{success}</div>
      )}

      {/* ── Retention policies ─────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Retention policies</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Days to keep data before automatic pruning. Empty (—) = retain forever.
          Audit logs and export audit have a hard floor of 90 days.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(["auditLogs","sessionEvents","resetTokens","analytics","exportAudit"] as const).map((k) => (
            <RetentionField
              key={k}
              label={LABELS[k]}
              value={policy.retention[k]}
              hardFloor={props.hardFloors[RESOURCE_MAP[k]]}
              onChange={(v) =>
                setPolicy((p) => ({ ...p, retention: { ...p.retention, [k]: v } }))
              }
            />
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={runPreview}
            disabled={pending}
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Preview retention
          </button>
          <button
            onClick={() => setConfirmRun(true)}
            disabled={pending}
            className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Run retention now
          </button>
        </div>
        {preview && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="mb-1 font-semibold">
              Dry-run preview — {preview.totalCount} rows would be deleted across {preview.resources.length} resources.
            </div>
            <ul className="space-y-0.5">
              {preview.resources.map((r) => (
                <li key={r.target}>
                  <span className="font-mono">{r.target}</span>:{" "}
                  {r.skipped === "no_policy" ? (
                    <span className="text-slate-500">no policy — skipped</span>
                  ) : r.skipped === "below_hard_floor" ? (
                    <span>
                      {r.count} rows (configured {r.configuredDays}d clamped UP to floor {r.effectiveDays}d)
                    </span>
                  ) : r.error ? (
                    <span className="text-red-600">error: {r.error}</span>
                  ) : (
                    <span>{r.count} rows at {r.effectiveDays}d</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ── Password policy ────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Password policy</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Applied at reset + future change flows. Minimum length must be 8–128.
          Max-age = 0 disables forced rotation (current platform default).
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField
            label="Minimum length"
            value={policy.password.minLength}
            min={8}
            max={128}
            onChange={(v) => setPolicy((p) => ({ ...p, password: { ...p.password, minLength: v } }))}
          />
          <NumberField
            label="Max age (days, 0=off)"
            value={policy.password.maxAgeDays}
            min={0}
            max={365}
            onChange={(v) => setPolicy((p) => ({ ...p, password: { ...p.password, maxAgeDays: v } }))}
          />
          <BoolField label="Require uppercase" value={policy.password.requireUppercase}
            onChange={(v) => setPolicy((p) => ({ ...p, password: { ...p.password, requireUppercase: v } }))} />
          <BoolField label="Require lowercase" value={policy.password.requireLowercase}
            onChange={(v) => setPolicy((p) => ({ ...p, password: { ...p.password, requireLowercase: v } }))} />
          <BoolField label="Require digit" value={policy.password.requireDigit}
            onChange={(v) => setPolicy((p) => ({ ...p, password: { ...p.password, requireDigit: v } }))} />
          <BoolField label="Require symbol" value={policy.password.requireSymbol}
            onChange={(v) => setPolicy((p) => ({ ...p, password: { ...p.password, requireSymbol: v } }))} />
        </div>
      </section>

      {/* ── Session + suspicious login ─────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Session policy</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField
            label="Session max age (days, 0=platform default)"
            value={policy.session.maxAgeDays}
            min={0}
            max={30}
            onChange={(v) => setPolicy((p) => ({ ...p, session: { ...p.session, maxAgeDays: v } }))}
          />
          <div>
            <label className="block text-xs font-medium text-ink-muted">Suspicious-login sensitivity</label>
            <select
              value={policy.session.suspiciousLoginSensitivity}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  session: { ...p.session, suspiciousLoginSensitivity: e.target.value as Policy["session"]["suspiciousLoginSensitivity"] },
                }))
              }
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
        </div>
      </section>

      {/* ── Export governance ─────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Export governance</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <BoolField
            label="Restrict exports to permitted users"
            value={policy.exports.restrict}
            onChange={(v) => setPolicy((p) => ({ ...p, exports: { ...p.exports, restrict: v } }))}
          />
          <NumberField
            label="Max rows per export (empty=no cap)"
            value={policy.exports.maxRows ?? 0}
            min={0}
            max={10_000_000}
            onChange={(v) => setPolicy((p) => ({ ...p, exports: { ...p.exports, maxRows: v === 0 ? null : v } }))}
          />
        </div>
        {props.exports.length === 0 ? (
          <Empty>No exports recorded in the last 30 days.</Empty>
        ) : (
          <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Records</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">IP</th>
                </tr>
              </thead>
              <tbody>
                {props.exports.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{e.exportType}</td>
                    <td className="px-3 py-2 tabular-nums">{e.recordCount ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-xs">{e.fileSizeBytes ? `${Math.round(e.fileSizeBytes / 1024)} kB` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmt(e.exportedAt)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{e.ipAddress ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Automation governance ─────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Automation governance</h2>
        <BoolField
          label="Require approval for automation changes (reserved — not yet enforced)"
          value={policy.automation.requireApproval}
          onChange={(v) => setPolicy((p) => ({ ...p, automation: { ...p.automation, requireApproval: v } }))}
        />
        <p className="mt-1 text-xs text-ink-muted">
          When enforced, automation rule changes will require a second admin approval before
          they go live. The setting persists today; enforcement ships in a future phase.
        </p>
      </section>

      {/* ── Recent governance actions ─────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Recent governance actions (30 days)</h2>
        {props.governanceEvents.length === 0 ? (
          <Empty>No governance, retention, or policy-change events in the last 30 days.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Actor</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">IP</th>
                  <th className="px-3 py-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {props.governanceEvents.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                    <td className="px-3 py-2 text-xs">{e.actorLabel ?? "system"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmt(e.createdAt)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{e.ipAddress ?? "—"}</td>
                    <td className="px-3 py-2 text-[11px] text-slate-600">
                      {Object.entries(e.metadata)
                        .filter(([k]) => k !== "severity")
                        .slice(0, 4)
                        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Sticky save bar ───────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-4 border-t border-slate-200 bg-white px-4 py-3">
        <button
          onClick={save}
          disabled={pending}
          className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save policy"}
        </button>
      </div>

      {/* Run-retention confirmation modal */}
      {confirmRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-ink">Run retention now?</h3>
            <p className="mt-2 text-sm text-slate-600">
              This will permanently delete data per your configured retention windows
              (above the 90-day compliance floor for audit + export-audit). This action
              is irreversible. The dry-run preview shows what would be removed.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmRun(false)}
                className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={runReal}
                className="rounded border border-red-300 bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                Yes, run retention
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const LABELS = {
  auditLogs: "Audit logs (days)",
  sessionEvents: "Session events (days)",
  resetTokens: "Reset tokens (days)",
  analytics: "Analytics snapshots (days)",
  exportAudit: "Export audit (days)",
} as const;

const RESOURCE_MAP = {
  auditLogs: "audit_logs",
  sessionEvents: "session_audit_events",
  resetTokens: "password_reset_tokens",
  analytics: "analytics_daily_snapshots",
  exportAudit: "export_audit_events",
} as const;

function RetentionField(props: {
  label: string;
  value: number | null;
  hardFloor: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-muted">{props.label}</label>
      <input
        type="number"
        min={1}
        max={3650}
        placeholder="—"
        value={props.value ?? ""}
        onChange={(e) =>
          props.onChange(e.target.value === "" ? null : Math.max(1, Number(e.target.value) || 1))
        }
        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
      />
      {props.hardFloor !== null && (
        <div className="mt-1 text-[10px] text-amber-600">hard floor: {props.hardFloor}d</div>
      )}
    </div>
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
      <label className="block text-xs font-medium text-ink-muted">{props.label}</label>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Math.max(props.min, Math.min(props.max, Number(e.target.value) || 0)))}
        className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
      />
    </div>
  );
}

function BoolField(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={props.value}
        onChange={(e) => props.onChange(e.target.checked)}
        className="rounded border-slate-300"
      />
      <span className="text-ink-muted">{props.label}</span>
    </label>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">
      {children}
    </div>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}
