"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

type Promo = {
  id: string;
  code: string;
  description: string | null;
  kind: string;
  percentOff: number | null;
  amountOffCents: number | null;
  trialExtensionDays: number | null;
  appliesToPlan: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
};

export default function PromotionsClient({ initial }: { initial: Promo[] }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);

  return (
    <>
      <div className="mt-4 flex justify-end">
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-md bg-brand-accent px-3 py-1.5 text-sm font-medium text-white"
        >
          {creating ? "Cancel" : "+ New code"}
        </button>
      </div>
      {creating && <NewForm onCreated={() => { setCreating(false); router.refresh(); }} />}

      <div className="mt-4 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Kind</th>
              <th className="px-4 py-2">Value</th>
              <th className="px-4 py-2">Redemptions</th>
              <th className="px-4 py-2">Expires</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {initial.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-sm text-slate-500">No promotions yet — create your first code.</td></tr>
            )}
            {initial.map((p) => (
              <PromoRow key={p.id} p={p} onChanged={() => router.refresh()} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PromoRow({ p, onChanged }: { p: Promo; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await fetch(`/api/admin/promotions/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !p.active }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm(`Delete promotion ${p.code}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/promotions/${p.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const value =
    p.kind === "percent" ? `${p.percentOff}% off` :
    p.kind === "fixed" ? `$${((p.amountOffCents ?? 0) / 100).toFixed(2)} off` :
    p.kind === "trial_extension" ? `+${p.trialExtensionDays} day trial` : "—";

  return (
    <tr className="border-t">
      <td className="px-4 py-2 font-mono text-sm">{p.code}</td>
      <td className="px-4 py-2 text-xs text-ink-muted">{p.kind}</td>
      <td className="px-4 py-2">{value}</td>
      <td className="px-4 py-2 tabular-nums text-xs">
        {p.redemptionCount}{p.maxRedemptions ? ` / ${p.maxRedemptions}` : ""}
      </td>
      <td className="px-4 py-2 text-xs text-slate-500">{p.expiresAt ? p.expiresAt.slice(0, 10) : "—"}</td>
      <td className="px-4 py-2">
        <span className={`rounded-full px-2 py-0.5 text-xs ${p.active ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>
          {p.active ? "active" : "paused"}
        </span>
      </td>
      <td className="px-4 py-2 text-right text-xs">
        <button disabled={busy} onClick={toggle} className="mr-2 text-brand-accent hover:underline disabled:opacity-50">
          {p.active ? "Pause" : "Resume"}
        </button>
        <button disabled={busy} onClick={remove} className="text-red-700 hover:underline disabled:opacity-50">Delete</button>
      </td>
    </tr>
  );
}

function NewForm({ onCreated }: { onCreated: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({
    code: "",
    description: "",
    kind: "percent" as "percent" | "fixed" | "trial_extension",
    percentOff: 10,
    amountOffDollars: "5",
    trialExtensionDays: 14,
    appliesToPlan: "",
    maxRedemptions: "",
    expiresAt: "",
  });

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        code: draft.code.trim().toUpperCase(),
        description: draft.description || null,
        kind: draft.kind,
        appliesToPlan: draft.appliesToPlan || null,
        maxRedemptions: draft.maxRedemptions ? Number(draft.maxRedemptions) : null,
        expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
      };
      if (draft.kind === "percent") payload.percentOff = Number(draft.percentOff);
      if (draft.kind === "fixed") payload.amountOffCents = Math.round(parseFloat(draft.amountOffDollars || "0") * 100);
      if (draft.kind === "trial_extension") payload.trialExtensionDays = Number(draft.trialExtensionDays);

      const res = await fetch("/api/admin/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border bg-white p-5 shadow-sm ring-2 ring-brand-accent">
      <h3 className="text-base font-medium">New promotion</h3>
      <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
        <L label="Code"><input className={INPUT} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} placeholder="LAUNCH20" /></L>
        <L label="Kind">
          <select className={INPUT} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as typeof draft.kind })}>
            <option value="percent">Percent off</option>
            <option value="fixed">Fixed amount off</option>
            <option value="trial_extension">Trial extension</option>
          </select>
        </L>
        {draft.kind === "percent" && (
          <L label="% off"><input type="number" min={1} max={100} className={INPUT} value={draft.percentOff} onChange={(e) => setDraft({ ...draft, percentOff: Number(e.target.value) })} /></L>
        )}
        {draft.kind === "fixed" && (
          <L label="$ off"><input type="number" min={0} step="0.01" className={INPUT} value={draft.amountOffDollars} onChange={(e) => setDraft({ ...draft, amountOffDollars: e.target.value })} /></L>
        )}
        {draft.kind === "trial_extension" && (
          <L label="Extra trial days"><input type="number" min={1} max={365} className={INPUT} value={draft.trialExtensionDays} onChange={(e) => setDraft({ ...draft, trialExtensionDays: Number(e.target.value) })} /></L>
        )}
        <L label="Limit applicability to plan (optional)">
          <select className={INPUT} value={draft.appliesToPlan} onChange={(e) => setDraft({ ...draft, appliesToPlan: e.target.value })}>
            <option value="">Any plan</option>
            <option value="free">free</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        </L>
        <L label="Max redemptions (blank = ∞)"><input type="number" min={1} className={INPUT} value={draft.maxRedemptions} onChange={(e) => setDraft({ ...draft, maxRedemptions: e.target.value })} /></L>
        <L label="Expires at (optional)"><input type="datetime-local" className={INPUT} value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} /></L>
        <L label="Description"><input className={INPUT} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Q2 launch promo" /></L>
      </div>
      {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}
      <div className="mt-4 flex gap-2 text-sm">
        <button disabled={busy || !draft.code} onClick={submit} className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">Create</button>
      </div>
    </div>
  );
}

const INPUT = "w-full rounded-md border border-border bg-white px-3 py-1.5";

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase text-ink-subtle">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
