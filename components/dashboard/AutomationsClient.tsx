"use client";

import * as React from "react";

import { Badge, Button, Card, Skeleton, toast } from "@/components/ui/primitives";

type ReviewRule = {
  id: string;
  serviceId: string | null;
  enabled: boolean;
  delayMinutes: number;
  reviewPlatform: string;
  reviewUrl: string | null;
  suppressIfCancelled: boolean;
  suppressIfNoShow: boolean;
  createdAt: string;
  updatedAt: string;
};

type FollowupRule = {
  id: string;
  serviceId: string | null;
  enabled: boolean;
  triggerEvent: string;
  delayMinutes: number;
  templateId: string | null;
  onlyFirstTimeCustomers: boolean;
  onlyCompletedBookings: boolean;
  requireSuccessfulPayment: boolean;
  createdAt: string;
  updatedAt: string;
};

type Service = { id: string; name: string; slug: string };

type Data = {
  reviews: { tenantDefault: ReviewRule | null; serviceRules: ReviewRule[] };
  followups: { all: FollowupRule[] };
  services: Service[];
  reviewPlatforms: string[];
  triggerEvents: string[];
};

const TRIGGER_LABEL: Record<string, string> = {
  "appointment.completed": "After appointment completed",
  "appointment.cancelled": "After appointment cancelled",
  "appointment.no_show": "After no-show",
  "appointment.followup_due": "Custom follow-up window",
};

export default function AutomationsClient() {
  const [data, setData] = React.useState<Data | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tenant/automations", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  if (loading || !data) {
    return (
      <div className="mt-6 space-y-3">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-8">
      {/* REVIEW REQUESTS */}
      <section>
        <h2 className="text-sm font-semibold text-ink">Review requests</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Sent after a completed appointment, on a delay. Suppressed automatically
          for cancellations and no-shows when those flags are on.
        </p>
        <ReviewRuleEditor
          scope="tenant"
          rule={data.reviews.tenantDefault}
          platforms={data.reviewPlatforms}
          onSaved={refresh}
        />
        {data.reviews.serviceRules.length > 0 && (
          <div className="mt-3 space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              Service overrides
            </h3>
            {data.reviews.serviceRules.map((r) => (
              <ReviewRuleEditor
                key={r.id}
                scope="service"
                serviceName={data.services.find((s) => s.id === r.serviceId)?.name}
                rule={r}
                platforms={data.reviewPlatforms}
                onSaved={refresh}
              />
            ))}
          </div>
        )}
        <AddServiceOverride
          kind="review"
          services={data.services}
          existing={data.reviews.serviceRules.map((r) => r.serviceId).filter((v): v is string => v !== null)}
          onAdd={(serviceId) => createDraftReviewRule(serviceId, data.reviewPlatforms[0], refresh)}
        />
      </section>

      {/* FOLLOW-UPS */}
      <section>
        <h2 className="text-sm font-semibold text-ink">Follow-ups</h2>
        <p className="mt-1 text-xs text-ink-muted">
          One rule per trigger event + scope. Conditional flags evaluated at send
          time, not at enqueue time.
        </p>
        <div className="mt-3 space-y-3">
          {data.followups.all.length === 0 ? (
            <Card className="p-4 text-center text-sm text-ink-muted">
              No follow-ups configured yet.
            </Card>
          ) : (
            data.followups.all.map((r) => (
              <FollowupRuleEditor
                key={r.id}
                rule={r}
                serviceName={data.services.find((s) => s.id === r.serviceId)?.name}
                triggerEvents={data.triggerEvents}
                onSaved={refresh}
              />
            ))
          )}
        </div>
        <AddFollowupRule
          services={data.services}
          triggerEvents={data.triggerEvents}
          onAdd={refresh}
        />
      </section>
    </div>
  );
}

// ─── Review-rule editor ─────────────────────────────────────────────────

