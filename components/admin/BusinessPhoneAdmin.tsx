"use client";

/**
 * Super-admin Business Phone provisioning console (Phase 3).
 *
 * Assign an ALREADY-PROVISIONED Telnyx number to a tenant + record forwarding,
 * and enable/disable a tenant's service. Talks only to
 * /api/admin/business-phone/{assign,toggle}. Shows no API keys or secrets.
 * Numbers must be provisioned in Telnyx BEFORE assigning here.
 */

import * as React from "react";
import { useRouter } from "next/navigation";

type SetupState =
  | "no_addon"
  | "setup_pending"
  | "active"
  | "disabled"
  | "suspended"
  | "cap_reached";

type Row = {
  tenantId: string;
  name: string;
  slug: string;
  currentPlan: string;
  subscriptionStatus: string | null;
  entitlementSource: string;
  entitled: boolean;
  numberAssigned: boolean;
  businessNumber: string | null;
  forwardingNumber: string | null;
  enabled: boolean;
  minutesUsed: number;
  monthlyMinuteCap: number;
  setupState: SetupState;
  isDemo: boolean;
};

const STATE_BADGE: Record<SetupState, string> = {
  no_addon: "bg-slate-100 text-slate-600",
  setup_pending: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  disabled: "bg-slate-200 text-slate-700",
  suspended: "bg-red-100 text-red-800",
  cap_reached: "bg-orange-100 text-orange-800",
};

const STATE_LABEL: Record<SetupState, string> = {
  no_addon: "No add-on",
  setup_pending: "Setup pending",
  active: "Active",
  disabled: "Disabled",
  suspended: "Suspended",
  cap_reached: "Cap reached",
};

export default function BusinessPhoneAdmin({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Assign form
  const [tenantId, setTenantId] = React.useState("");
  const [businessPhoneNumber, setBusinessPhoneNumber] = React.useState("");
  const [forwardingNumber, setForwardingNumber] = React.useState("");
  const [includedMinutes, setIncludedMinutes] = React.useState("1000");
  const [label, setLabel] = React.useState("");

  async function post(url: string, payload: unknown) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function onAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) {
      setError("Pick a tenant.");
      return;
    }
    try {
      const minutes = includedMinutes.trim() === "" ? undefined : Number(includedMinutes);
      await post("/api/admin/business-phone/assign", {
        tenantId,
        businessPhoneNumber,
        forwardingNumber,
        includedMinutes: minutes,
        label: label.trim() || undefined,
      });
      setNotice("Number assigned.");
      setBusinessPhoneNumber("");
      setForwardingNumber("");
      setLabel("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign.");
    }
  }

  async function onToggle(row: Row) {
    const next = !row.enabled;
    if (!next && !window.confirm(`Disable Business Phone for ${row.name}? Numbers and logs are kept.`)) {
      return;
    }
    try {
      await post("/api/admin/business-phone/toggle", { tenantId: row.tenantId, enabled: next });
      setNotice(next ? "Enabled." : "Disabled.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle.");
    }
  }

  const pending = rows.filter((r) => r.setupState === "setup_pending");

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>
      ) : null}

      {/* Assign / update form */}
      <form onSubmit={onAssign} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-ink">Assign / update number</h2>
        <p className="mt-1 text-xs text-slate-500">
          The number must already exist in your Telnyx account. This only records the assignment.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-slate-600">Tenant</span>
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Select a tenant…</option>
              {rows.map((r) => (
                <option key={r.tenantId} value={r.tenantId}>
                  {r.name} ({r.slug}) — {STATE_LABEL[r.setupState]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Included minutes (cap)</span>
            <input
              value={includedMinutes}
              onChange={(e) => setIncludedMinutes(e.target.value)}
              inputMode="numeric"
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="200"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Business number (E.164, US/CA)</span>
            <input
              value={businessPhoneNumber}
              onChange={(e) => setBusinessPhoneNumber(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="+15551234567"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">Forwarding number (rings first)</span>
            <input
              value={forwardingNumber}
              onChange={(e) => setForwardingNumber(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="+15557654321"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-slate-600">Label / notes (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="e.g. ParaFort main line"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-4 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Assign number"}
        </button>
      </form>

      {/* Pending callout */}
      {pending.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {pending.length} tenant{pending.length === 1 ? "" : "s"} bought the add-on and need a number assigned.
        </div>
      ) : null}

      {/* Tenants table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Plan / billing</th>
              <th className="px-3 py-2">Business #</th>
              <th className="px-3 py-2">Forwarding #</th>
              <th className="px-3 py-2">Usage</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  No tenants have a Business Phone settings row yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.tenantId}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{r.name}</div>
                    <div className="text-xs text-slate-500">{r.slug}{r.isDemo ? " · demo" : ""}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_BADGE[r.setupState]}`}>
                      {STATE_LABEL[r.setupState]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {r.currentPlan}
                    <div className="text-slate-400">{r.subscriptionStatus ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.businessNumber ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.forwardingNumber ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {r.minutesUsed}/{r.monthlyMinuteCap || "∞"} min
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{r.entitlementSource}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => onToggle(r)}
                      disabled={busy}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {r.enabled ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
