"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type Op =
  | { op: "suspend" }
  | { op: "reactivate" }
  | { op: "plan_override"; plan: string }
  | { op: "extend_trial"; days: number };

export default function TenantActions({
  tenantId,
  active,
  currentPlan,
  planOptions,
}: {
  tenantId: string;
  active: boolean;
  currentPlan: string;
  planOptions: { slug: string; name: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState(currentPlan);
  const [days, setDays] = React.useState(14);

  async function call(body: Op) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        {active ? (
          <button
            disabled={busy}
            onClick={() => {
              if (confirm("Suspend this tenant? Users will be locked out.")) call({ op: "suspend" });
            }}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Suspend tenant
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => call({ op: "reactivate" })}
            className="rounded-md bg-green-600 px-3 py-1.5 font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Reactivate tenant
          </button>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div>
          <label className="block text-xs uppercase text-ink-subtle">Plan override</label>
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="mt-1 rounded-md border border-border bg-white px-3 py-1.5"
          >
            {planOptions.map((p) => (
              <option key={p.slug} value={p.slug}>{p.name} ({p.slug})</option>
            ))}
          </select>
        </div>
        <button
          disabled={busy || plan === currentPlan}
          onClick={() => call({ op: "plan_override", plan })}
          className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          Apply
        </button>
      </div>

      <div className="flex items-end gap-2">
        <div>
          <label className="block text-xs uppercase text-ink-subtle">Extend trial</label>
          <input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 0)))}
            className="mt-1 w-24 rounded-md border border-border bg-white px-3 py-1.5"
          />
        </div>
        <span className="pb-2 text-xs text-ink-muted">days</span>
        <button
          disabled={busy}
          onClick={() => call({ op: "extend_trial", days })}
          className="rounded-md border border-border bg-white px-3 py-1.5 font-medium hover:bg-surface-subtle disabled:opacity-50"
        >
          Extend
        </button>
      </div>

      {err && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}
    </div>
  );
}
