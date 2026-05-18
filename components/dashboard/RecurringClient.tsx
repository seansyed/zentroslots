"use client";

import * as React from "react";

import { Badge, Button, Card, Skeleton, toast } from "@/components/ui/primitives";

type Series = {
  id: string;
  serviceId: string;
  staffUserId: string | null;
  customerName: string;
  customerEmail: string;
  recurrenceRule: string;
  startLocal: string;
  timezone: string;
  endDate: string | null;
  occurrenceCount: number | null;
  status: string;
  lastMaterializedIndex: number;
  createdAt: string;
  updatedAt: string;
  serviceName: string | null;
  staffName: string | null;
};

type Service = { id: string; name: string };
type Staff = { id: string; name: string; timezone: string };

type Occurrence = {
  id: string;
  occurrenceIndex: number;
  occurrenceStartAt: string;
  status: string;
  bookingId: string | null;
  failureReason: string | null;
  attempts: number;
  overrides: Record<string, unknown>;
};

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "neutral" | "blue" | "violet"> = {
  active: "green",
  paused: "amber",
  cancelled: "red",
  completed: "neutral",
  scheduled: "blue",
  failed: "red",
  skipped: "neutral",
};

const STATUS_TABS = ["all", "active", "paused", "cancelled", "completed"] as const;

