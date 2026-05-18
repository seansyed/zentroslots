"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";

import { Badge } from "@/components/ui/primitives";
import AppointmentDrawer, { type DrawerBooking } from "@/components/dashboard/AppointmentDrawer";
import { STATUS_BADGE, STATUS_LABEL, type Status } from "@/lib/status-colors";

export type Row = {
  id: string;
  startAt: string;
  endAt: string;
  status: Status;
  clientName: string;
  clientEmail: string;
  meetLink: string | null;
  notes: string | null;
  serviceId: string;
  serviceName: string;
  staffId: string;
  staffName: string;
};

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "",          label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "pending",   label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show",   label: "No-show" },
];

export default function AppointmentsTable({
  rows: initialRows,
  timezone,
  canManage,
  canCancel,
  currentStatus,
  nextCursor,
}: {
  rows: Row[];
  timezone: string;
  canManage: boolean;
  /** Tenant feature toggle. When false, the drawer hides the Cancel
   *  button (and the API would 403 anyway). Defaults true at the
   *  prop site for callers that haven't been updated yet. */
  canCancel?: boolean;
  currentStatus: string;
  nextCursor: string | null;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [rows, setRows] = React.useState(initialRows);
  React.useEffect(() => setRows(initialRows), [initialRows]);
  const [drawer, setDrawer] = React.useState<DrawerBooking | null>(null);

  function setStatusFilter(s: string) {
    const url = new URL(window.location.href);
    if (s) url.searchParams.set("status", s);
    else url.searchParams.delete("status");
    url.searchParams.delete("cursor");
    router.push(url.pathname + (url.search || ""));
  }

  function goNext() {
    if (!nextCursor) return;
    const url = new URL(window.location.href);
    url.searchParams.set("cursor", nextCursor);
    router.push(url.pathname + url.search);
  }

  function goFirst() {
    const url = new URL(window.location.href);
    url.searchParams.delete("cursor");
    router.push(url.pathname + (url.search || ""));
  }

  function openRow(r: Row) {
    setDrawer({
      id: r.id,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status,
      clientName: r.clientName,
      clientEmail: r.clientEmail,
      notes: r.notes,
      meetLink: r.meetLink,
      serviceName: r.serviceName,
      staffName: r.staffName,
    });
  }

  return (
    <div className="mt-6">
      {/* Status tabs as filter chips */}
      <div className="flex flex-wrap gap-1">
        {STATUS_TABS.map((t) => {
          const active = currentStatus === t.value;
          return (
            <button
              key={t.value}
              onClick={() => setStatusFilter(t.value)}
              className={
                "rounded-md px-3 py-1 text-xs font-medium transition " +
                (active
                  ? "bg-brand-accent text-white"
                  : "border border-border bg-surface text-ink-muted hover:bg-surface-inset hover:text-ink")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        {rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-ink-muted">No appointments match this filter.</div>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full text-sm sm:table">
              <thead className="bg-surface-subtle text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="px-4 py-2.5">When</th>
                  <th className="px-4 py-2.5">Service</th>
                  <th className="px-4 py-2.5">Staff</th>
                  <th className="px-4 py-2.5">Client</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => openRow(r)}
                    className="cursor-pointer border-t border-border align-top transition hover:bg-surface-inset/60"
                  >
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-ink">
                        {formatInTimeZone(r.startAt, timezone, "MMM d, h:mm a")}
                      </div>
                      <div className="text-xs text-ink-subtle">
                        {formatInTimeZone(r.startAt, timezone, "EEE · zzz")}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-ink">{r.serviceName}</td>
                    <td className="px-4 py-3 text-ink-muted">{r.staffName}</td>
                    <td className="px-4 py-3">
                      <div className="text-ink">{r.clientName}</div>
                      <div className="text-xs text-ink-subtle">{r.clientEmail}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={STATUS_BADGE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile card list */}
            <ul className="divide-y divide-border sm:hidden">
              {rows.map((r) => (
                <li key={r.id} onClick={() => openRow(r)} className="cursor-pointer p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">{r.serviceName}</div>
                      <div className="text-xs text-ink-muted">{r.clientName}</div>
                      <div className="mt-1 text-xs text-ink-subtle">
                        {formatInTimeZone(r.startAt, timezone, "MMM d, h:mm a zzz")}
                      </div>
                    </div>
                    <Badge className={STATUS_BADGE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="text-ink-subtle">{rows.length} shown</div>
        <div className="flex gap-2">
          {sp.get("cursor") && (
            <button onClick={goFirst} className="rounded border border-border bg-surface px-3 py-1 text-ink hover:bg-surface-inset">
              ← Back to start
            </button>
          )}
          {nextCursor && (
            <button onClick={goNext} className="rounded border border-border bg-surface px-3 py-1 text-ink hover:bg-surface-inset">
              Next page →
            </button>
          )}
        </div>
      </div>

      <AppointmentDrawer
        booking={drawer}
        timezone={timezone}
        canManage={canManage}
        canCancel={canCancel !== false}
        onClose={() => setDrawer(null)}
        onChanged={(next) => {
          setDrawer(next);
          setRows((cur) => cur.map((r) => (r.id === next.id ? { ...r, status: next.status } : r)));
        }}
      />
    </div>
  );
}
