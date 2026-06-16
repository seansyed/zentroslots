"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CalendarDays,
  CalendarX2,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitBranch,
  Hourglass,
  Layers,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Users,
  X,
} from "lucide-react";

import { Badge, Button, Card, Skeleton, toast, confirmAction } from "@/components/ui/primitives";

// ─── Data types (unchanged from prior implementation) ─────────────────

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

// ─── Presets (Phase 3) ────────────────────────────────────────────────
// Honest naming + values. These are recommended starting points, not
// claims about industry standards. Users tune from here. Selecting a
// preset only prefills the form — nothing saves until the user clicks
// "Save changes". No backend touches.

type PresetValues = Partial<{
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  maxBookingsPerDay: number;
  maxBookingsPerCustomerPerDay: number;
  maxConcurrentBookings: number;
  cooldownMinutes: number;
  requireBusinessHours: boolean;
  businessHours: BusinessHours;
}>;

const STANDARD_BH: BusinessHours = {
  "1": { start: "09:00", end: "17:00" },
  "2": { start: "09:00", end: "17:00" },
  "3": { start: "09:00", end: "17:00" },
  "4": { start: "09:00", end: "17:00" },
  "5": { start: "09:00", end: "17:00" },
};

const PRESETS: Array<{
  key: string;
  label: string;
  summary: string;
  values: PresetValues;
}> = [
  {
    key: "standard",
    label: "Standard",
    summary: "2h notice · 60 days advance · business hours enforced",
    values: {
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
      maxBookingsPerCustomerPerDay: 2,
      requireBusinessHours: true,
      businessHours: STANDARD_BH,
    },
  },
  {
    key: "strict",
    label: "Strict",
    summary: "24h notice · 30 days advance · 1 booking per customer per day",
    values: {
      minNoticeMinutes: 60 * 24,
      maxAdvanceDays: 30,
      maxBookingsPerCustomerPerDay: 1,
      cooldownMinutes: 60,
      requireBusinessHours: true,
      businessHours: STANDARD_BH,
    },
  },
  {
    key: "high_volume",
    label: "High volume",
    summary: "15 min notice · 90 days advance · 50 bookings/day cap",
    values: {
      minNoticeMinutes: 15,
      maxAdvanceDays: 90,
      maxBookingsPerDay: 50,
      maxConcurrentBookings: 3,
    },
  },
  {
    key: "consultation",
    label: "Consultation",
    summary: "4h notice · 14 days advance · 30 min cooldown · business hours",
    values: {
      minNoticeMinutes: 60 * 4,
      maxAdvanceDays: 14,
      maxBookingsPerCustomerPerDay: 1,
      cooldownMinutes: 30,
      requireBusinessHours: true,
      businessHours: STANDARD_BH,
    },
  },
  {
    key: "medical",
    label: "Medical",
    summary: "48h notice · 60 days advance · 1 per customer · 15 min cooldown",
    values: {
      minNoticeMinutes: 60 * 48,
      maxAdvanceDays: 60,
      maxBookingsPerCustomerPerDay: 1,
      cooldownMinutes: 15,
      requireBusinessHours: true,
      businessHours: STANDARD_BH,
    },
  },
  {
    key: "legal_cpa",
    label: "Legal / CPA",
    summary: "24h notice · 30 days advance · 1 per customer · business hours",
    values: {
      minNoticeMinutes: 60 * 24,
      maxAdvanceDays: 30,
      maxBookingsPerCustomerPerDay: 1,
      cooldownMinutes: 60,
      requireBusinessHours: true,
      businessHours: STANDARD_BH,
    },
  },
];

// ─── Root component ───────────────────────────────────────────────────

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

  const activeRule =
    activeScope === null
      ? tenantDefault
      : serviceRules.find((r) => r.serviceId === activeScope) ?? null;
  const activeService = activeScope ? services.find((s) => s.id === activeScope) ?? null : null;

  return (
    <div className="mt-6 space-y-6 pb-28">
      <Hero
        scope={activeScope === null ? "tenant" : "service"}
        rule={activeRule}
        serviceName={activeService?.name ?? null}
        tenantDefaultEnabled={Boolean(tenantDefault?.enabled)}
        serviceRulesCount={serviceRules.filter((r) => r.enabled).length}
      />

      <ScopeSelector
        activeScope={activeScope}
        setActiveScope={setActiveScope}
        services={services}
        serviceRules={serviceRules}
        tenantDefault={tenantDefault}
        loading={loading}
      />

      <RuleEditor
        key={activeScope ?? "tenant"}
        scope={activeScope === null ? "tenant" : "service"}
        serviceId={activeScope}
        serviceName={activeService?.name ?? null}
        rule={activeRule}
        tenantDefault={tenantDefault}
        onSaved={refresh}
      />
    </div>
  );
}

