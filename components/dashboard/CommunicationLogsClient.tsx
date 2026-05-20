"use client";

import * as React from "react";
import Link from "next/link";

import { Badge, Drawer } from "@/components/ui/primitives";

type LogRow = {
  id: string;
  tenantId: string;
  bookingId: string | null;
  customerId: string | null;
  templateId: string | null;
  channel: string;
  eventType: string;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  failureReason: string | null;
  skippedReason: string | null;
  sentAt: string | null;
  createdAt: string;
};

const STATUS_TONES: Record<string, "green" | "amber" | "red" | "neutral"> = {
  sent: "green",
  delivered: "green",
  queued: "amber",
  skipped: "neutral",
  failed: "red",
  suppressed: "neutral",
};

const STATUS_OPTIONS = ["all", "sent", "failed", "skipped"] as const;

const KIND_LABELS: Record<string, string> = {
  "appointment.created": "Confirmation",
  "appointment.cancelled": "Cancellation",
  "appointment.rescheduled": "Reschedule",
  "appointment.reminder_24h": "Reminder · 24h",
  "appointment.reminder_1h": "Reminder · 1h",
};

export default function CommunicationLogsClient({
  rows,
  statusFilter,
  eventFilter,
  search,
  eventTypes,
}: {
  rows: LogRow[];
  statusFilter: string;
  eventFilter: string;
  search: string;
  eventTypes: string[];
}) {
  const [openRow, setOpenRow] = React.useState<LogRow | null>(null);

  // The search box is a controlled input — debounced into the URL so a
  // stop typing for ~400ms re-runs the server query. Until then the
  // user sees their typed value reflected without a flash.
  const [searchInput, setSearchInput] = React.useState(search);
  React.useEffect(() => {
    // Keep input in sync if the parent re-renders with a fresh value
    // (e.g. after using browser back).
    setSearchInput(search);
  }, [search]);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  function onSearchChange(next: string) {
    setSearchInput(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("q", next);
      else url.searchParams.delete("q");
      window.location.assign(url.pathname + url.search);
    }, 400);
  }

  function buildHref(over: { status?: string; event?: string; q?: string }) {
    const sp = new URLSearchParams();
    const status = over.status ?? statusFilter;
    if (status && status !== "all") sp.set("status", status);
    const ev = over.event ?? eventFilter;
    if (ev) sp.set("event", ev);
    const q = over.q ?? search;
    if (q) sp.set("q", q);
    const qs = sp.toString();
    return qs ? `?${qs}` : "/dashboard/settings/communications/logs";
  }

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Delivery logs</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every scheduling email this workspace tried to send. Shows up to 200 most recent.
          </p>
        </div>
        <Link
          href="/dashboard/settings/communications/templates"
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-inset"
        >
          Edit templates →
        </Link>
      </div>

      {/* Search + filters bar */}
      <div className="mt-4 space-y-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by customer name, email, or booking ID…"
          aria-label="Search delivery logs"
          className="w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200 sm:w-80"
        />
        <div className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((s) => (
            <Link
              key={s}
              href={buildHref({ status: s })}
              className={
                "rounded-md border px-3 py-1.5 text-sm capitalize " +
                ((statusFilter ?? "all") === s
                  ? "border-brand-accent bg-brand-accent text-white"
                  : "border-border bg-surface text-ink-muted hover:bg-surface-inset")
              }
            >
              {s}
            </Link>
          ))}
        </div>
        {eventTypes.length > 0 && (
          <select
            value={eventFilter}
            onChange={(e) => {
              window.location.assign(buildHref({ event: e.target.value }));
            }}
            className="rounded-md border border-border bg-white px-3 py-1.5 text-sm"
            aria-label="Event type filter"
          >
            <option value="">All events</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {KIND_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Result count + active filter chips */}
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-ink-subtle">
        <span>{rows.length} {rows.length === 1 ? "entry" : "entries"}</span>
        {search && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5">
            search: &ldquo;{search}&rdquo;{" "}
            <Link href={buildHref({ q: "" })} className="ml-1 text-ink-muted hover:text-ink">×</Link>
          </span>
        )}
        {eventFilter && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5">
            event: {KIND_LABELS[eventFilter] ?? eventFilter}{" "}
            <Link href={buildHref({ event: "" })} className="ml-1 text-ink-muted hover:text-ink">×</Link>
          </span>
        )}
      </div>

      {/* DESKTOP table */}
      <div className="mt-4 hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:block">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">Event</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Detail</th>
              <th className="px-4 py-2.5">Booking</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-10 text-center text-sm text-slate-500">
                  No delivery activity matches these filters yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setOpenRow(r)}
                className="cursor-pointer border-t border-slate-100 align-top transition hover:bg-slate-50"
              >
                <td className="px-4 py-2.5 font-mono text-xs">
                  {fmtTimestamp(r.createdAt)}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {KIND_LABELS[r.eventType] ?? r.eventType}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-muted">
                  {detailFor(r)}
                </td>
                <td className="px-4 py-2.5 font-mono text-[11px] text-ink-subtle">
                  {r.bookingId ? r.bookingId.slice(0, 8) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* MOBILE card list */}
      <ul className="mt-4 space-y-2 sm:hidden">
        {rows.length === 0 && (
          <li className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            No delivery activity matches these filters yet.
          </li>
        )}
        {rows.map((r) => (
          <li
            key={r.id}
            onClick={() => setOpenRow(r)}
            className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">
                  {KIND_LABELS[r.eventType] ?? r.eventType}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-subtle">
                  {fmtTimestamp(r.createdAt)}
                </div>
              </div>
              <Badge tone={STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Badge>
            </div>
            <div className="mt-2 truncate text-xs text-ink-muted">
              {detailFor(r) || "—"}
            </div>
          </li>
        ))}
      </ul>

      {/* DRAWER — full detail on row click */}
      <Drawer open={Boolean(openRow)} onClose={() => setOpenRow(null)} side="right" size="lg" ariaLabel="Delivery log detail">
        {openRow && <LogDetail row={openRow} />}
      </Drawer>
    </>
  );
}

