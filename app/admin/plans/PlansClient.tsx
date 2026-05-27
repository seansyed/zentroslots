"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { confirmAction } from "@/components/ui/primitives";

type PlanRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  stripePriceIdMonthly: string | null;
  stripePriceIdYearly: string | null;
  quotaStaff: number;
  quotaManagers: number;
  quotaBookingsPerMonth: number;
  quotaServices: number;
  features: string[];
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export default function PlansClient({ initialPlans }: { initialPlans: PlanRow[] }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);

  return (
    <>
      <div className="mt-4 flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="rounded-md bg-brand-accent px-3 py-1.5 text-sm font-medium text-white"
        >
          + New plan
        </button>
      </div>

      {creating && (
        <NewPlanForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {initialPlans.map((p) => (
          <PlanCard key={p.id} plan={p} onChanged={() => router.refresh()} />
        ))}
      </div>
    </>
  );
}

function PlanCard({ plan, onChanged }: { plan: PlanRow; onChanged: () => void }) {
  const [edit, setEdit] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({
    name: plan.name,
    description: plan.description ?? "",
    priceMonthlyDollars: (plan.priceMonthlyCents / 100).toFixed(2),
    priceYearlyDollars: (plan.priceYearlyCents / 100).toFixed(2),
    quotaStaff: plan.quotaStaff,
    quotaManagers: plan.quotaManagers,
    quotaBookingsPerMonth: plan.quotaBookingsPerMonth,
    quotaServices: plan.quotaServices,
    features: plan.features.join("\n"),
    active: plan.active,
  });

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description || null,
          priceMonthlyCents: Math.round(parseFloat(draft.priceMonthlyDollars || "0") * 100),
          priceYearlyCents: Math.round(parseFloat(draft.priceYearlyDollars || "0") * 100),
          quotaStaff: Number(draft.quotaStaff),
          quotaManagers: Number(draft.quotaManagers),
          quotaBookingsPerMonth: Number(draft.quotaBookingsPerMonth),
          quotaServices: Number(draft.quotaServices),
          features: draft.features.split("\n").map((s) => s.trim()).filter(Boolean),
          active: draft.active,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setEdit(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (
      !(await confirmAction({
        title: `Archive plan "${plan.name}"?`,
        body: "Tenants already on this plan stay subscribed. New signups won't see it as an option.",
        variant: "warning",
        confirmLabel: "Archive plan",
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/admin/plans/${plan.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!edit) {
    return (
      <div className={`rounded-lg border bg-white p-5 shadow-sm ${!plan.active ? "opacity-60" : ""}`}>
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-lg font-semibold">{plan.name}</div>
            <div className="text-xs text-ink-subtle"><code>{plan.slug}</code></div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">${(plan.priceMonthlyCents / 100).toFixed(0)}</div>
            <div className="text-xs text-ink-muted">/ mo</div>
          </div>
        </div>
        {plan.description && <p className="mt-2 text-sm text-ink-muted">{plan.description}</p>}
        <ul className="mt-3 space-y-1 text-sm">
          <li>• {plan.quotaStaff.toLocaleString()} staff</li>
          <li>• {plan.quotaManagers === -1 ? "Unlimited" : plan.quotaManagers.toLocaleString()} manager seats</li>
          <li>• {plan.quotaBookingsPerMonth.toLocaleString()} bookings/mo</li>
          <li>• {plan.quotaServices.toLocaleString()} services</li>
          {plan.features.map((f, i) => <li key={i}>• {f}</li>)}
        </ul>
        <div className="mt-4 flex gap-2 text-sm">
          <button onClick={() => setEdit(true)} className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white">Edit</button>
          {plan.active && (
            <button disabled={busy} onClick={archive} className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-red-700 hover:bg-red-50 disabled:opacity-50">
              Archive
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm ring-2 ring-brand-accent">
      <div className="text-xs uppercase text-ink-subtle">Editing — slug <code>{plan.slug}</code></div>
      <div className="mt-3 space-y-3 text-sm">
        <L label="Name"><input className={INPUT} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></L>
        <L label="Description"><textarea rows={2} className={INPUT} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></L>
        <div className="grid grid-cols-2 gap-3">
          <L label="$ / month"><input type="number" min={0} step="0.01" className={INPUT} value={draft.priceMonthlyDollars} onChange={(e) => setDraft({ ...draft, priceMonthlyDollars: e.target.value })} /></L>
          <L label="$ / year"><input type="number" min={0} step="0.01" className={INPUT} value={draft.priceYearlyDollars} onChange={(e) => setDraft({ ...draft, priceYearlyDollars: e.target.value })} /></L>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <L label="Staff"><input type="number" min={0} className={INPUT} value={draft.quotaStaff} onChange={(e) => setDraft({ ...draft, quotaStaff: Number(e.target.value) })} /></L>
          <L label="Manager seats (-1 = ∞)"><input type="number" min={-1} className={INPUT} value={draft.quotaManagers} onChange={(e) => setDraft({ ...draft, quotaManagers: Number(e.target.value) })} /></L>
          <L label="Bookings/mo"><input type="number" min={0} className={INPUT} value={draft.quotaBookingsPerMonth} onChange={(e) => setDraft({ ...draft, quotaBookingsPerMonth: Number(e.target.value) })} /></L>
          <L label="Services"><input type="number" min={0} className={INPUT} value={draft.quotaServices} onChange={(e) => setDraft({ ...draft, quotaServices: Number(e.target.value) })} /></L>
        </div>
        <L label="Features (one per line)"><textarea rows={4} className={INPUT} value={draft.features} onChange={(e) => setDraft({ ...draft, features: e.target.value })} /></L>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
          Active (visible to new signups)
        </label>
      </div>
      {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}
      <div className="mt-4 flex gap-2 text-sm">
        <button disabled={busy} onClick={save} className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">Save</button>
        <button onClick={() => setEdit(false)} className="rounded-md border border-border bg-white px-3 py-1.5">Cancel</button>
      </div>
    </div>
  );
}

function NewPlanForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({
    slug: "",
    name: "",
    description: "",
    priceMonthlyDollars: "0",
    priceYearlyDollars: "0",
    quotaStaff: 1,
    quotaManagers: 0,
    quotaBookingsPerMonth: 100,
    quotaServices: 5,
    features: "",
    sortOrder: 50,
  });

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: draft.slug.trim().toLowerCase(),
          name: draft.name.trim(),
          description: draft.description || null,
          priceMonthlyCents: Math.round(parseFloat(draft.priceMonthlyDollars || "0") * 100),
          priceYearlyCents: Math.round(parseFloat(draft.priceYearlyDollars || "0") * 100),
          quotaStaff: Number(draft.quotaStaff),
          quotaManagers: Number(draft.quotaManagers),
          quotaBookingsPerMonth: Number(draft.quotaBookingsPerMonth),
          quotaServices: Number(draft.quotaServices),
          features: draft.features.split("\n").map((s) => s.trim()).filter(Boolean),
          sortOrder: Number(draft.sortOrder),
        }),
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
      <h3 className="text-base font-medium">New plan</h3>
      <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
        <L label="Slug (e.g. starter)"><input className={INPUT} value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} /></L>
        <L label="Name"><input className={INPUT} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></L>
        <L label="$ / month"><input type="number" min={0} step="0.01" className={INPUT} value={draft.priceMonthlyDollars} onChange={(e) => setDraft({ ...draft, priceMonthlyDollars: e.target.value })} /></L>
        <L label="$ / year"><input type="number" min={0} step="0.01" className={INPUT} value={draft.priceYearlyDollars} onChange={(e) => setDraft({ ...draft, priceYearlyDollars: e.target.value })} /></L>
        <L label="Staff"><input type="number" min={0} className={INPUT} value={draft.quotaStaff} onChange={(e) => setDraft({ ...draft, quotaStaff: Number(e.target.value) })} /></L>
        <L label="Manager seats (-1 = ∞)"><input type="number" min={-1} className={INPUT} value={draft.quotaManagers} onChange={(e) => setDraft({ ...draft, quotaManagers: Number(e.target.value) })} /></L>
        <L label="Bookings/mo"><input type="number" min={0} className={INPUT} value={draft.quotaBookingsPerMonth} onChange={(e) => setDraft({ ...draft, quotaBookingsPerMonth: Number(e.target.value) })} /></L>
        <L label="Services"><input type="number" min={0} className={INPUT} value={draft.quotaServices} onChange={(e) => setDraft({ ...draft, quotaServices: Number(e.target.value) })} /></L>
        <L label="Sort order"><input type="number" className={INPUT} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })} /></L>
      </div>
      <L label="Description"><textarea rows={2} className={INPUT} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></L>
      <L label="Features (one per line)"><textarea rows={4} className={INPUT} value={draft.features} onChange={(e) => setDraft({ ...draft, features: e.target.value })} /></L>
      {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>}
      <div className="mt-4 flex gap-2 text-sm">
        <button disabled={busy || !draft.slug || !draft.name} onClick={submit} className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white disabled:opacity-50">Create</button>
        <button onClick={onClose} className="rounded-md border border-border bg-white px-3 py-1.5">Cancel</button>
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
