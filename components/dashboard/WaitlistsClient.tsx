"use client";

import * as React from "react";

import { Badge, Card, Skeleton, toast } from "@/components/ui/primitives";

type Entry = {
  id: string;
  serviceId: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string | null;
  preferredDate: string | null;
  preferredTimeRange: string;
  status: string;
  priority: number;
  expiresAt: string | null;
  claimedAt: string | null;
  claimedBookingId: string | null;
  createdAt: string;
  serviceName: string | null;
};

type Notif = {
  id: string;
  waitlistId: string;
  bookingId: string | null;
  notificationType: string;
  status: string;
  slotStartAt: string | null;
  slotEndAt: string | null;
  expiresAt: string;
  respondedAt: string | null;
  createdAt: string;
};

type Service = { id: string; name: string; slug: string };

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "neutral" | "blue" | "violet"> = {
  waiting: "blue",
  notified: "amber",
  claimed: "green",
  expired: "neutral",
  cancelled: "red",
};

const STATUS_TABS = ["all", "waiting", "notified", "claimed", "expired", "cancelled"] as const;

export default function WaitlistsClient() {
  const [data, setData] = React.useState<{ entries: Entry[]; notifications: Notif[]; services: Service[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [status, setStatus] = React.useState<(typeof STATUS_TABS)[number]>("all");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const url = status === "all"
        ? "/api/tenant/waitlists"
        : `/api/tenant/waitlists?status=${status}`;
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

  async function action(id: string, kind: "cancel" | "expire_hold") {
    if (!confirm(kind === "cancel" ? "Remove this customer from the waitlist?" : "Force-expire this reservation hold?")) return;
    try {
      const res = await fetch("/api/tenant/waitlists", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: kind }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Updated", "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  }

  return (
    <div className="mt-6 space-y-6">
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

      <section>
        <h2 className="text-sm font-semibold text-ink">Queue</h2>
        {loading || !data ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : data.entries.length === 0 ? (
          <Card className="mt-3 p-6 text-center text-sm text-ink-muted">
            No one is on the waitlist yet.
          </Card>
        ) : (
          <ul className="mt-3 space-y-2">
            {data.entries.map((e) => (
              <li key={e.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{e.customerName}</span>
                        <span className="text-xs text-ink-muted">{e.customerEmail}</span>
                        <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-ink-muted">
                        {e.serviceName ?? e.serviceId}
                        {e.preferredDate && <> · prefers {e.preferredDate}</>}
                        {e.preferredTimeRange !== "any" && <> · {e.preferredTimeRange}</>}
                        {" · joined "}{timeAgo(e.createdAt)}
                      </div>
                      {e.status === "notified" && e.expiresAt && (
                        <div className="mt-1 text-[11px] text-amber-700">
                          Hold expires {new Date(e.expiresAt).toLocaleString()}
                        </div>
                      )}
                      {e.status === "claimed" && e.claimedBookingId && (
                        <div className="mt-1 text-[11px] text-green-700">
                          Claimed → booking <span className="font-mono">{e.claimedBookingId.slice(0, 8)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {e.status === "notified" && (
                        <button
                          onClick={() => action(e.id, "expire_hold")}
                          className="rounded-md border border-border bg-surface px-3 py-1 text-xs text-ink-muted hover:bg-surface-inset"
                        >
                          Expire hold
                        </button>
                      )}
                      {(e.status === "waiting" || e.status === "notified") && (
                        <button
                          onClick={() => action(e.id, "cancel")}
                          className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-ink">Recent activity</h2>
        {data && data.notifications.length === 0 ? (
          <Card className="mt-3 p-6 text-center text-sm text-ink-muted">
            No notifications sent yet.
          </Card>
        ) : (
          data && (
            <Card className="mt-3 overflow-hidden p-0">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Slot</th>
                    <th className="px-3 py-2">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {data.notifications.map((n) => (
                    <tr key={n.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 whitespace-nowrap">{timeAgo(n.createdAt)}</td>
                      <td className="px-3 py-2">{n.notificationType}</td>
                      <td className="px-3 py-2">
                        <Badge tone={STATUS_TONE[n.status] ?? "neutral"}>{n.status}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {n.slotStartAt ? new Date(n.slotStartAt).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2">{new Date(n.expiresAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        )}
      </section>
    </div>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