// ─── Hero (Phase 1) ───────────────────────────────────────────────────

function Hero({
  scope,
  rule,
  serviceName,
  tenantDefaultEnabled,
  serviceRulesCount,
}: {
  scope: "tenant" | "service";
  rule: Rule | null;
  serviceName: string | null;
  tenantDefaultEnabled: boolean;
  serviceRulesCount: number;
}) {
  // Insights derived from real, client-side state. No new API calls.
  const blackoutCount = rule?.blackoutDates?.length ?? 0;
  const todayIso = new Date().toISOString().slice(0, 10);
  const nextBlackout =
    (rule?.blackoutDates ?? []).filter((d) => d >= todayIso).sort()[0] ?? null;
  const isActive = Boolean(rule?.enabled);
  const scopeBadge =
    scope === "service"
      ? "Service override active"
      : tenantDefaultEnabled
        ? "Tenant default active"
        : "No tenant default";

  return (
    <Card className="overflow-hidden p-0">
      <div className="bg-gradient-to-br from-brand-accent/8 via-surface to-surface px-6 py-7">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-accent/10 text-brand-accent">
              <Settings className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-accent">
                  <Sparkles className="h-3 w-3" /> Scheduling policy
                </span>
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold " +
                    (isActive
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-600")
                  }
                >
                  <span
                    className={
                      "h-1.5 w-1.5 rounded-full " +
                      (isActive ? "bg-emerald-500" : "bg-slate-400")
                    }
                  />
                  {scopeBadge}
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
                Booking rules
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                {scope === "service"
                  ? `Override the tenant default for ${serviceName ?? "this service"}. Only this service inherits these values; everything else falls back to the tenant default.`
                  : "Notice windows, daily caps, cooldowns, blackouts, and business-hours enforcement applied to every service unless overridden."}
              </p>
            </div>
          </div>

          {/* Insights — purely client-side, no API calls */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <InsightStat
              icon={CalendarX2}
              value={String(blackoutCount)}
              label="Blackout dates"
              accent={blackoutCount > 0 ? "rose" : "muted"}
            />
            <InsightStat
              icon={Hourglass}
              value={nextBlackout ?? "—"}
              label="Next blocked"
              accent={nextBlackout ? "amber" : "muted"}
            />
            <InsightStat
              icon={GitBranch}
              value={String(serviceRulesCount)}
              label="Service overrides"
              accent={serviceRulesCount > 0 ? "violet" : "muted"}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function InsightStat({
  icon: Icon,
  value,
  label,
  accent = "muted",
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
  accent?: "muted" | "rose" | "amber" | "violet" | "emerald";
}) {
  const valueTone =
    accent === "rose"
      ? "text-rose-700"
      : accent === "amber"
        ? "text-amber-700"
        : accent === "violet"
          ? "text-violet-700"
          : accent === "emerald"
            ? "text-emerald-700"
            : "text-ink-subtle";
  return (
    <div className="min-w-[110px] rounded-xl border border-border bg-surface px-3 py-2 text-left">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-ink-subtle" />
        <span className={"text-[13px] font-semibold tabular-nums " + valueTone}>
          {value}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-ink-muted">{label}</div>
    </div>
  );
}

// ─── Scope selector (Phase 7) ─────────────────────────────────────────

function ScopeSelector({
  activeScope,
  setActiveScope,
  services,
  serviceRules,
  tenantDefault,
  loading,
}: {
  activeScope: string | null;
  setActiveScope: (s: string | null) => void;
  services: Service[];
  serviceRules: Rule[];
  tenantDefault: Rule | null;
  loading: boolean;
}) {
  return (
    <section className="space-y-2">
      <SectionLabel icon={Layers} label="Scope" />
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <ScopeChip
            label="Tenant default"
            active={activeScope === null}
            onClick={() => setActiveScope(null)}
            indicator={tenantDefault?.enabled ? "violet" : null}
            tooltip="Applies to every service that doesn't have its own override."
          />
          {services.length > 0 && (
            <span className="mx-1 text-ink-subtle">/</span>
          )}
          {loading && services.length === 0 ? (
            <Skeleton className="h-8 w-32 rounded-lg" />
          ) : services.length === 0 ? (
            <span className="text-xs text-ink-muted">
              No services yet — add a service to create per-service overrides.
            </span>
          ) : (
            services.map((s) => {
              const has = serviceRules.some((r) => r.serviceId === s.id);
              return (
                <ScopeChip
                  key={s.id}
                  label={s.name}
                  active={activeScope === s.id}
                  onClick={() => setActiveScope(s.id)}
                  indicator={has ? "violet" : null}
                  tooltip={has ? "Has a service-specific rule." : "Inherits tenant default."}
                />
              );
            })
          )}
        </div>
      </Card>
    </section>
  );
}

function ScopeChip({
  label,
  active,
  onClick,
  indicator,
  tooltip,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  indicator: "violet" | null;
  tooltip?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={tooltip}
      className={
        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-150 " +
        (active
          ? "border-brand-accent bg-brand-accent text-white shadow-sm"
          : "border-border bg-surface text-ink hover:border-brand-accent/40 hover:bg-surface-muted")
      }
    >
      {label}
      {indicator && (
        <span
          className={
            "h-1.5 w-1.5 rounded-full " +
            (active ? "bg-white" : "bg-violet-500")
          }
        />
      )}
    </button>
  );
}

// ─── Rule editor (Phases 1, 2, 4, 5, 6, 8) ────────────────────────────

function RuleEditor({
  scope,
  serviceId,
  serviceName,
  rule,
  tenantDefault,
  onSaved,
}: {
  scope: "tenant" | "service";
  serviceId: string | null;
  serviceName: string | null;
  rule: Rule | null;
  tenantDefault: Rule | null;
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
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  // Phase 6: track snapshot for dirty detection + optimistic rollback.
  const initial = React.useMemo(
    () => ({
      enabled: rule?.enabled ?? true,
      minNotice: rule?.minNoticeMinutes?.toString() ?? "",
      maxAdvance: rule?.maxAdvanceDays?.toString() ?? "",
      maxDaily: rule?.maxBookingsPerDay?.toString() ?? "",
      maxPerCustomerDay: rule?.maxBookingsPerCustomerPerDay?.toString() ?? "",
      maxConcurrent: rule?.maxConcurrentBookings?.toString() ?? "",
      cooldown: rule?.cooldownMinutes?.toString() ?? "",
      blackoutDates: rule?.blackoutDates ?? [],
      requireBH: rule?.requireBusinessHours ?? false,
      businessHours: rule?.businessHours ?? {},
    }),
    [rule],
  );

  React.useEffect(() => {
    setEnabled(initial.enabled);
    setMinNotice(initial.minNotice);
    setMaxAdvance(initial.maxAdvance);
    setMaxDaily(initial.maxDaily);
    setMaxPerCustomerDay(initial.maxPerCustomerDay);
    setMaxConcurrent(initial.maxConcurrent);
    setCooldown(initial.cooldown);
    setBlackoutDates(initial.blackoutDates);
    setRequireBH(initial.requireBH);
    setBusinessHours(initial.businessHours);
  }, [initial]);

  const dirty = React.useMemo(() => {
    return (
      enabled !== initial.enabled ||
      minNotice !== initial.minNotice ||
      maxAdvance !== initial.maxAdvance ||
      maxDaily !== initial.maxDaily ||
      maxPerCustomerDay !== initial.maxPerCustomerDay ||
      maxConcurrent !== initial.maxConcurrent ||
      cooldown !== initial.cooldown ||
      JSON.stringify(blackoutDates) !== JSON.stringify(initial.blackoutDates) ||
      requireBH !== initial.requireBH ||
      JSON.stringify(businessHours) !== JSON.stringify(initial.businessHours)
    );
  }, [enabled, minNotice, maxAdvance, maxDaily, maxPerCustomerDay, maxConcurrent, cooldown, blackoutDates, requireBH, businessHours, initial]);

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

  function applyPreset(preset: PresetValues) {
    if (preset.minNoticeMinutes !== undefined) setMinNotice(String(preset.minNoticeMinutes));
    if (preset.maxAdvanceDays !== undefined) setMaxAdvance(String(preset.maxAdvanceDays));
    if (preset.maxBookingsPerDay !== undefined) setMaxDaily(String(preset.maxBookingsPerDay));
    if (preset.maxBookingsPerCustomerPerDay !== undefined) setMaxPerCustomerDay(String(preset.maxBookingsPerCustomerPerDay));
    if (preset.maxConcurrentBookings !== undefined) setMaxConcurrent(String(preset.maxConcurrentBookings));
    if (preset.cooldownMinutes !== undefined) setCooldown(String(preset.cooldownMinutes));
    if (preset.requireBusinessHours !== undefined) setRequireBH(preset.requireBusinessHours);
    if (preset.businessHours !== undefined) setBusinessHours(preset.businessHours);
    toast("Preset applied — review and Save changes to commit", "info");
  }

  function resetChanges() {
    setEnabled(initial.enabled);
    setMinNotice(initial.minNotice);
    setMaxAdvance(initial.maxAdvance);
    setMaxDaily(initial.maxDaily);
    setMaxPerCustomerDay(initial.maxPerCustomerDay);
    setMaxConcurrent(initial.maxConcurrent);
    setCooldown(initial.cooldown);
    setBlackoutDates(initial.blackoutDates);
    setRequireBH(initial.requireBH);
    setBusinessHours(initial.businessHours);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/booking-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          enabled,
          minNoticeMinutes: parseNullableInt(minNotice),
          maxAdvanceDays: parseNullableInt(maxAdvance),
          maxBookingsPerDay: parseNullableInt(maxDaily),
          maxBookingsPerCustomerPerDay: parseNullableInt(maxPerCustomerDay),
          maxConcurrentBookings: parseNullableInt(maxConcurrent),
          cooldownMinutes: parseNullableInt(cooldown),
          blackoutDates,
          requireBusinessHours: requireBH,
          businessHours,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast(rule ? "Rule updated" : "Rule created", "success");
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 1400);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (
      !(await confirmAction({
        title: "Remove this booking rule?",
        body: "Future bookings fall back to the next-most-specific rule, or to legacy behavior.",
        variant: "danger",
        confirmLabel: "Remove rule",
      }))
    ) {
      return;
    }
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

  const isInheriting = scope === "service" && !rule;

  return (
    <>
      {/* Inheritance banner for service scope with no override yet */}
      {isInheriting && tenantDefault && (
        <Card className="flex items-start gap-3 border-sky-200 bg-sky-50/70 p-4">
          <Hourglass className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold text-sky-900">
              Inheriting tenant default
            </p>
            <p className="mt-0.5 text-xs text-sky-800">
              This service has no override. Editing below creates a new
              service-specific rule that takes precedence over the tenant
              default. Remove it later to revert to inheritance.
            </p>
          </div>
        </Card>
      )}

      {/* Phase 3 — Presets */}
      <PresetsCard onApply={applyPreset} />

      {/* Phase 1 — Sectioned cards */}
      <SectionCard
        icon={Clock}
        title="Availability rules"
        subtitle="Lead time controls — how far ahead and how close to the appointment a customer can book."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <UnitField
            label="Minimum notice"
            unit="minutes"
            placeholder="120"
            helper="No bookings within this many minutes of now."
            value={minNotice}
            onChange={setMinNotice}
          />
          <UnitField
            label="Maximum advance"
            unit="days"
            placeholder="60"
            helper="No bookings more than this many days ahead."
            value={maxAdvance}
            onChange={setMaxAdvance}
          />
        </div>
      </SectionCard>

      <SectionCard
        icon={Users}
        title="Capacity limits"
        subtitle="Hard caps on how many bookings can land in this service before the engine rejects new ones."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <UnitField
            label="Max bookings per day"
            unit="bookings"
            placeholder="—"
            helper="Across all customers for this service."
            value={maxDaily}
            onChange={setMaxDaily}
          />
          <UnitField
            label="Max concurrent bookings"
            unit="bookings"
            placeholder="—"
            helper="In any one overlapping window."
            value={maxConcurrent}
            onChange={setMaxConcurrent}
          />
          <UnitField
            label="Max per customer per day"
            unit="bookings"
            placeholder="—"
            helper="Repeat-booking guard."
            value={maxPerCustomerDay}
            onChange={setMaxPerCustomerDay}
          />
        </div>
      </SectionCard>

      <SectionCard
        icon={TimerReset}
        title="Customer restrictions"
        subtitle="Cooldown between bookings from the same customer."
      >
        <UnitField
          label="Cooldown between same-customer bookings"
          unit="minutes"
          placeholder="30"
          helper="A customer must wait this many minutes between bookings."
          value={cooldown}
          onChange={setCooldown}
        />
      </SectionCard>

      <SectionCard
        icon={CalendarX2}
        title="Blackout dates"
        subtitle="Customers can't book on these dates. Add holidays, retreats, scheduled maintenance."
      >
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-ink-muted">
              Add a date
            </label>
            <input
              type="date"
              value={newBlackout}
              onChange={(e) => setNewBlackout(e.target.value)}
              className="mt-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
              aria-label="Blackout date"
            />
          </div>
          <button
            type="button"
            onClick={addBlackout}
            disabled={!newBlackout}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
          >
            <Plus className="h-3 w-3" /> Add date
          </button>
        </div>

        {blackoutDates.length > 0 ? (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between text-[11px] text-ink-subtle">
              <span>{blackoutDates.length} blocked {blackoutDates.length === 1 ? "date" : "dates"}</span>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              {blackoutDates.map((d) => (
                <BlackoutChip key={d} date={d} onRemove={() => removeBlackout(d)} />
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-border bg-surface-muted/40 px-3 py-2 text-xs text-ink-subtle">
            No blackout dates configured. Customers can book any date that
            passes your other rules.
          </p>
        )}
      </SectionCard>

      <SectionCard
        icon={Shield}
        title="Enforcement"
        subtitle="Master switches that gate whether the engine evaluates this rule and whether customers can only book inside configured business hours."
      >
        {/* Phase 5 — Premium business-hours toggle card */}
        <ToggleCard
          icon={requireBH ? ShieldCheck : Shield}
          title="Require business hours"
          summary="Reject bookings outside the hours configured below. When off, bookings are accepted any time the staff is available."
          checked={requireBH}
          onChange={setRequireBH}
        />
        {requireBH && (
          <div className="mt-4 rounded-xl border border-border bg-surface-muted/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                Business hours (per weekday)
              </div>
              <Link
                href="/dashboard/settings/workspace-hours"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink"
              >
                Manage workspace hours <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
            <ul className="mt-3 space-y-1.5">
              {WEEKDAYS.map((d, i) => {
                const isOpen = Boolean(businessHours[String(i)]);
                const w = businessHours[String(i)] ?? { start: "09:00", end: "17:00" };
                return (
                  <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="inline-flex w-24 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isOpen}
                        onChange={() => toggleBHDay(i)}
                        className="h-3.5 w-3.5 rounded accent-brand-accent"
                        aria-label={`${d} open`}
                      />
                      <span className="font-medium text-ink">{d}</span>
                    </label>
                    {isOpen ? (
                      <>
                        <input
                          type="time"
                          value={w.start}
                          onChange={(e) => setBHWindow(i, "start", e.target.value)}
                          className="rounded-md border border-border bg-surface px-2 py-1 text-xs tabular-nums focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent/30"
                          aria-label={`${d} open time`}
                        />
                        <span className="text-xs text-ink-subtle">to</span>
                        <input
                          type="time"
                          value={w.end}
                          onChange={(e) => setBHWindow(i, "end", e.target.value)}
                          className="rounded-md border border-border bg-surface px-2 py-1 text-xs tabular-nums focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent/30"
                          aria-label={`${d} close time`}
                        />
                      </>
                    ) : (
                      <span className="text-xs text-ink-subtle">closed</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="mt-4 border-t border-border/60 pt-4">
          <ToggleCard
            icon={CheckCircle2}
            title="Rule enabled"
            summary="Disable to keep this configuration but stop the engine from enforcing it. Useful for staged rollouts."
            checked={enabled}
            onChange={setEnabled}
          />
        </div>
      </SectionCard>

      {/* Phase 6 — Sticky action footer */}
      <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-md backdrop-blur sm:bottom-6">
        <div className="flex min-w-0 items-center gap-3 text-xs">
          {dirty ? (
            <span className="inline-flex items-center gap-2 text-amber-700">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              Unsaved changes
            </span>
          ) : saveSuccess ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 text-ink-subtle">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              All changes saved
            </span>
          )}
          {rule && (
            <span className="text-ink-subtle">
              · Last updated {new Date(rule.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {rule && (
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="rounded-md px-2 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            >
              Remove rule
            </button>
          )}
          <button
            type="button"
            onClick={resetChanges}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-30"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
          <Badge tone={enabled ? "green" : "neutral"}>
            {enabled ? "enabled" : "disabled"}
          </Badge>
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner /> Saving…
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Save className="h-3.5 w-3.5" />
                {rule ? "Save changes" : "Create rule"}
              </span>
            )}
          </Button>
        </div>
      </div>
    </>
  );
}

// ─── Presets card (Phase 3) ───────────────────────────────────────────

function PresetsCard({ onApply }: { onApply: (values: PresetValues) => void }) {
  return (
    <SectionCard
      icon={Sparkles}
      title="Quick presets"
      subtitle="Recommended starting points. Selecting a preset prefills the form — nothing saves until you click Save changes."
    >
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onApply(p.values)}
            className="group flex max-w-[260px] flex-col items-start gap-1 rounded-xl border border-border bg-surface px-3 py-2 text-left transition-all duration-150 hover:border-brand-accent/40 hover:bg-surface-muted hover:shadow-sm"
          >
            <span className="text-sm font-semibold text-ink group-hover:text-brand-accent">
              {p.label}
            </span>
            <span className="text-[11px] leading-tight text-ink-muted">
              {p.summary}
            </span>
          </button>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── Section card primitive (Phase 1) ─────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">{title}</h2>
              <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
            </div>
          </div>
        </div>
        <div className="p-5">{children}</div>
      </Card>
    </section>
  );
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}

// ─── Unit field (Phase 2) ─────────────────────────────────────────────

function UnitField({
  label,
  unit,
  placeholder,
  helper,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  placeholder: string;
  helper: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const num = value.trim() === "" ? null : Number(value);
  const invalid = num !== null && (!Number.isFinite(num) || num < 0);
  const hasValue = value.trim() !== "" && !invalid;
  return (
    <div>
      <label className="block text-xs font-medium text-ink">{label}</label>
      <div className="relative mt-1.5">
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          className={
            "w-full rounded-lg border bg-surface px-3 py-2 pr-20 text-sm tabular-nums transition-all duration-150 focus:outline-none focus:ring-2 " +
            (invalid
              ? "border-rose-300 text-rose-700 focus:border-rose-400 focus:ring-rose-100"
              : hasValue
                ? "border-brand-accent/40 text-ink focus:border-brand-accent focus:ring-brand-accent/20"
                : "border-border text-ink focus:border-brand-accent focus:ring-brand-accent/20")
          }
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-ink-subtle">
          {unit}
        </span>
      </div>
      <p
        className={
          "mt-1 flex items-center gap-1 text-[11px] " +
          (invalid ? "text-rose-600" : "text-ink-muted")
        }
      >
        {invalid && <AlertCircle className="h-3 w-3" />}
        {invalid ? "Enter a non-negative whole number" : helper}
      </p>
    </div>
  );
}

// ─── Toggle card primitive (Phase 5) ──────────────────────────────────

function ToggleCard({
  icon: Icon,
  title,
  summary,
  checked,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={
        "flex items-start gap-3 rounded-xl border p-4 transition-all duration-150 " +
        (checked
          ? "border-brand-accent/30 bg-brand-accent/[0.04] shadow-[0_0_0_1px_rgba(37,99,235,0.08)]"
          : "border-border bg-surface hover:border-border/80")
      }
    >
      <div
        className={
          "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg " +
          (checked ? "bg-brand-accent/15 text-brand-accent" : "bg-surface-muted text-ink-subtle")
        }
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className={"text-sm font-semibold " + (checked ? "text-ink" : "text-ink-muted")}>
            {title}
          </h3>
          {checked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
              Active
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">{summary}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={title} />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-brand-accent/30 " +
        (checked ? "bg-brand-accent" : "bg-slate-300")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150 " +
          (checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}

// ─── Blackout chip (Phase 4) ──────────────────────────────────────────

function BlackoutChip({ date, onRemove }: { date: string; onRemove: () => void }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const isPast = date < todayIso;
  // Pretty label: "Mon, Jan 8".
  const pretty = (() => {
    try {
      const d = new Date(date + "T00:00:00");
      if (Number.isNaN(d.getTime())) return date;
      return d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      });
    } catch {
      return date;
    }
  })();
  return (
    <li
      className={
        "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors " +
        (isPast
          ? "border-slate-200 bg-surface-muted text-ink-subtle"
          : "border-rose-200 bg-rose-50 text-rose-800")
      }
      title={isPast ? `${date} (past)` : date}
    >
      <CalendarDays className="h-3 w-3" />
      <span className="font-medium">{pretty}</span>
      {isPast && <span className="text-[10px] text-ink-subtle">past</span>}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove blackout date ${date}`}
        className="ml-0.5 grid h-4 w-4 place-items-center rounded-full hover:bg-rose-100"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </li>
  );
}

// ─── Misc ─────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
      aria-hidden="true"
    />
  );
}

function parseNullableInt(s: string): number | null {
  if (!s.trim()) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
