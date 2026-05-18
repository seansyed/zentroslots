"use client";

import * as React from "react";

import { Badge, Button, Card, Skeleton, toast } from "@/components/ui/primitives";

type BusinessHours = Record<string, { start: string; end: string }>;

type Rule = {
  id: string;
  serviceId: string | null;
  locationId: string | null;
  enabled: boolean;
  minNoticeMinutes: number | null;
  maxAdvanceDays: number | null;
  maxBookingsPerDay: number | null;
  maxBookingsPerCustomerPerDay: number | null;
  maxConcurrentBookings: number | null;
  cooldownMinutes: number | null;
  blackoutDates: string[];
  requireBusinessHours: boolean;
  businessHours: BusinessHours;
  createdAt: string;
  updatedAt: string;
};

type Service = { id: string; name: string; slug: string };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function BookingRulesClient() {
  const [loading, setLoading] = React.useState(true);
  const [tenantDefault, setTenantDefault] = React.useState<Rule | null>(null);
  const [serviceRules, setServiceRules] = React.useState<Rule[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [activeScope, setActiveScope] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tenant/booking-rules", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTenantDefault(data.tenantDefault);
      setServiceRules(data.serviceRules);
      setServices(data.services);
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
      <section>
        <h2 className="text-sm font-semibold text-ink">Scope</h2>
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
            {tenantDefault?.enabled && (
              <span className="ml-2 rounded-full bg-violet-500 px-1.5 text-[10px] font-medium text-white">●</span>
            )}
          </button>
          <span className="mx-1 text-slate-300">|</span>
          {loading && services.length === 0 ? (
            <Skeleton className="h-8 w-32 rounded-md" />
          ) : (
            services.map((s) => {
              const has = serviceRules.some((r) => r.serviceId === s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveScope(s.id)}
                  className={
                    "rounded-md border px-3 py-1.5 transition " +
                    (activeScope === s.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : has
                        ? "border-violet-300 bg-violet-50 text-violet-900 hover:bg-violet-100"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")
                  }
                >
                  {s.name}
                  {has && <span className="ml-1.5 text-[10px] opacity-60">●</span>}
                </button>
              );
            })
          )}
        </div>
      </section>

      <RuleEditor
        key={activeScope ?? "tenant"}
        scope={activeScope === null ? "tenant" : "service"}
        serviceId={activeScope}
        serviceName={activeService?.name ?? null}
        rule={activeRule}
        onSaved={refresh}
      />
    </div>
  );
}