function LogDetail({ row }: { row: LogRow }) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONES[row.status] ?? "neutral"}>{row.status}</Badge>
          <span className="text-sm font-medium text-ink">
            {KIND_LABELS[row.eventType] ?? row.eventType}
          </span>
        </div>
        <div className="mt-1 text-xs text-ink-muted">{fmtTimestamp(row.createdAt)}</div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
        <DetailRow label="Channel" value={row.channel} />
        <DetailRow label="Booking ID" value={row.bookingId} mono />
        <DetailRow label="Customer ID" value={row.customerId} mono />
        <DetailRow label="Template ID" value={row.templateId} mono />

        {row.status === "sent" && (
          <>
            <DetailRow label="Provider" value={row.provider} />
            <DetailRow label="Provider message ID" value={row.providerMessageId} mono />
            <DetailRow label="Sent at" value={row.sentAt ? fmtTimestamp(row.sentAt) : null} />
          </>
        )}

        {row.status === "failed" && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Failure reason
            </div>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
              {row.failureReason ?? "—"}
            </pre>
            {row.provider && (
              <DetailRow label="Provider that failed" value={row.provider} />
            )}
          </div>
        )}

        {row.status === "skipped" && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Skip reason
            </div>
            <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-ink">
              {row.skippedReason ?? "—"}
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle">
              Common reasons: customer preferences gated the send,
              reminders feature disabled, automation rule disabled, or
              already-sent idempotency hit.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className={"mt-0.5 text-sm text-ink " + (mono ? "font-mono text-xs break-all" : "")}>
        {value}
      </div>
    </div>
  );
}

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function detailFor(r: LogRow): string {
  if (r.status === "skipped") return r.skippedReason ?? "—";
  if (r.status === "failed") return truncate(r.failureReason ?? "—", 120);
  if (r.status === "sent") {
    if (r.providerMessageId) return `via ${r.provider} · ${r.providerMessageId.slice(0, 24)}`;
    return r.provider ?? "sent";
  }
  return "";
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
