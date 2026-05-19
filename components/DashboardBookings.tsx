"use client";

import { useState, useTransition } from "react";
import { formatInTimeZone } from "date-fns-tz";
import StatusBadge from "@/components/StatusBadge";

type Row = {
  id: string;
  startAt: string;
  endAt: string;
  // Widened for paid-booking lifecycle (0030) — additive states.
  status:
    | "pending"
    | "confirmed"
    | "cancelled"
    | "completed"
    | "no_show"
    | "pending_payment"
    | "payment_failed"
    | "refunded";
  clientName: string;
  clientEmail: string;
  meetLink: string | null;
  serviceName: string;
  staffUserId: string;
};

export default function DashboardBookings({
  rows: initialRows,
  canManage,
  userTimezone,
}: {
  rows: Row[];
  canManage: boolean;
  userTimezone: string;
}) {
  const [rows, setRows] = useState(initialRows);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function callAction(id: string, kind: "cancel" | "complete" | "no_show") {
    setError(null);
    startTransition(async () => {
      let res: Response;
      if (kind === "cancel") {
        res = await fetch(`/api/bookings/${id}/cancel`, { method: "POST" });
      } else {
        res = await fetch(`/api/bookings/${id}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: kind === "complete" ? "completed" : "no_show" }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Action failed");
        return;
      }
      setRows((cur) =>
        cur.map((r) => (r.id === id ? { ...r, status: data.status ?? r.status } : r))
      );
    });
  }

  return (
    <div className="mt-4 overflow-hidden rounded-lg border bg-white shadow-sm">
      {error && <div className="border-b bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {rows.length === 0 && (
        <div className="p-8 text-center text-sm text-slate-500">No bookings.</div>
      )}
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Service</th>
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="border-t align-top">
                <td className="px-4 py-2 text-xs">
                  <div className="font-medium text-slate-900">
                    {formatInTimeZone(b.startAt, userTimezone, "MMM d, h:mm a")}
                  </div>
                  <div className="text-slate-400">
                    {formatInTimeZone(b.startAt, userTimezone, "EEE • zzz")}
                  </div>
                </td>
                <td className="px-4 py-2">{b.serviceName}</td>
                <td className="px-4 py-2">
                  {b.clientName}
                  <div className="text-xs text-slate-500">{b.clientEmail}</div>
                </td>
                <td className="px-4 py-2">
                  <StatusBadge status={b.status} />
                </td>
                <td className="px-4 py-2">
                  {canManage && b.status === "confirmed" && (
                    <div className="flex flex-wrap gap-1">
                      <button
                        onClick={() => callAction(b.id, "complete")}
                        disabled={pending}
                        className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        Complete
                      </button>
                      <button
                        onClick={() => callAction(b.id, "no_show")}
                        disabled={pending}
                        className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        No-show
                      </button>
                      <button
                        onClick={() => callAction(b.id, "cancel")}
                        disabled={pending}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {b.meetLink && (
                    <a
                      href={b.meetLink}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs text-brand-accent hover:underline"
                    >
                      Meet ↗
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
