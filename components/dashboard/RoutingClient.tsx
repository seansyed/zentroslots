"use client";

import * as React from "react";

import { Badge, Button, Card, Skeleton, toast } from "@/components/ui/primitives";

type Mode = "manual" | "round_robin" | "least_busy" | "priority" | "weighted";

const MODES: { value: Mode; label: string; description: string }[] = [
  {
    value: "manual",
    label: "Manual",
    description: "Customer picks the staff member. No automatic routing.",
  },
  {
    value: "round_robin",
    label: "Round robin",
    description: "Cycle through eligible staff in order of who was assigned longest ago.",
  },
  {
    value: "least_busy",
    label: "Least busy",
    description: "Pick the eligible staff member with the fewest assignments today.",
  },
  {
    value: "priority",
    label: "Priority",
    description: "Try staff in a fixed order; first eligible wins.",
  },
  {
    value: "weighted",
    label: "Weighted",
    description: "Distribute by percentage. Tracks long-term fairness with deficit correction.",
  },
];

type Rule = {
  id: string;
  serviceId: string | null;
  locationId: string | null;
  mode: Mode;
  enabled: boolean;
  priorityOrder: string[];
  weightedDistribution: Record<string, number>;
  createdAt: string;
  updatedAt: string;
};

type Service = { id: string; name: string; slug: string };
type Staff = { id: string; name: string; email: string; role: string };

type StatsRow = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  totalAssignments: number;
  assignmentsToday: number;
  assignmentsThisWeek: number;
  lastAssignedAt: string | null;
};

