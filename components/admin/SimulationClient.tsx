"use client";

/**
 * /admin/dev/simulation client.
 *
 * Triple-gated control plane:
 *   • Super-admin only (route gate).
 *   • ALLOW_DEV_SIMULATION env must be true (banner shows otherwise).
 *   • Every seeded row is reset-safe (marker pattern).
 */

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";

import { ARCHETYPES } from "@/lib/dev-seeding/archetypes";

type StatusResp = {
  enabled: boolean;
  status: { tenants: number; users: number; bookings: number; auditLogs: number };
};

const MODES: Array<{ id: "light" | "medium" | "heavy" | "enterprise"; label: string; detail: string }> = [
  { id: "light", label: "Light", detail: "3 tenants · 30d history" },
  { id: "medium", label: "Medium", detail: "8 tenants · 60d history" },
  { id: "heavy", label: "Heavy", detail: "20 tenants · 90d history" },
  { id: "enterprise", label: "Enterprise", detail: "50 tenants · 90d history" },
];

const INJECTORS: Array<{ id: string; label: string; detail: string }> = [
  { id: "churn_spike", label: "Churn spike", detail: "3–5 subscription cancel events in last hour" },
  { id: "booking_spike", label: "Booking spike", detail: "30–60 booking.created events in last hour" },
  { id: "reminder_failures", label: "Reminder failures", detail: "15–25 failed reminder sends in last hour" },
  { id: "oauth_failures", label: "OAuth failures", detail: "5–10 oauth refresh failures in last hour" },
  { id: "webhook_flood", label: "Webhook flood", detail: "20–40 stripe webhook errors in last hour" },
];

export default function SimulationClient({ initial }: { initial: StatusResp }) {
  const [data, setData] = React.useState<StatusResp>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [lastResult, setLastResult] = React.useState<unknown>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/admin/dev/simulation", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as StatusResp);
    } catch {}
  }

  async function post(body: object, label: string) {
    setBusy(label);
    setLastResult(null);
    try {
      const res = await fetch("/api/admin/dev/simulation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      setLastResult(json);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="sticky top-0 z-10 -mx-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-start gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-amber-700" />
          <div className="flex-1">
            <div className="text-sm font-medium text-amber-900">Simulation Control Center</div>
            <div className="text-[11px] text-amber-700">
              Internal dev tool. Writes synthetic SaaS data to <strong>real DB tables</strong> so
              dashboards feel alive. Every row carries a seed marker and is removed by Reset.
            </div>
          </div>
        </div>
      </div>

      {/* Enablement banner */}
      {!data.enabled ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50/40 px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-700" />
            <div className="flex-1">
              <div className="text-sm font-medium text-rose-900">Simulation disabled on this environment</div>
              <div className="mt-1 text-[12px] text-rose-700">
                Set <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">ALLOW_DEV_SIMULATION=true</code>{" "}
                in <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">.env</code> and restart pm2 to enable.
                Until then, all run/reset/inject calls will be blocked at the lib boundary.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 px-4 py-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
            <div className="flex-1 text-sm text-emerald-900">
              <strong>Simulation enabled.</strong> Operating on real DB tables with the seed-marker safety net.
            </div>
          </div>
        </div>
      )}

      {/* Current footprint */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-900">Current simulation footprint</h2>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Tenants", n: data.status.tenants },
            { label: "Users", n: data.status.users },
            { label: "Bookings", n: data.status.bookings },
            { label: "Audit rows", n: data.status.auditLogs },
          ].map((r) => (
            <div key={r.label} className="rounded-lg border border-slate-100 bg-slate-50/40 p-2.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                {r.label}
              </div>
              <div className="mt-1 text-[20px] font-semibold text-slate-900">
                {new Intl.NumberFormat("en-US").format(r.n)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Run modes */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-900">Run simulation</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={!data.enabled || busy !== null}
              onClick={() => post({ action: "run", mode: m.id }, `run:${m.id}`)}
              className="group rounded-xl border border-slate-200 bg-white p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-sky-300 hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] disabled:opacity-50 disabled:hover:border-slate-200"
            >
              <div className="flex items-center justify-between">
                <Play className="h-4 w-4 text-slate-500 group-hover:text-sky-600" />
                {busy === `run:${m.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" /> : null}
              </div>
              <div className="mt-2 text-sm font-medium text-slate-900">{m.label}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{m.detail}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Inject failures */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-slate-900">Inject failure bursts</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {INJECTORS.map((inj) => (
            <button
              key={inj.id}
              type="button"
              disabled={!data.enabled || busy !== null || data.status.tenants === 0}
              onClick={() => post({ action: "inject", kind: inj.id }, `inject:${inj.id}`)}
              className="group rounded-xl border border-slate-200 bg-white p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:border-amber-300 hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] disabled:opacity-50"
            >
              <div className="flex items-center justify-between">
                <Zap className="h-4 w-4 text-amber-500" />
                {busy === `inject:${inj.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" /> : null}
              </div>
              <div className="mt-2 text-sm font-medium text-slate-900">{inj.label}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{inj.detail}</div>
            </button>
          ))}
        </div>
        {data.enabled && data.status.tenants === 0 ? (
          <div className="mt-2 text-[11px] text-slate-500">
            Run a simulation first — injectors target SEEDED tenants only.
          </div>
        ) : null}
      </section>

      {/* Reset */}
      <section>
        <button
          type="button"
          disabled={!data.enabled || busy !== null}
          onClick={() => {
            if (confirm("Reset wipes every row tagged with the seed marker. Real customer data is never touched. Proceed?")) {
              void post({ action: "reset" }, "reset");
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        >
          {busy === "reset" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Reset simulation
        </button>
      </section>

      {/* Last result */}
      {lastResult ? (
        <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Last action result
          </div>
          <pre className="overflow-auto text-[11px] leading-relaxed text-slate-700">
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        </section>
      ) : null}

      {/* Archetypes reference */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="text-sm font-medium text-slate-900">Tenant archetypes ({ARCHETYPES.length})</div>
        <div className="mt-1 text-[11px] text-slate-500">
          Each simulated tenant draws from one of these archetypes. Booking volume,
          churn risk, plan distribution, and growth curve come from the archetype profile.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ARCHETYPES.map((a) => (
            <div key={a.id} className="rounded-lg border border-slate-100 bg-slate-50/40 px-2 py-1.5">
              <div className="text-[12px] font-medium text-slate-900">{a.label}</div>
              <div className="text-[10px] text-slate-500">
                {a.bookingsPerDay.mean}/day · {a.growth}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