function ReviewRuleEditor({
  scope,
  serviceName,
  rule,
  platforms,
  onSaved,
}: {
  scope: "tenant" | "service";
  serviceName?: string;
  rule: ReviewRule | null;
  platforms: string[];
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = React.useState(rule?.enabled ?? true);
  const [delay, setDelay] = React.useState(rule?.delayMinutes?.toString() ?? "60");
  const [platform, setPlatform] = React.useState(rule?.reviewPlatform ?? platforms[0] ?? "google");
  const [url, setUrl] = React.useState(rule?.reviewUrl ?? "");
  const [suppressCancelled, setSuppressCancelled] = React.useState(rule?.suppressIfCancelled ?? true);
  const [suppressNoShow, setSuppressNoShow] = React.useState(rule?.suppressIfNoShow ?? true);
  const [saving, setSaving] = React.useState(false);

  // Snapshot last-saved values for rollback.
  const snapshotRef = React.useRef({ enabled, delay, platform, url, suppressCancelled, suppressNoShow });
  React.useEffect(() => {
    snapshotRef.current = { enabled, delay, platform, url, suppressCancelled, suppressNoShow };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule]);

  async function save() {
    const snap = { enabled, delay, platform, url, suppressCancelled, suppressNoShow };
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/automations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "review",
          serviceId: rule?.serviceId ?? null,
          enabled: snap.enabled,
          delayMinutes: Number(snap.delay) || 0,
          reviewPlatform: snap.platform,
          reviewUrl: snap.url || null,
          suppressIfCancelled: snap.suppressCancelled,
          suppressIfNoShow: snap.suppressNoShow,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast("Review rule saved", "success");
      onSaved();
    } catch (e) {
      // Rollback to last-saved
      setEnabled(snapshotRef.current.enabled);
      setDelay(snapshotRef.current.delay);
      setPlatform(snapshotRef.current.platform);
      setUrl(snapshotRef.current.url);
      setSuppressCancelled(snapshotRef.current.suppressCancelled);
      setSuppressNoShow(snapshotRef.current.suppressNoShow);
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (!confirm("Remove this review-request rule?")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tenant/automations?kind=review&id=${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Removed", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Remove failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">
            {scope === "tenant" ? "Tenant default" : `Override · ${serviceName ?? "service"}`}
          </div>
          {!rule && scope === "tenant" && (
            <p className="text-[11px] text-ink-subtle">No rule yet — save to create.</p>
          )}
        </div>
        <Badge tone={enabled ? "green" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Enabled</span>
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-700">Delay (minutes)</label>
          <input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Review URL</label>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://g.page/r/..." className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={suppressCancelled} onChange={(e) => setSuppressCancelled(e.target.checked)} />
          Suppress on cancelled
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={suppressNoShow} onChange={(e) => setSuppressNoShow(e.target.checked)} />
          Suppress on no-show
        </label>
      </div>

      <div className="mt-4 flex items-center justify-between">
        {rule && (
          <button onClick={remove} disabled={saving} className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50">
            Remove
          </button>
        )}
        <div className="ml-auto">
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : rule ? "Save changes" : "Create rule"}</Button>
        </div>
      </div>
    </Card>
  );
}

// ─── Follow-up rule editor ──────────────────────────────────────────────

function FollowupRuleEditor({
  rule,
  serviceName,
  triggerEvents,
  onSaved,
}: {
  rule: FollowupRule;
  serviceName?: string;
  triggerEvents: string[];
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = React.useState(rule.enabled);
  const [trigger, setTrigger] = React.useState(rule.triggerEvent);
  const [delay, setDelay] = React.useState(rule.delayMinutes.toString());
  const [firstTime, setFirstTime] = React.useState(rule.onlyFirstTimeCustomers);
  const [completed, setCompleted] = React.useState(rule.onlyCompletedBookings);
  const [reqPayment, setReqPayment] = React.useState(rule.requireSuccessfulPayment);
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/automations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "followup",
          id: rule.id,
          serviceId: rule.serviceId,
          enabled,
          triggerEvent: trigger,
          delayMinutes: Number(delay) || 0,
          onlyFirstTimeCustomers: firstTime,
          onlyCompletedBookings: completed,
          requireSuccessfulPayment: reqPayment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast("Saved", "success");
      onSaved();
    } catch (e) {
      // Rollback
      setEnabled(rule.enabled);
      setTrigger(rule.triggerEvent);
      setDelay(rule.delayMinutes.toString());
      setFirstTime(rule.onlyFirstTimeCustomers);
      setCompleted(rule.onlyCompletedBookings);
      setReqPayment(rule.requireSuccessfulPayment);
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm("Remove this follow-up rule?")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tenant/automations?kind=followup&id=${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Removed", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Remove failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="text-sm">
          <span className="font-semibold text-ink">{TRIGGER_LABEL[trigger] ?? trigger}</span>
          {serviceName ? <span className="ml-2 text-ink-muted">· {serviceName}</span> : <span className="ml-2 text-ink-muted">· Tenant default</span>}
        </div>
        <Badge tone={enabled ? "green" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-700">Trigger</label>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            {triggerEvents.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t] ?? t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Delay (minutes)</label>
          <input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums" />
        </div>
        <label className="flex items-end gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={firstTime} onChange={(e) => setFirstTime(e.target.checked)} />
          First-time customers only
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />
          Only after completed bookings
        </label>
        <label className="flex items-center gap-2 opacity-60" title="No-op until payments integration ships">
          <input type="checkbox" checked={reqPayment} onChange={(e) => setReqPayment(e.target.checked)} />
          Require successful payment <span className="text-[10px] text-amber-700">(payments integration required)</span>
        </label>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button onClick={remove} disabled={saving} className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50">
          Remove
        </button>
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
      </div>
    </Card>
  );
}

// ─── Add helpers ────────────────────────────────────────────────────────

function AddServiceOverride({
  kind,
  services,
  existing,
  onAdd,
}: {
  kind: "review" | "followup";
  services: Service[];
  existing: string[];
  onAdd: (serviceId: string) => void;
}) {
  const available = services.filter((s) => !existing.includes(s.id));
  void kind;
  if (available.length === 0) return null;
  return (
    <div className="mt-3">
      <select
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
          e.target.value = "";
        }}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs"
      >
        <option value="">+ Add service override</option>
        {available.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

function AddFollowupRule({
  services,
  triggerEvents,
  onAdd,
}: {
  services: Service[];
  triggerEvents: string[];
  onAdd: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [serviceId, setServiceId] = React.useState<string>("");
  const [trigger, setTrigger] = React.useState(triggerEvents[0] ?? "appointment.completed");
  const [delay, setDelay] = React.useState("60");
  const [saving, setSaving] = React.useState(false);

  async function create() {
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/automations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "followup",
          serviceId: serviceId || null,
          enabled: true,
          triggerEvent: trigger,
          delayMinutes: Number(delay) || 0,
          onlyFirstTimeCustomers: false,
          onlyCompletedBookings: trigger === "appointment.completed",
          requireSuccessfulPayment: false,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d?.error ?? "Create failed");
      }
      toast("Follow-up created", "success");
      setOpen(false);
      onAdd();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-md border border-dashed border-slate-300 px-4 py-2 text-xs text-slate-600 hover:border-slate-400 hover:text-slate-900"
      >
        + Add follow-up rule
      </button>
    );
  }
  return (
    <Card className="mt-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-slate-700">Scope</label>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            <option value="">Tenant default</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Trigger</label>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm">
            {triggerEvents.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t] ?? t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Delay (minutes)</label>
          <input type="number" min={0} value={delay} onChange={(e) => setDelay(e.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums" />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={() => setOpen(false)} disabled={saving} className="text-xs text-ink-muted">Cancel</button>
        <Button size="sm" onClick={create} disabled={saving}>{saving ? "Creating…" : "Create rule"}</Button>
      </div>
    </Card>
  );
}

async function createDraftReviewRule(
  serviceId: string,
  platform: string,
  onAdd: () => void
) {
  try {
    const res = await fetch("/api/tenant/automations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "review",
        serviceId,
        enabled: false,
        delayMinutes: 60,
        reviewPlatform: platform,
        reviewUrl: null,
        suppressIfCancelled: true,
        suppressIfNoShow: true,
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d?.error ?? "Create failed");
    }
    onAdd();
  } catch (e) {
    toast(e instanceof Error ? e.message : "Create failed", "error");
  }
}