export default function RoutingClient() {
  const [loading, setLoading] = React.useState(true);
  const [tenantDefault, setTenantDefault] = React.useState<Rule | null>(null);
  const [serviceRules, setServiceRules] = React.useState<Rule[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [staff, setStaff] = React.useState<Staff[]>([]);
  const [stats, setStats] = React.useState<StatsRow[]>([]);
  const [activeScope, setActiveScope] = React.useState<string | null>(null); // null = tenant default

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, statsRes] = await Promise.all([
        fetch("/api/tenant/routing-rules", { cache: "no-store" }),
        fetch("/api/tenant/routing-stats", { cache: "no-store" }),
      ]);
      if (rulesRes.ok) {
        const data = await rulesRes.json();
        setTenantDefault(data.tenantDefault);
        setServiceRules(data.serviceRules);
        setServices(data.services);
        setStaff(data.staff);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const activeRule = activeScope === null
    ? tenantDefault
    : serviceRules.find((r) => r.serviceId === activeScope) ?? null;
  const activeService = activeScope ? services.find((s) => s.id === activeScope) ?? null : null;

  return (
    <div className="mt-6 space-y-8">
      {/* SCOPE PICKER — Tenant default + services list */}
      <section>
        <h2 className="text-sm font-semibold text-ink">Routing scope</h2>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <button
            onClick={() => setActiveScope(null)}
            className={
              "rounded-md border px-3 py-1.5 transition " +
              (activeScope === null
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")
            }
          >
            Tenant default
            {tenantDefault && tenantDefault.enabled && tenantDefault.mode !== "manual" && (
              <span className="ml-2 rounded-full bg-violet-500 px-1.5 text-[10px] font-medium text-white">●</span>
            )}
          </button>
          <span className="mx-1 text-slate-300">|</span>
          {loading && services.length === 0 ? (
            <Skeleton className="h-8 w-32 rounded-md" />
          ) : (
            services.map((s) => {
              const hasRule = serviceRules.some((r) => r.serviceId === s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveScope(s.id)}
                  className={
                    "rounded-md border px-3 py-1.5 transition " +
                    (activeScope === s.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : hasRule
                        ? "border-violet-300 bg-violet-50 text-violet-900 hover:bg-violet-100"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")
                  }
                >
                  {s.name}
                  {hasRule && (
                    <span className="ml-1.5 text-[10px] opacity-60">●</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* RULE EDITOR */}
      <RuleEditor
        key={activeScope ?? "tenant"}
        scope={activeScope === null ? "tenant" : "service"}
        serviceId={activeScope}
        serviceName={activeService?.name ?? null}
        rule={activeRule}
        staff={staff}
        onSaved={refresh}
      />

      {/* ANALYTICS STRIPE */}
      <section>
        <h2 className="text-sm font-semibold text-ink">Staff assignment stats</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Aggregated across all routing modes. Stats are written after
          a successful booking when the engine made the pick.
        </p>
        <Card className="mt-3 overflow-hidden p-0">
          {stats.length === 0 ? (
            <div className="p-6 text-center text-sm text-ink-muted">No routing activity yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2">Today</th>
                  <th className="px-3 py-2">Week</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Last assigned</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((r) => (
                  <tr key={r.staffId} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <div className="text-ink">{r.staffName}</div>
                      <div className="text-[11px] text-ink-subtle">{r.staffEmail}</div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.assignmentsToday}</td>
                    <td className="px-3 py-2 tabular-nums">{r.assignmentsThisWeek}</td>
                    <td className="px-3 py-2 tabular-nums">{r.totalAssignments}</td>
                    <td className="px-3 py-2 text-xs text-ink-muted">
                      {r.lastAssignedAt ? timeAgo(r.lastAssignedAt) : "never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}

function RuleEditor({
  scope,
  serviceId,
  serviceName,
  rule,
  staff,
  onSaved,
}: {
  scope: "tenant" | "service";
  serviceId: string | null;
  serviceName: string | null;
  rule: Rule | null;
  staff: Staff[];
  onSaved: () => void;
}) {
  const [mode, setMode] = React.useState<Mode>(rule?.mode ?? "manual");
  const [enabled, setEnabled] = React.useState<boolean>(rule?.enabled ?? true);
  const [priority, setPriority] = React.useState<string[]>(rule?.priorityOrder ?? []);
  const [weights, setWeights] = React.useState<Record<string, number>>(rule?.weightedDistribution ?? {});
  const [saving, setSaving] = React.useState(false);

  // Re-sync local state when the rule changes from above (scope switch).
  React.useEffect(() => {
    setMode(rule?.mode ?? "manual");
    setEnabled(rule?.enabled ?? true);
    setPriority(rule?.priorityOrder ?? []);
    setWeights(rule?.weightedDistribution ?? {});
  }, [rule]);

  const eligibleStaff = React.useMemo(
    () => staff.filter((s) => s.role !== "client"),
    [staff]
  );

  function movePriority(idx: number, dir: -1 | 1) {
    setPriority((cur) => {
      const next = [...cur];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return cur;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  function addToPriority(staffId: string) {
    setPriority((cur) => (cur.includes(staffId) ? cur : [...cur, staffId]));
  }

  function removeFromPriority(staffId: string) {
    setPriority((cur) => cur.filter((id) => id !== staffId));
  }

  function setWeight(staffId: string, value: number) {
    setWeights((cur) => {
      const next = { ...cur };
      if (value <= 0) delete next[staffId];
      else next[staffId] = Math.min(100, Math.max(0, value));
      return next;
    });
  }

  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/routing-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          mode,
          enabled,
          priorityOrder: priority,
          weightedDistribution: weights,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast("Routing saved", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (!confirm(scope === "tenant" ? "Remove tenant default? Falls back to legacy round-robin." : "Remove rule for this service? Inherits tenant default or legacy round-robin.")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tenant/routing-rules?id=${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Rule removed", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Remove failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              {scope === "tenant" ? "Tenant default" : `Override · ${serviceName ?? "service"}`}
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {scope === "tenant"
                ? "Applies to every service that doesn't have its own override."
                : "Only applies to bookings for this service. Falls back to tenant default if removed."}
            </p>
          </div>
          {rule && (
            <span className="text-[11px] text-ink-subtle">
              Updated {new Date(rule.updatedAt).toLocaleString()}
            </span>
          )}
        </div>

        {/* Mode picker */}
        <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={
                "rounded-lg border p-3 text-left transition " +
                (mode === m.value
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300")
              }
            >
              <div className="text-sm font-semibold">{m.label}</div>
              <div className={"mt-1 text-[11px] " + (mode === m.value ? "text-slate-300" : "text-ink-muted")}>
                {m.description}
              </div>
            </button>
          ))}
        </div>

        {/* Enabled toggle */}
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
          <span className="text-xs text-ink-muted">
            (when disabled, this rule is ignored — caller falls back to a more general rule, or to legacy)
          </span>
        </label>

        {/* Mode-specific config */}
        {mode === "priority" && (
          <div className="mt-5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Priority order
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              The first eligible staff wins. Use the arrows to reorder.
            </p>
            <ul className="mt-2 space-y-1.5">
              {priority.map((staffId, idx) => {
                const s = eligibleStaff.find((x) => x.id === staffId);
                return (
                  <li key={staffId} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm">
                    <span className="w-6 text-center text-xs text-slate-500">{idx + 1}.</span>
                    <span className="flex-1">{s?.name ?? "(unknown staff)"}</span>
                    <button
                      onClick={() => movePriority(idx, -1)}
                      disabled={idx === 0}
                      className="text-xs text-slate-500 hover:text-slate-900 disabled:opacity-30"
                      title="Move up"
                    >↑</button>
                    <button
                      onClick={() => movePriority(idx, 1)}
                      disabled={idx === priority.length - 1}
                      className="text-xs text-slate-500 hover:text-slate-900 disabled:opacity-30"
                      title="Move down"
                    >↓</button>
                    <button
                      onClick={() => removeFromPriority(staffId)}
                      className="text-xs text-red-500 hover:text-red-700"
                      title="Remove"
                    >×</button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2">
              <select
                onChange={(e) => {
                  if (e.target.value) addToPriority(e.target.value);
                  e.target.value = "";
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
                defaultValue=""
              >
                <option value="">+ add staff to list</option>
                {eligibleStaff
                  .filter((s) => !priority.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
              </select>
            </div>
          </div>
        )}

        {mode === "weighted" && (
          <div className="mt-5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Weighted distribution
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              Long-term share per staff (0–100%). Sum doesn&apos;t have to be 100;
              the engine normalizes. Deficit correction keeps actual
              shares close to target.
            </p>
            <ul className="mt-2 space-y-1.5">
              {eligibleStaff.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm">
                  <span className="flex-1">{s.name}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={weights[s.id] ?? 0}
                    onChange={(e) => setWeight(s.id, Number(e.target.value))}
                    className="w-20 rounded-md border border-slate-300 px-2 py-1 text-right text-sm tabular-nums"
                  />
                  <span className="text-xs text-ink-muted">%</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-[11px] text-ink-subtle">
              Sum: {weightSum}%{weightSum !== 100 && weightSum > 0 && " (will be normalized)"}
            </div>
          </div>
        )}

        {/* Routing preview */}
        <div className="mt-5 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
          <div className="font-semibold text-ink">Preview</div>
          <div className="mt-1 text-ink-muted">
            {mode === "manual" && "Customer picks the staff member."}
            {mode === "round_robin" && "Engine picks the eligible staff with the OLDEST last-assigned time."}
            {mode === "least_busy" && "Engine picks the eligible staff with the FEWEST assignments today."}
            {mode === "priority" && priority.length > 0 && (
              <>Engine tries: {priority.map((id) => eligibleStaff.find((s) => s.id === id)?.name).filter(Boolean).join(" → ")}</>
            )}
            {mode === "priority" && priority.length === 0 && "Add at least one staff to the priority list."}
            {mode === "weighted" && Object.keys(weights).length > 0 && (
              <>Weighted random with deficit correction over: {Object.entries(weights).map(([id, w]) => `${eligibleStaff.find((s) => s.id === id)?.name ?? "?"} ${w}%`).join(", ")}</>
            )}
            {mode === "weighted" && Object.keys(weights).length === 0 && "Set at least one staff weight."}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          {rule && (
            <button
              onClick={remove}
              disabled={saving}
              className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              Remove rule
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <Badge tone={enabled ? "green" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : rule ? "Save changes" : "Create rule"}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