function RuleEditor({
  scope,
  serviceId,
  serviceName,
  rule,
  onSaved,
}: {
  scope: "tenant" | "service";
  serviceId: string | null;
  serviceName: string | null;
  rule: Rule | null;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = React.useState<boolean>(rule?.enabled ?? true);
  const [minNotice, setMinNotice] = React.useState<string>(rule?.minNoticeMinutes?.toString() ?? "");
  const [maxAdvance, setMaxAdvance] = React.useState<string>(rule?.maxAdvanceDays?.toString() ?? "");
  const [maxDaily, setMaxDaily] = React.useState<string>(rule?.maxBookingsPerDay?.toString() ?? "");
  const [maxPerCustomerDay, setMaxPerCustomerDay] = React.useState<string>(rule?.maxBookingsPerCustomerPerDay?.toString() ?? "");
  const [maxConcurrent, setMaxConcurrent] = React.useState<string>(rule?.maxConcurrentBookings?.toString() ?? "");
  const [cooldown, setCooldown] = React.useState<string>(rule?.cooldownMinutes?.toString() ?? "");
  const [blackoutDates, setBlackoutDates] = React.useState<string[]>(rule?.blackoutDates ?? []);
  const [newBlackout, setNewBlackout] = React.useState<string>("");
  const [requireBH, setRequireBH] = React.useState<boolean>(rule?.requireBusinessHours ?? false);
  const [businessHours, setBusinessHours] = React.useState<BusinessHours>(rule?.businessHours ?? {});
  const [saving, setSaving] = React.useState(false);

  // Snapshot of last-saved values for optimistic rollback.
  const lastSavedRef = React.useRef<typeof currentState | null>(null);
  const currentState = {
    enabled, minNotice, maxAdvance, maxDaily, maxPerCustomerDay,
    maxConcurrent, cooldown, blackoutDates, requireBH, businessHours,
  };

  // Resync when rule changes (scope switch / refresh).
  React.useEffect(() => {
    setEnabled(rule?.enabled ?? true);
    setMinNotice(rule?.minNoticeMinutes?.toString() ?? "");
    setMaxAdvance(rule?.maxAdvanceDays?.toString() ?? "");
    setMaxDaily(rule?.maxBookingsPerDay?.toString() ?? "");
    setMaxPerCustomerDay(rule?.maxBookingsPerCustomerPerDay?.toString() ?? "");
    setMaxConcurrent(rule?.maxConcurrentBookings?.toString() ?? "");
    setCooldown(rule?.cooldownMinutes?.toString() ?? "");
    setBlackoutDates(rule?.blackoutDates ?? []);
    setRequireBH(rule?.requireBusinessHours ?? false);
    setBusinessHours(rule?.businessHours ?? {});
  }, [rule]);

  function addBlackout() {
    if (!newBlackout || !/^\d{4}-\d{2}-\d{2}$/.test(newBlackout)) return;
    if (blackoutDates.includes(newBlackout)) return;
    setBlackoutDates((cur) => [...cur, newBlackout].sort());
    setNewBlackout("");
  }
  function removeBlackout(date: string) {
    setBlackoutDates((cur) => cur.filter((d) => d !== date));
  }

  function setBHWindow(day: number, field: "start" | "end", value: string) {
    setBusinessHours((cur) => {
      const cur2 = { ...cur };
      const existing = cur2[String(day)] ?? { start: "09:00", end: "17:00" };
      cur2[String(day)] = { ...existing, [field]: value };
      return cur2;
    });
  }
  function toggleBHDay(day: number) {
    setBusinessHours((cur) => {
      const cur2 = { ...cur };
      if (cur2[String(day)]) delete cur2[String(day)];
      else cur2[String(day)] = { start: "09:00", end: "17:00" };
      return cur2;
    });
  }

  async function save() {
    // Optimistic rollback snapshot: capture state BEFORE the request.
    const snapshot = { ...currentState };
    lastSavedRef.current = snapshot;
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/booking-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          enabled: snapshot.enabled,
          minNoticeMinutes: parseNullableInt(snapshot.minNotice),
          maxAdvanceDays: parseNullableInt(snapshot.maxAdvance),
          maxBookingsPerDay: parseNullableInt(snapshot.maxDaily),
          maxBookingsPerCustomerPerDay: parseNullableInt(snapshot.maxPerCustomerDay),
          maxConcurrentBookings: parseNullableInt(snapshot.maxConcurrent),
          cooldownMinutes: parseNullableInt(snapshot.cooldown),
          blackoutDates: snapshot.blackoutDates,
          requireBusinessHours: snapshot.requireBH,
          businessHours: snapshot.businessHours,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast(rule ? "Rule updated" : "Rule created", "success");
      onSaved();
    } catch (e) {
      // Roll the editor back to the snapshot we tried to save —
      // dirty-state recomputes naturally.
      setEnabled(snapshot.enabled);
      setMinNotice(snapshot.minNotice);
      setMaxAdvance(snapshot.maxAdvance);
      setMaxDaily(snapshot.maxDaily);
      setMaxPerCustomerDay(snapshot.maxPerCustomerDay);
      setMaxConcurrent(snapshot.maxConcurrent);
      setCooldown(snapshot.cooldown);
      setBlackoutDates(snapshot.blackoutDates);
      setRequireBH(snapshot.requireBH);
      setBusinessHours(snapshot.businessHours);
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (!confirm("Remove this rule? Falls back to the next-most-specific rule, or to legacy behavior.")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tenant/booking-rules?id=${rule.id}`, { method: "DELETE" });
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
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {scope === "tenant" ? "Tenant default" : `Override · ${serviceName ?? "service"}`}
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {scope === "tenant"
              ? "Applies to every service without its own override."
              : "Only applies to this service. Falls back to tenant default when removed."}
            {!rule && " (Using tenant default / legacy service fields.)"}
          </p>
        </div>
        {rule && (
          <span className="text-[11px] text-ink-subtle">Updated {new Date(rule.updatedAt).toLocaleString()}</span>
        )}
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Enabled</span>
        <span className="text-xs text-ink-muted">(disable to keep config but skip enforcement)</span>
      </label>

      {/* Lead time */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <NumberField
          label="Minimum notice (minutes)"
          hint="e.g. 120 = no bookings within 2 hours"
          value={minNotice} onChange={setMinNotice}
        />
        <NumberField
          label="Maximum advance (days)"
          hint="e.g. 60 = no bookings more than 60 days ahead"
          value={maxAdvance} onChange={setMaxAdvance}
        />
      </div>

      {/* Caps */}
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <NumberField
          label="Max bookings per day"
          hint="for this service across all customers"
          value={maxDaily} onChange={setMaxDaily}
        />
        <NumberField
          label="Max per customer per day"
          hint="repeat-booking guard"
          value={maxPerCustomerDay} onChange={setMaxPerCustomerDay}
        />
        <NumberField
          label="Max concurrent bookings"
          hint="for this service in any one window"
          value={maxConcurrent} onChange={setMaxConcurrent}
        />
      </div>

      {/* Cooldown */}
      <div className="mt-5">
        <NumberField
          label="Cooldown between same-customer bookings (minutes)"
          hint="e.g. 30 = a customer must wait 30 min between bookings"
          value={cooldown} onChange={setCooldown}
        />
      </div>

      {/* Blackout dates */}
      <div className="mt-5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Blackout dates
        </div>
        <p className="mt-1 text-[11px] text-ink-muted">
          Customers can&apos;t book on these dates. Add holidays, maintenance, retreats.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={newBlackout}
            onChange={(e) => setNewBlackout(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={addBlackout}
            disabled={!newBlackout}
            className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            + Add
          </button>
        </div>
        {blackoutDates.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {blackoutDates.map((d) => (
              <li key={d} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs">
                <span>{d}</span>
                <button onClick={() => removeBlackout(d)} className="text-red-500 hover:text-red-700">×</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Business hours */}
      <div className="mt-5">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={requireBH} onChange={(e) => setRequireBH(e.target.checked)} />
          <span>Require business hours</span>
          <span className="text-xs text-ink-muted">(reject bookings outside configured hours)</span>
        </label>
        {requireBH && (
          <ul className="mt-3 space-y-1.5">
            {WEEKDAYS.map((d, i) => {
              const isOpen = Boolean(businessHours[String(i)]);
              const w = businessHours[String(i)] ?? { start: "09:00", end: "17:00" };
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="inline-flex w-24 items-center gap-1.5">
                    <input type="checkbox" checked={isOpen} onChange={() => toggleBHDay(i)} />
                    <span className="font-medium">{d}</span>
                  </label>
                  {isOpen ? (
                    <>
                      <input
                        type="time"
                        value={w.start}
                        onChange={(e) => setBHWindow(i, "start", e.target.value)}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs tabular-nums"
                      />
                      <span className="text-xs text-ink-subtle">to</span>
                      <input
                        type="time"
                        value={w.end}
                        onChange={(e) => setBHWindow(i, "end", e.target.value)}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs tabular-nums"
                      />
                    </>
                  ) : (
                    <span className="text-xs text-ink-subtle">closed</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between">
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
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-700">{label}</label>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="(unset)"
        className="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm tabular-nums"
      />
    </div>
  );
}

function parseNullableInt(s: string): number | null {
  if (!s.trim()) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
