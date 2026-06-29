"use client";

/**
 * Business Line settings + call logs (increments 3 & 5).
 *
 * Loads /api/tenant/business-line (number / forwarding / usage) and
 * /api/tenant/business-line/calls (paginated, filterable call log). Lets an
 * admin set a forwarding number and enable/disable forwarding; shows usage and
 * a recent-calls table with missed highlighting. When there is no entitlement
 * the controls render locked. NO calls are placed, NO numbers are provisioned,
 * and Telnyx is never contacted from here.
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
import { businessLineAddonCopy, type BusinessLineView } from "@/lib/business-line-view";
import { BUSINESS_PHONE_EMERGENCY_NOTICE } from "@/lib/business-phone-ui";
import {
  callStatusLabel,
  callStatusTone,
  formatCallDuration,
  type CallLogRowView,
} from "@/lib/business-line-calls";

const CALL_FILTERS = ["all", "completed", "missed", "answered", "failed", "rejected"] as const;

export default function BusinessLineClient() {
  const [view, setView] = React.useState<BusinessLineView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [forwarding, setForwarding] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);

  // Call-log table state.
  const [calls, setCalls] = React.useState<CallLogRowView[]>([]);
  const [callsLoading, setCallsLoading] = React.useState(true);
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [hasMore, setHasMore] = React.useState(false);

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

  const fetchCalls = React.useCallback(async (status: string, offset: number, append: boolean) => {
    setCallsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "25", offset: String(offset) });
      if (status !== "all") params.set("status", status);
      const res = await fetch(`/api/tenant/business-line/calls?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("calls load failed");
      const data = (await res.json()) as { calls: CallLogRowView[]; hasMore: boolean };
      setCalls((cur) => (append ? [...cur, ...data.calls] : data.calls));
      setHasMore(data.hasMore);
    } catch {
      // Soft-fail: the settings card still works even if the log can't load.
      if (!append) setCalls([]);
      setHasMore(false);
    } finally {
      setCallsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    void fetchCalls(statusFilter, 0, false);
  }, [statusFilter, fetchCalls]);

  const locked = view?.entitlement.locked ?? true;

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch("/api/tenant/business-line", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string })?.error ?? "Update failed");
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
          <CardHeader title="Business Phone isn't available yet" subtitle="This feature is being set up. Check back soon." />
          <div className="mt-4">
            <Button variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const { number, settings, usage } = view;
  const addonCopy = businessLineAddonCopy(view.entitlement);

  return (
    <div className="max-w-2xl space-y-5">
      {/* Locked / upgrade banner */}
      {locked && (
        <div className="rounded-xl border border-amber-200/70 bg-amber-50 p-4 text-amber-800">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.75} />
            <div className="flex-1 text-sm">
              <div className="font-medium">
                {addonCopy.title} — {addonCopy.price}
              </div>
              <p className="mt-0.5 text-amber-700">
                Add a ZentroMeet business number that rings your phone. Includes {addonCopy.minutes}{" "}
                with a hard cap (no surprise overage). {addonCopy.reasonText}
              </p>
              <a
                href="/dashboard/phone"
                className="mt-3 inline-flex h-8 items-center rounded-lg bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700"
              >
                Add Business Phone
              </a>
            </div>
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

        <div className="mt-4 rounded-lg border border-border bg-surface-inset/40 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Assigned number</div>
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

        <div className="mt-4">
          <label htmlFor="bl-forwarding" className="block text-sm font-medium text-ink">
            Forwarding number
          </label>
          <p className="mt-0.5 text-xs text-ink-muted">Incoming calls ring this phone. US &amp; Canada numbers only.</p>
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
            <span className={cn("text-ink-muted", usage.overCap && "font-medium text-red-600")}>
              {usage.percentUsed}%{usage.overCap ? " · cap reached" : ""}
            </span>
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

      {/* Call log */}
      <Card>
        <CardHeader title="Recent calls" subtitle="Inbound calls to your business line." />

        {/* Status filter chips */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {CALL_FILTERS.map((f) => {
            const active = statusFilter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  active ? "bg-brand-accent text-white" : "bg-surface-inset text-ink-muted hover:text-ink",
                )}
              >
                {f === "all" ? "All" : callStatusLabel(f)}
              </button>
            );
          })}
        </div>

        {callsLoading && calls.length === 0 ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : calls.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-ink-muted">
            {statusFilter === "all" ? "No calls yet." : `No ${callStatusLabel(statusFilter).toLowerCase()} calls.`}
          </div>
        ) : (
          <>
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-inset/50 text-left text-[11px] uppercase tracking-wide text-ink-subtle">
                  <tr>
                    <th className="px-3 py-2 font-semibold">From</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 font-semibold">Duration</th>
                    <th className="px-3 py-2 text-right font-semibold">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {calls.map((c) => (
                    <tr key={c.id} className={cn(c.missed && "bg-red-50/60")}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {c.missed ? (
                            <PhoneMissed className="h-4 w-4 text-red-500" strokeWidth={1.75} />
                          ) : (
                            <Phone className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
                          )}
                          <span className="font-medium text-ink">{c.fromNumber ?? "Unknown"}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={callStatusTone(c.status)}>{callStatusLabel(c.status)}</Badge>
                      </td>
                      <td className="px-3 py-2 text-ink-muted">{formatCallDuration(c.durationSeconds)}</td>
                      <td className="px-3 py-2 text-right text-xs text-ink-muted">{formatTime(c.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <div className="mt-3 text-center">
                <Button
                  variant="secondary"
                  onClick={() => void fetchCalls(statusFilter, calls.length, true)}
                  disabled={callsLoading}
                >
                  {callsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Emergency disclaimer */}
      <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-inset/40 p-4 text-xs text-ink-muted">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
        <p>{BUSINESS_PHONE_EMERGENCY_NOTICE}</p>
      </div>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
