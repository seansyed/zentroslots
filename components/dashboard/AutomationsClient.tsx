"use client";

import * as React from "react";
import Link from "next/link";
import { Lock, Sparkles, Heart, TrendingUp, Zap } from "lucide-react";

import { Badge, Button, Card, Skeleton, toast, confirmAction } from "@/components/ui/primitives";
import { useCapability } from "@/components/billing/CapabilityProvider";
import {
  PremiumLockedExperience,
  AutomationWorkflowPreview,
} from "@/components/billing/PremiumLockedExperience";

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

  // ── Plan capability gate (mirrors RecurringClient Phase 6) ──────────
  // Three render branches:
  //   1. cap.allowed → normal premium UX
  //   2. !cap.allowed AND no grandfathered rules → full locked page
  //   3. !cap.allowed AND grandfathered rules exist → rules visible
  //      read-only with banner; ALL mutation surfaces hidden.
  // Backend already 402s every mutation route (Phase 1 ships
  // assertCanCreateAutomationRule). The UI mirroring is purely about
  // not letting the operator find a button that will fail.
  const cap = useCapability("automation_rules");
  const grandfatheredCount =
    (data?.reviews.tenantDefault ? 1 : 0) +
    (data?.reviews.serviceRules.length ?? 0) +
    (data?.followups.all.length ?? 0);
  const actionsDisabled = !cap.allowed;

  if (loading || !data) {
    return (
      <div className="mt-6 space-y-3">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  // Branch 2 — Free tenant with no grandfathered rules. Premium locked
  // experience fills the canvas with feature visualization + outcomes +
  // use cases + Free-vs-Pro comparison. Operational sections never mount.
  if (!cap.allowed && grandfatheredCount === 0) {
    return (
      <div className="mt-6 space-y-6 pb-12">
        <PremiumLockedExperience
          cap="automation_rules"
          eyebrow="Customer engagement"
          title="Follow-up automation, on every booking"
          tagline="Set the triggers once. The workflow engine sends review requests, rebooking nudges, and follow-ups at exactly the right moment — without lifting a finger."
          description="Automations fire on real booking lifecycle events: completed, cancelled, no-show, first-visit. Each one runs through your suppression rules, fires through your templates, and writes to the same audit log as any other communication."
          primaryCta={{ label: "Unlock automation workflows", href: "/dashboard/billing" }}
          secondaryCta={{ label: "Compare plans", href: "/pricing" }}
          visualization={<AutomationWorkflowPreview />}
          outcomes={[
            {
              icon: Zap,
              title: "Recover no-shows automatically",
              body: "A rebooking nudge fires 24 hours after a no-show — customers who'd otherwise churn rebook themselves.",
            },
            {
              icon: TrendingUp,
              title: "Lift review volume + ranking",
              body: "Targeted review requests sent at peak conversion windows (2h after completion) consistently outperform manual asks.",
            },
            {
              icon: Heart,
              title: "Improve retention without spam",
              body: "Per-rule suppression on cancelled / no-show ensures customers only get messages that match their actual journey.",
            },
          ]}
          useCases={[
            "Review requests",
            "Rebooking nudges",
            "Cancellation recovery",
            "First-visit welcome",
            "Loyalty re-engagement",
            "Post-service follow-ups",
          ]}
          comparison={{
            free: ["Booking confirmations", "Basic reminders", "Manual customer outreach", "Cancellation emails"],
            pro: [
              "Review request automation (Google / Yelp / custom)",
              "Per-trigger follow-up rules",
              "Conditional suppression (first-time, payment, status)",
              "Per-service rule overrides",
              "Recurring scheduling + waitlists",
              "Analytics + CSV export",
            ],
          }}
          faqItems={[
            {
              q: "Does each automation respect my customer preferences?",
              a: "Yes. Suppress on cancelled + suppress on no-show flags filter out customers whose journey doesn't warrant the message. No customer gets a review request after a cancellation.",
            },
            {
              q: "When exactly do automations fire?",
              a: "The cron runs every 10–15 minutes. Pending rows include the trigger time + delay; the worker re-evaluates conditions at execution time to avoid stale sends.",
            },
            {
              q: "What happens to existing rules if I downgrade?",
              a: "Existing rules are grandfathered — the cron keeps firing them. You just can't create new rules or edit existing ones until you re-upgrade.",
            },
            {
              q: "Can I test a rule before turning it on?",
              a: "Yes. Each rule has an enabled toggle. Configure the trigger + template, leave enabled off, send a test booking through, then flip enabled on once you're happy.",
            },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-8">
      {/* Grandfather banner — branch 3 only. */}
      {!cap.allowed && grandfatheredCount > 0 && (
        <GrandfatherBanner cap={cap} count={grandfatheredCount} />
      )}

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
          actionsDisabled={actionsDisabled}
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
                actionsDisabled={actionsDisabled}
              />
            ))}
          </div>
        )}
        {/* Add affordance disappears entirely when locked — keeps the
            grandfathered view clean without an inert dropdown. */}
        {!actionsDisabled && (
          <AddServiceOverride
            kind="review"
            services={data.services}
            existing={data.reviews.serviceRules.map((r) => r.serviceId).filter((v): v is string => v !== null)}
            onAdd={(serviceId) => createDraftReviewRule(serviceId, data.reviewPlatforms[0], refresh)}
          />
        )}
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
                actionsDisabled={actionsDisabled}
              />
            ))
          )}
        </div>
        {!actionsDisabled && (
          <AddFollowupRule
            services={data.services}
            triggerEvents={data.triggerEvents}
            onAdd={refresh}
          />
        )}
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
  actionsDisabled,
}: {
  scope: "tenant" | "service";
  serviceName?: string;
  rule: ReviewRule | null;
  platforms: string[];
  onSaved: () => void;
  actionsDisabled?: boolean;
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
    if (
      !(await confirmAction({
        title: "Remove this review-request rule?",
        body: "Customers will no longer be asked for a review after their appointment.",
        variant: "danger",
        confirmLabel: "Remove rule",
      }))
    ) {
      return;
    }
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
        {/* Mutation buttons hidden (not disabled) when capability locked,
            matching the RecurringClient lockdown pattern. Read-only view
            preserves the operator's visibility of grandfathered config. */}
        {!actionsDisabled && rule && (
          <button onClick={remove} disabled={saving} className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50">
            Remove
          </button>
        )}
        {actionsDisabled && rule && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
            title="Grandfathered — upgrade to manage this rule"
          >
            <Lock className="h-3 w-3" /> Grandfathered
          </span>
        )}
        <div className="ml-auto">
          {!actionsDisabled && (
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : rule ? "Save changes" : "Create rule"}</Button>
          )}
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
  actionsDisabled,
}: {
  rule: FollowupRule;
  serviceName?: string;
  triggerEvents: string[];
  onSaved: () => void;
  actionsDisabled?: boolean;
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
    if (
      !(await confirmAction({
        title: "Remove this follow-up rule?",
        body: "Existing scheduled follow-ups stay queued. New appointments won't trigger this rule.",
        variant: "danger",
        confirmLabel: "Remove rule",
      }))
    ) {
      return;
    }
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
        {!actionsDisabled ? (
          <>
            <button onClick={remove} disabled={saving} className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50">
              Remove
            </button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
            title="Grandfathered — upgrade to manage this rule"
          >
            <Lock className="h-3 w-3" /> Grandfathered
          </span>
        )}
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

// ─── Free-plan grandfather banner (mirrors RecurringClient Phase 6) ────
//
// Shown ABOVE the page chrome when a Free / Solo tenant has existing
// rules from a previous paid subscription. The cron continues to fire
// these rules (Phase 2 cron guards) so the banner is purely UX honesty:
// "your rules still work, but you cannot edit them without upgrading."

function GrandfatherBanner({
  cap,
  count,
}: {
  cap: { reason: string };
  count: number;
}) {
  return (
    <div className="rounded-xl border border-amber-200/70 bg-gradient-to-r from-amber-50 via-surface to-surface p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {count} automation{count === 1 ? " is" : "s are"} grandfathered from
            your previous subscription
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            Existing review requests and follow-ups continue to fire on every
            qualifying booking event. Upgrade to Pro to create new rules, edit
            existing ones, or activate new triggers.
          </p>
          <div className="mt-2 text-[11px] text-ink-subtle">{cap.reason}</div>
        </div>
        <Link
          href="/dashboard/billing"
          className="shrink-0 rounded-md bg-brand-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-brand-accent/90"
        >
          See plans
        </Link>
      </div>
    </div>
  );
}
