"use client";

/**
 * Business Line settings (increment 3 — settings surface only).
 *
 * Loads /api/tenant/business-line and lets an admin view the assigned number,
 * set a forwarding number, and enable/disable forwarding. When there is no
 * entitlement the controls render in a locked/upgrade state. NO calls are
 * placed, NO numbers are provisioned, and Telnyx is never contacted from here.
 */

import * as React from "react";
import {
  Phone,
  PhoneForwarded,
  Lock,
  ShieldAlert,
  PhoneMissed,
  Loader2,
} from "lucide-react";

import { Card, CardHeader, Button, Badge, Skeleton, toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import type { BusinessLineView } from "@/lib/business-line-view";

export default function BusinessLineClient() {
  const [view, setView] = React.useState<BusinessLineView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [forwarding, setForwarding] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/tenant/business-line", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as BusinessLineView;
      setView(data);
      setForwarding(data.settings.forwardingNumber ?? "");
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const locked = view?.entitlement.locked ?? true;

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch("/api/tenant/business-line", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as { error?: string })?.error ?? "Update failed");
    }
    return true;
  }

  async function saveForwarding() {
    setSaving(true);
    try {
      await patch({ forwardingNumber: forwarding.trim() === "" ? null : forwarding.trim() });
      toast("Forwarding number saved.", "success");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    if (!view) return;
    setToggling(true);
    const next = !view.settings.enabled;
    try {
      await patch({ enabled: next });
      toast(next ? "Forwarding enabled." : "Forwarding disabled.", "success");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (loadError || !view) {
    return (
      <div className="max-w-2xl">
        <Card>
          <CardHeader
            title="Business Line isn't available yet"
            subtitle="This feature is being set up. Check back soon."
          />
          <div className="mt-4">
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const { number, settings, usage, recentCalls } = view;

  return (
    <div className="max-w-2xl space-y-5">
      {/* Locked / upgrade banner */}
      {locked && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200/70 bg-amber-50 p-4 text-amber-800">
          <Lock className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.75} />
          <div className="text-sm">
            <div className="font-medium">Business Line is a paid add-on</div>
            <p className="mt-0.5 text-amber-700">
              Add a ZentroMeet business number that rings your phone. Forwarding is
              disabled until the add-on is active on your plan.
            </p>
          </div>
        </div>
      )}

      {/* Business Phone card */}
      <Card>
        <div className="flex items-center justify-between">
          <CardHeader title="Business Phone" subtitle="Your ZentroMeet business number and call forwarding." />
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
            <Phone className="h-5 w-5" strokeWidth={1.75} />
          </span>
        </div>

        {/* Assigned number */}
        <div className="mt-4 rounded-lg border border-border bg-surface-inset/40 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
            Assigned number
          </div>
          {number ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-lg font-semibold text-ink">{number.phoneNumber}</span>
              <Badge tone={number.status === "active" ? "green" : "neutral"} className="capitalize">
                {number.status}
              </Badge>
            </div>
          ) : (
            <div className="mt-1 text-sm text-ink-muted">No number assigned yet.</div>
          )}
        </div>

        {/* Forwarding number */}
        <div className="mt-4">
          <label htmlFor="bl-forwarding" className="block text-sm font-medium text-ink">
            Forwarding number
          </label>
          <p className="mt-0.5 text-xs text-ink-muted">
            Incoming calls ring this phone. US &amp; Canada numbers only.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              id="bl-forwarding"
              type="tel"
              inputMode="tel"
              placeholder="+1 (555) 123-4567"
              value={forwarding}
              disabled={locked || saving}
              onChange={(e) => setForwarding(e.target.value)}
              className={cn(
                "h-10 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-brand-accent",
                (locked || saving) && "cursor-not-allowed opacity-60",
              )}
            />
            <Button
              variant="primary"
              onClick={() => void saveForwarding()}
              disabled={locked || saving || forwarding === (settings.forwardingNumber ?? "")}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>

        {/* Enable toggle */}
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex items-center gap-2">
            <PhoneForwarded className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
            <div>
              <div className="text-sm font-medium text-ink">Call forwarding</div>
              <div className="text-xs text-ink-muted">
                {settings.enabled ? "Enabled" : "Disabled"} for your business line.
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            disabled={locked || toggling}
            onClick={() => void toggleEnabled()}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
              settings.enabled ? "bg-brand-accent" : "bg-surface-inset",
              (locked || toggling) && "cursor-not-allowed opacity-60",
            )}
          >
            <span
              className={cn(
                "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                settings.enabled ? "translate-x-5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </Card>

      {/* Usage this month */}
      <Card>
        <CardHeader title="Usage this month" subtitle={`Billing period ${usage.period}.`} />
        <div className="mt-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-ink">
              <span className="font-semibold">{usage.minutesUsed}</span> / {usage.cap} minutes
            </span>
            <span className="text-ink-muted">{usage.percentUsed}%</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-inset">
            <div
              className={cn("h-full rounded-full", usage.overCap ? "bg-red-500" : "bg-brand-accent")}
              style={{ width: `${usage.percentUsed}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-muted">
            <span>{usage.inboundCalls} inbound</span>
            <span>{usage.answeredCalls} answered</span>
            <span className="inline-flex items-center gap-1">
              <PhoneMissed className="h-3.5 w-3.5" /> {usage.missedCalls} missed
            </span>
          </div>
        </div>
      </Card>

      {/* Recent calls */}
      <Card>
        <CardHeader title="Recent calls" subtitle="Most recent inbound calls to your business line." />
        {recentCalls.length === 0 ? (
          <div className="mt-3 text-sm text-ink-muted">No calls yet.</div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {recentCalls.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  {c.missed ? (
                    <PhoneMissed className="h-4 w-4 text-red-500" strokeWidth={1.75} />
                  ) : (
                    <Phone className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
                  )}
                  <span className="font-medium text-ink">{c.fromNumber ?? "Unknown"}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-ink-muted">
                  <span className="capitalize">{c.status.replace(/_/g, " ")}</span>
                  <span>{formatDuration(c.durationSeconds)}</span>
                  <span>{formatTime(c.startedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Emergency disclaimer */}
      <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-inset/40 p-4 text-xs text-ink-muted">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
        <p>
          <span className="font-semibold text-ink">This is not an emergency calling service.</span>{" "}
          Do not use it to call 911 or any emergency number. The Business Line forwards
          inbound calls only and does not provide emergency (E911) location services.
        </p>
      </div>
    </div>
  );
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
