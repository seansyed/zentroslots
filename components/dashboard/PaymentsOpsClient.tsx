"use client";

/**
 * Operational Hardening Wave — Payment Ops dashboard.
 *
 * Enterprise operations console for the tenant payment vault.
 * Compact, information-dense, severity-coded.
 *
 * Sections (top → bottom):
 *   1. Hero severity strip + 4-panel metric tiles
 *   2. Provider health table (per-row status)
 *   3. Recent webhook events (cross-provider feed, last 20)
 *   4. Refund-eligible bookings (with confirmation-dialog refund)
 *   5. Orphan webhook events (manual review surface)
 *
 * NO secrets ever rendered. NO booking details beyond what an
 * admin already sees in the appointments tab.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";

interface ProviderHealthRow {
  id: string;
  provider: string;
  mode: string;
  accountLabel: string;
  status: string;
  enabled: boolean;
  isDefault: boolean;
  webhookStatus: string;
  lastVerifiedAt: string | null;
  lastPaymentEventAt: string | null;
  lastWebhookVerifiedAt: string | null;
  lastWebhookErrorAt: string | null;
}

interface Metrics {
  providers: ProviderHealthRow[];
  providersTotal: number;
  providersInvalid: number;
  providersWebhookFailing: number;
  providersStaleVerify7d: number;
  pendingPaymentBacklog: number;
  pendingActive: number;
  webhookFailures24h: number;
  orphans24h: number;
  lastWebhookEventAt: string | null;
}

interface WebhookEvent {
  id: string;
  providerId: string;
  provider: string;
  externalEventId: string;
  eventType: string;
  status: string;
  error: string | null;
  bookingId: string | null;
  receivedAt: string;
  processingDurationMs: number | null;
}

interface RefundEligibleBooking {
  id: string;
  startAt: string;
  endAt: string;
  clientName: string;
  clientEmail: string;
  amountChargedCents: number;
  stripePaymentIntentId: string | null;
  paymentProviderId: string | null;
  serviceName: string | null;
  providerKind: string | null;
  providerMode: string | null;
  providerLabel: string | null;
}

interface OrphanEvent {
  id: string;
  providerId: string;
  provider: string;
  externalEventId: string;
  eventType: string;
  status: string;
  error: string | null;
  receivedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "in the future";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function severityFromMetrics(m: Metrics): "ok" | "warn" | "crit" {
  if (
    m.providersInvalid > 0 ||
    m.providersWebhookFailing > 0 ||
    m.pendingPaymentBacklog > 0
  ) {
    return "crit";
  }
  if (
    m.providersStaleVerify7d > 0 ||
    m.webhookFailures24h > 0 ||
    m.orphans24h > 0
  ) {
    return "warn";
  }
  return "ok";
}

// ─── Main client ──────────────────────────────────────────────────────

export default function PaymentsOpsClient({
  initialMetrics,
}: {
  initialMetrics: Metrics;
}) {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [refundEligible, setRefundEligible] = useState<RefundEligibleBooking[]>([]);
  const [orphans, setOrphans] = useState<OrphanEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [confirmRefund, setConfirmRefund] = useState<RefundEligibleBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, e, r, o] = await Promise.all([
        fetch("/api/tenant/payment-ops/summary", { cache: "no-store" }),
        fetch("/api/tenant/payment-ops/recent-events?limit=20", { cache: "no-store" }),
        fetch("/api/tenant/payment-ops/refund-eligible?limit=25", { cache: "no-store" }),
        fetch("/api/tenant/payment-ops/orphans?limit=10", { cache: "no-store" }),
      ]);
      if (s.ok) {
        const d = await s.json();
        if (d.metrics) setMetrics(d.metrics);
      }
      if (e.ok) {
        const d = await e.json();
        setEvents(d.events ?? []);
      }
      if (r.ok) {
        const d = await r.json();
        setRefundEligible(d.bookings ?? []);
      }
      if (o.ok) {
        const d = await o.json();
        setOrphans(d.events ?? []);
      }
    } catch {
      setError("Failed to refresh ops data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Auto-clear toasts.
  useEffect(() => {
    if (!error && !success) return;
    const t = setTimeout(() => {
      setError(null);
      setSuccess(null);
    }, 5000);
    return () => clearTimeout(t);
  }, [error, success]);

  const severity = useMemo(() => severityFromMetrics(metrics), [metrics]);

  async function executeRefund(b: RefundEligibleBooking) {
    setRefunding(b.id);
    setError(null);
    try {
      const res = await fetch(`/api/tenant/bookings/${b.id}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(`Refund failed: ${data.reason ?? data.error ?? "unknown"}`);
        return;
      }
      setSuccess(
        `Refunded ${formatMoney(data.amountRefunded ?? b.amountChargedCents)} for ${b.clientName}.`,
      );
      setConfirmRefund(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refund failed");
    } finally {
      setRefunding(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Hero severity strip ── */}
      <SeverityHero severity={severity} metrics={metrics} onRefresh={loadAll} loading={loading} />

      {/* ── Toasts ── */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="h-4 w-4 text-red-600" /></button>
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-start gap-2">
          <Check className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess(null)}><X className="h-4 w-4 text-emerald-600" /></button>
        </div>
      )}

      {/* ── 4-panel metric grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricTile
          label="Webhook freshness"
          primary={formatRelative(metrics.lastWebhookEventAt)}
          secondary={
            metrics.providersTotal === 0
              ? "no providers configured"
              : metrics.lastWebhookEventAt
              ? "last verified event"
              : "no events yet"
          }
          severity={
            !metrics.lastWebhookEventAt
              ? "neutral"
              : Date.now() - new Date(metrics.lastWebhookEventAt).getTime() < 3_600_000
              ? "ok"
              : Date.now() - new Date(metrics.lastWebhookEventAt).getTime() < 86_400_000
              ? "warn"
              : "crit"
          }
        />
        <MetricTile
          label="Pending backlog"
          primary={`${metrics.pendingPaymentBacklog}`}
          secondary={`${metrics.pendingActive} active pending`}
          severity={metrics.pendingPaymentBacklog > 0 ? "crit" : "ok"}
          hint={metrics.pendingPaymentBacklog > 0 ? "expire-payment-holds cron may be failing" : undefined}
        />
        <MetricTile
          label="Webhook failures (24h)"
          primary={`${metrics.webhookFailures24h}`}
          secondary="invalid signatures"
          severity={
            metrics.webhookFailures24h === 0
              ? "ok"
              : metrics.webhookFailures24h < 5
              ? "warn"
              : "crit"
          }
        />
        <MetricTile
          label="Orphan events (24h)"
          primary={`${metrics.orphans24h}`}
          secondary="unmatched webhooks"
          severity={metrics.orphans24h === 0 ? "ok" : "warn"}
          hint={metrics.orphans24h > 0 ? "manual review below" : undefined}
        />
      </div>

      {/* ── Provider health table ── */}
      <Section title="Provider health" count={metrics.providers.length}>
        {metrics.providers.length === 0 ? (
          <EmptyState message="No payment providers configured yet. See Settings → Payments." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase tracking-wide">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3">Provider</th>
                  <th className="text-left py-2 px-3">Mode</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Webhook</th>
                  <th className="text-left py-2 px-3">Last verified</th>
                  <th className="text-left py-2 px-3">Last payment</th>
                </tr>
              </thead>
              <tbody>
                {metrics.providers.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-900">{p.provider}</div>
                      {p.accountLabel && (
                        <div className="text-xs text-slate-500">{p.accountLabel}</div>
                      )}
                    </td>
                    <td className="py-2 px-3"><ModeChip mode={p.mode} /></td>
                    <td className="py-2 px-3 flex items-center gap-1.5">
                      <StatusDot status={p.status} />
                      <span className="text-slate-700">{p.status}</span>
                      {!p.enabled && <span className="ml-1 text-xs text-slate-400">(disabled)</span>}
                      {p.isDefault && (
                        <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                          default
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <WebhookDot status={p.webhookStatus} />
                      <span className="ml-1 text-slate-700">{p.webhookStatus}</span>
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">
                      {formatRelative(p.lastVerifiedAt)}
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">
                      {formatRelative(p.lastPaymentEventAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Recent webhook events ── */}
      <Section title="Recent webhook activity" count={events.length}>
        {events.length === 0 ? (
          <EmptyState message="No webhook events recorded yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase tracking-wide">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Event</th>
                  <th className="text-left py-2 px-3">Provider</th>
                  <th className="text-left py-2 px-3">Booking</th>
                  <th className="text-left py-2 px-3">Received</th>
                  <th className="text-left py-2 px-3">Duration</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2 px-3"><EventStatusPill status={ev.status} /></td>
                    <td className="py-2 px-3 font-mono text-xs text-slate-800 max-w-xs truncate">{ev.eventType}</td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{ev.provider}</td>
                    <td className="py-2 px-3 font-mono text-[10px] text-slate-500">
                      {ev.bookingId ? ev.bookingId.slice(0, 8) + "…" : "—"}
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{formatRelative(ev.receivedAt)}</td>
                    <td className="py-2 px-3 text-slate-500 text-xs">
                      {ev.processingDurationMs !== null ? `${ev.processingDurationMs}ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Refund-eligible bookings ── */}
      <Section title="Refund-eligible bookings" count={refundEligible.length}>
        {refundEligible.length === 0 ? (
          <EmptyState message="No confirmed Wave H bookings available for refund right now." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase tracking-wide">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3">Customer</th>
                  <th className="text-left py-2 px-3">Service</th>
                  <th className="text-left py-2 px-3">When</th>
                  <th className="text-left py-2 px-3">Provider</th>
                  <th className="text-right py-2 px-3">Amount</th>
                  <th className="text-right py-2 px-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {refundEligible.map((b) => (
                  <tr key={b.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-900">{b.clientName}</div>
                      <div className="text-xs text-slate-500">{b.clientEmail}</div>
                    </td>
                    <td className="py-2 px-3 text-slate-700">{b.serviceName ?? "—"}</td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{formatRelative(b.startAt)}</td>
                    <td className="py-2 px-3 text-xs">
                      <span className="text-slate-700">{b.providerKind ?? "?"}</span>
                      {b.providerMode && (
                        <span className="ml-1">
                          <ModeChip mode={b.providerMode} />
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-medium text-slate-900">
                      {formatMoney(b.amountChargedCents)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => setConfirmRefund(b)}
                        disabled={refunding === b.id}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        {refunding === b.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Refund
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Orphan events ── */}
      <Section title="Orphan webhook events (manual review)" count={orphans.length}>
        {orphans.length === 0 ? (
          <EmptyState message="No orphan webhook events. (Events that arrived but couldn't be attached to a booking.)" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase tracking-wide">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Event type</th>
                  <th className="text-left py-2 px-3">Provider</th>
                  <th className="text-left py-2 px-3">External id</th>
                  <th className="text-left py-2 px-3">Received</th>
                </tr>
              </thead>
              <tbody>
                {orphans.map((ev) => (
                  <tr key={ev.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2 px-3"><EventStatusPill status={ev.status} /></td>
                    <td className="py-2 px-3 font-mono text-xs text-slate-800">{ev.eventType}</td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{ev.provider}</td>
                    <td className="py-2 px-3 font-mono text-[10px] text-slate-500 max-w-xs truncate">
                      {ev.externalEventId}
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{formatRelative(ev.receivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Refund confirmation dialog ── */}
      {confirmRefund && (
        <RefundConfirmDialog
          booking={confirmRefund}
          busy={refunding === confirmRefund.id}
          onCancel={() => setConfirmRefund(null)}
          onConfirm={() => executeRefund(confirmRefund)}
        />
      )}
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function SeverityHero({
  severity,
  metrics,
  onRefresh,
  loading,
}: {
  severity: "ok" | "warn" | "crit";
  metrics: Metrics;
  onRefresh: () => void;
  loading: boolean;
}) {
  const colors =
    severity === "crit"
      ? "border-red-300 bg-red-50"
      : severity === "warn"
      ? "border-amber-300 bg-amber-50"
      : "border-emerald-300 bg-emerald-50";
  const Icon = severity === "crit" ? ShieldAlert : severity === "warn" ? AlertTriangle : ShieldCheck;
  const text = severity === "crit"
    ? "Critical: payment subsystem requires attention"
    : severity === "warn"
    ? "Degraded: review the indicators below"
    : metrics.providersTotal === 0
    ? "Idle: no providers configured yet"
    : "All clear: payment subsystem nominal";
  const iconColor =
    severity === "crit" ? "text-red-700" : severity === "warn" ? "text-amber-700" : "text-emerald-700";

  return (
    <div className={`rounded-2xl border p-5 ${colors} flex items-center justify-between gap-4 flex-wrap`}>
      <div className="flex items-center gap-3">
        <Icon className={`h-6 w-6 ${iconColor}`} />
        <div>
          <div className="font-semibold text-slate-900">{text}</div>
          <div className="text-xs text-slate-600 mt-0.5">
            {metrics.providersTotal} provider{metrics.providersTotal === 1 ? "" : "s"} ·
            {" "}{metrics.providersInvalid} invalid ·
            {" "}{metrics.providersWebhookFailing} webhook failing ·
            {" "}{metrics.providersStaleVerify7d} stale
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        Refresh
      </button>
    </div>
  );
}

function MetricTile({
  label,
  primary,
  secondary,
  severity,
  hint,
}: {
  label: string;
  primary: string;
  secondary: string;
  severity: "ok" | "warn" | "crit" | "neutral";
  hint?: string;
}) {
  const bar =
    severity === "crit"
      ? "bg-red-500"
      : severity === "warn"
      ? "bg-amber-500"
      : severity === "ok"
      ? "bg-emerald-500"
      : "bg-slate-300";
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className={`h-1 ${bar}`} />
      <div className="p-4">
        <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</div>
        <div className="mt-1 text-xl font-semibold text-slate-900">{primary}</div>
        <div className="text-xs text-slate-500 mt-0.5">{secondary}</div>
        {hint && (
          <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            <AlertCircle className="inline h-3 w-3 mr-1" />{hint}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-2.5 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {count !== undefined && (
          <span className="text-xs text-slate-500">{count}</span>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="p-6 text-sm text-slate-500 italic text-center">{message}</div>;
}

function ModeChip({ mode }: { mode: string }) {
  if (mode === "live") {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-300">LIVE</span>;
  }
  return <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide bg-amber-100 text-amber-800 border border-amber-300">TEST</span>;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "verified" ? "bg-emerald-500"
    : status === "pending" ? "bg-amber-500"
    : status === "invalid" ? "bg-red-500"
    : "bg-slate-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function WebhookDot({ status }: { status: string }) {
  const color =
    status === "verified" ? "bg-emerald-500"
    : status === "configured" ? "bg-blue-500"
    : status === "failing" ? "bg-red-500"
    : "bg-slate-300";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function EventStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    processed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    received: "bg-blue-50 text-blue-700 border-blue-200",
    replay: "bg-slate-50 text-slate-600 border-slate-200",
    invalid_signature: "bg-red-50 text-red-700 border-red-200",
    unhandled: "bg-amber-50 text-amber-700 border-amber-200",
    orphan: "bg-amber-50 text-amber-700 border-amber-200",
  };
  const cls = map[status] ?? "bg-slate-50 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {status}
    </span>
  );
}

// ─── Refund confirmation dialog ───────────────────────────────────────

function RefundConfirmDialog({
  booking,
  busy,
  onCancel,
  onConfirm,
}: {
  booking: RefundEligibleBooking;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-red-600" />
            <h2 className="text-lg font-semibold text-slate-900">Confirm refund</h2>
          </div>
          <button onClick={onCancel} disabled={busy}>
            <X className="h-5 w-5 text-slate-400 hover:text-slate-700" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-sm text-slate-700">
            This will issue a <strong>full refund</strong> via {booking.providerKind} ({booking.providerMode}) and mark the booking as refunded.
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Customer</span>
              <span className="font-medium text-slate-900">{booking.clientName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Email</span>
              <span className="text-slate-700">{booking.clientEmail}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Service</span>
              <span className="text-slate-700">{booking.serviceName ?? "—"}</span>
            </div>
            <div className="border-t border-slate-200 pt-2 flex items-center justify-between">
              <span className="text-slate-500">Refund amount</span>
              <span className="font-semibold text-red-700 text-lg">
                {formatMoney(booking.amountChargedCents)}
              </span>
            </div>
          </div>
          <div className="text-xs text-slate-500 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-600 flex-shrink-0" />
            <span>
              This is irreversible from our side. The customer will receive their refund
              according to {booking.providerKind === "stripe" ? "Stripe's" : "PayPal's"} normal timeline (typically 5–10 business days).
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-4 bg-slate-50/50 rounded-b-2xl">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Confirm refund
          </button>
        </div>
      </div>
    </div>
  );
}

// Force inclusion of unused imports so future expansion compiles.
void Clock;
void CheckCircle2;
void Zap;