export default function RecurringClient() {
  const [data, setData] = React.useState<{ series: Series[]; services: Service[]; staff: Staff[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [status, setStatus] = React.useState<(typeof STATUS_TABS)[number]>("all");
  const [creating, setCreating] = React.useState(false);
  const [openSeriesId, setOpenSeriesId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const url = status === "all"
        ? "/api/tenant/booking-series"
        : `/api/tenant/booking-series?status=${status}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
    } finally {
      setLoading(false);
    }
  }, [status]);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function actionSeries(id: string, action: "pause" | "resume" | "cancel") {
    if (action === "cancel" && !confirm("Cancel this series? Already-booked occurrences will remain on the calendar — cancel them individually if needed.")) return;
    try {
      const res = await fetch("/api/tenant/booking-series", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(`Series ${action}d`, "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setStatus(t)}
              className={
                "rounded-md border px-3 py-1.5 text-sm capitalize " +
                (status === t
                  ? "border-brand-accent bg-brand-accent text-white"
                  : "border-border bg-surface text-ink-muted hover:bg-surface-inset")
              }
            >
              {t}
            </button>
          ))}
        </div>
        <Button onClick={() => setCreating(true)}>+ New series</Button>
      </div>

      {creating && data && (
        <CreateSeriesForm
          services={data.services}
          staff={data.staff}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
        />
      )}

      <section>
        <h2 className="text-sm font-semibold text-ink">Series</h2>
        {loading || !data ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </div>
        ) : data.series.length === 0 ? (
          <Card className="mt-3 p-6 text-center text-sm text-ink-muted">
            No recurring series yet. Click <b>+ New series</b> to create one.
          </Card>
        ) : (
          <ul className="mt-3 space-y-2">
            {data.series.map((s) => (
              <li key={s.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {s.serviceName ?? s.serviceId} · {s.customerName}
                        </span>
                        <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-ink-muted">
                        {s.customerEmail}
                        {s.staffName && <> · with {s.staffName}</>}
                        {" · "}{s.timezone}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-ink-subtle">
                        {s.recurrenceRule}
                      </div>
                      <div className="text-[11px] text-ink-subtle">
                        Starts {s.startLocal}
                        {s.endDate && <> · ends {s.endDate}</>}
                        {s.occurrenceCount && <> · {s.occurrenceCount} occurrences</>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {s.status === "active" && (
                        <button
                          onClick={() => actionSeries(s.id, "pause")}
                          className="rounded-md border border-border bg-surface px-3 py-1 text-xs text-ink-muted hover:bg-surface-inset"
                        >
                          Pause
                        </button>
                      )}
                      {s.status === "paused" && (
                        <button
                          onClick={() => actionSeries(s.id, "resume")}
                          className="rounded-md border border-border bg-surface px-3 py-1 text-xs text-ink hover:bg-surface-inset"
                        >
                          Resume
                        </button>
                      )}
                      {(s.status === "active" || s.status === "paused") && (
                        <button
                          onClick={() => actionSeries(s.id, "cancel")}
                          className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          Cancel series
                        </button>
                      )}
                      <button
                        onClick={() => setOpenSeriesId(openSeriesId === s.id ? null : s.id)}
                        className="rounded-md border border-border bg-surface px-3 py-1 text-xs text-ink hover:bg-surface-inset"
                      >
                        {openSeriesId === s.id ? "Hide" : "Show"} occurrences
                      </button>
                    </div>
                  </div>
                  {openSeriesId === s.id && (
                    <OccurrencesPanel seriesId={s.id} onChanged={refresh} />
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function OccurrencesPanel({ seriesId, onChanged }: { seriesId: string; onChanged: () => void }) {
  const [occs, setOccs] = React.useState<Occurrence[] | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/tenant/booking-series/${seriesId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setOccs(d.occurrences);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  }, [seriesId]);

  React.useEffect(() => { load(); }, [load]);

  async function action(occId: string, kind: "skip" | "cancel") {
    if (!confirm(`${kind === "skip" ? "Skip" : "Cancel"} this occurrence?`)) return;
    try {
      const res = await fetch(`/api/tenant/booking-series/${seriesId}/occurrences/${occId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: kind }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d?.error ?? `HTTP ${res.status}`);
      }
      toast("Updated", "success");
      await load();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  }

  if (occs === null) {
    return <div className="mt-3 text-xs text-ink-subtle">Loading occurrences…</div>;
  }
  if (occs.length === 0) {
    return <div className="mt-3 text-xs text-ink-subtle">No occurrences materialized yet. The worker generates the next 30 days.</div>;
  }
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-left uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Booking</th>
            <th className="px-3 py-2">Detail</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {occs.map((o) => (
            <tr key={o.id} className="border-t border-slate-100">
              <td className="px-3 py-2 tabular-nums">{o.occurrenceIndex}</td>
              <td className="px-3 py-2">{new Date(o.occurrenceStartAt).toLocaleString()}</td>
              <td className="px-3 py-2">
                <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{o.status}</Badge>
              </td>
              <td className="px-3 py-2 font-mono text-[10px] text-ink-subtle">
                {o.bookingId ? o.bookingId.slice(0, 8) : "—"}
              </td>
              <td className="px-3 py-2 text-ink-muted">
                {o.failureReason ?? (o.attempts > 0 ? `${o.attempts} attempts` : "—")}
              </td>
              <td className="px-3 py-2 text-right">
                {o.status === "scheduled" && !o.bookingId && (
                  <>
                    <button
                      onClick={() => action(o.id, "skip")}
                      className="mr-2 text-xs text-ink-muted hover:text-ink"
                    >
                      Skip
                    </button>
                    <button
                      onClick={() => action(o.id, "cancel")}
                      className="text-xs text-red-600 hover:text-red-700"
                    >
                      Cancel
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateSeriesForm({
  services,
  staff,
  onClose,
  onCreated,
}: {
  services: Service[];
  staff: Staff[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [serviceId, setServiceId] = React.useState<string>("");
  const [staffUserId, setStaffUserId] = React.useState<string>("");
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [freq, setFreq] = React.useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [interval, setInterval] = React.useState("1");
  const [byday, setByday] = React.useState<Record<string, boolean>>({});
  const [until, setUntil] = React.useState("");
  const [countLimit, setCountLimit] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [startTime, setStartTime] = React.useState("09:00");
  const [timezone, setTimezone] = React.useState(staff[0]?.timezone ?? "UTC");
  const [submitting, setSubmitting] = React.useState(false);

  function ruleString(): string {
    const parts = [`FREQ=${freq}`];
    if (Number(interval) > 1) parts.push(`INTERVAL=${interval}`);
    if (freq === "WEEKLY") {
      const days = Object.entries(byday).filter(([, v]) => v).map(([k]) => k);
      if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
    }
    if (until) parts.push(`UNTIL=${until.replace(/-/g, "")}`);
    if (countLimit) parts.push(`COUNT=${countLimit}`);
    return parts.join(";");
  }

  async function submit() {
    if (!serviceId || !staffUserId || !customerName || !customerEmail || !startDate) {
      toast("Fill all required fields", "error");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/booking-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          staffUserId,
          customerName,
          customerEmail,
          recurrenceRule: ruleString(),
          startLocal: `${startDate}T${startTime}:00`,
          timezone,
          occurrenceCount: countLimit ? Number(countLimit) : null,
          endDate: until || null,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Create failed");
      toast("Series created. The worker will materialize occurrences shortly.", "success");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
    } finally {
      setSubmitting(false);
    }
  }

  const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">New series</h2>
        <button onClick={onClose} className="text-xs text-ink-muted hover:text-ink">Close</button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-slate-700">Service</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">— pick —</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Staff</label>
          <select
            value={staffUserId}
            onChange={(e) => {
              setStaffUserId(e.target.value);
              const s = staff.find((x) => x.id === e.target.value);
              if (s) setTimezone(s.timezone);
            }}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">— pick —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Customer name</label>
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Customer email</label>
          <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Start date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Start time (local)</label>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </div>
      </div>

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Recurrence</div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>Repeat every</span>
          <input type="number" min={1} value={interval} onChange={(e) => setInterval(e.target.value)} className="w-16 rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums" />
          <select value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="DAILY">day(s)</option>
            <option value="WEEKLY">week(s)</option>
            <option value="MONTHLY">month(s)</option>
          </select>
        </div>
        {freq === "WEEKLY" && (
          <div className="mt-2 flex flex-wrap gap-1">
            {WEEKDAYS.map((d) => (
              <label key={d} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs">
                <input type="checkbox" checked={Boolean(byday[d])} onChange={(e) => setByday((cur) => ({ ...cur, [d]: e.target.checked }))} />
                {d}
              </label>
            ))}
          </div>
        )}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-700">End date (optional)</label>
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700">Or after N occurrences</label>
            <input type="number" min={1} value={countLimit} onChange={(e) => setCountLimit(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums" />
          </div>
        </div>
        <div className="mt-2 font-mono text-[10px] text-ink-subtle">
          Rule: <span className="text-ink">{ruleString()}</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onClose} disabled={submitting} className="text-xs text-ink-muted hover:text-ink">Cancel</button>
        <Button onClick={submit} disabled={submitting}>{submitting ? "Creating…" : "Create series"}</Button>
      </div>
    </Card>
  );
}
