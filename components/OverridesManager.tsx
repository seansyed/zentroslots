"use client";

import { useState, useTransition } from "react";

type Override = {
  id: string;
  date: string;        // YYYY-MM-DD
  unavailable: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
};

export default function OverridesManager({
  initial,
  userTimezone,
}: {
  initial: Override[];
  userTimezone: string;
}) {
  const [rows, setRows] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [mode, setMode] = useState<"vacation" | "block" | "custom" | "bulk">("vacation");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("13:00");
  const [reason, setReason] = useState("");
  const [bulkDates, setBulkDates] = useState("");

  async function add() {
    setError(null);
    if (mode === "bulk") {
      const dates = bulkDates
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (dates.length === 0) {
        setError("Add at least one date (one per line).");
        return;
      }
      startTransition(async () => {
        const res = await fetch("/api/availability/overrides/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dates, unavailable: true, reason }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error?.[0]?.message ?? data?.error ?? "Failed");
          return;
        }
        await reload();
        setBulkDates(""); setReason("");
      });
      return;
    }

    if (!date) {
      setError("Pick a date.");
      return;
    }
    const payload =
      mode === "vacation" || mode === "block"
        ? { date, unavailable: true, reason: reason || (mode === "vacation" ? "Vacation" : "Blocked") }
        : { date, unavailable: false, startTime, endTime, reason };

    startTransition(async () => {
      const res = await fetch("/api/availability/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.[0]?.message ?? data?.error ?? "Failed");
        return;
      }
      setRows((cur) => [...cur, {
        id: data.id, date: data.date, unavailable: data.unavailable,
        startTime: data.startTime ?? null, endTime: data.endTime ?? null, reason: data.reason ?? null,
      }].sort((a, b) => a.date.localeCompare(b.date)));
      setDate(""); setReason("");
    });
  }

  async function reload() {
    const res = await fetch("/api/availability/overrides");
    if (!res.ok) return;
    const data: Override[] = await res.json();
    setRows(data);
  }

  async function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/availability/overrides/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d?.error ?? "Delete failed");
        return;
      }
      setRows((cur) => cur.filter((r) => r.id !== id));
    });
  }

  return (
    <div className="mt-6 space-y-6">
      {/* Mode picker */}
      <div className="flex flex-wrap gap-2">
        {(["vacation", "block", "custom", "bulk"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={
              "rounded-md border px-3 py-1.5 text-sm capitalize " +
              (mode === m ? "border-brand-accent bg-brand-accent text-white" : "bg-white hover:bg-slate-50")
            }
          >
            {m === "vacation" ? "Vacation" :
             m === "block"    ? "Block a day" :
             m === "custom"   ? "Custom hours / lunch break" : "Bulk holidays"}
          </button>
        ))}
      </div>

      {/* Form */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        {mode === "bulk" ? (
          <>
            <label className="block text-sm font-medium text-slate-700">Holiday dates</label>
            <textarea
              rows={4}
              value={bulkDates}
              onChange={(e) => setBulkDates(e.target.value)}
              placeholder={"2026-12-25\n2026-12-26\n2026-12-31\n2027-01-01"}
              className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-sm"
            />
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional, e.g. Christmas)"
              className="mt-3 w-full rounded-md border px-3 py-2 text-sm"
            />
          </>
        ) : (
          <>
            <label className="block text-sm font-medium text-slate-700">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            />
            {mode === "custom" && (
              <div className="mt-3 flex items-center gap-2">
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="rounded-md border px-2 py-1 text-sm" />
                <span className="text-slate-400">–</span>
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="rounded-md border px-2 py-1 text-sm" />
                <span className="ml-2 text-xs text-slate-500">
                  Tip: add two custom hours rows to split a day (e.g. 9–12 and 1–5).
                </span>
              </div>
            )}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              className="mt-3 w-full rounded-md border px-3 py-2 text-sm"
            />
          </>
        )}
        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
        <button
          onClick={add}
          disabled={pending}
          className="mt-4 rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add"}
        </button>
        <p className="mt-2 text-xs text-slate-500">Times are in {userTimezone}.</p>
      </div>

      {/* List */}
      <div className="rounded-lg border bg-white shadow-sm">
        {rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No upcoming overrides.</div>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <div>
                  <div className="font-medium">{r.date}</div>
                  <div className="text-xs text-slate-500">
                    {r.unavailable
                      ? "Unavailable all day"
                      : `${r.startTime?.slice(0, 5)} – ${r.endTime?.slice(0, 5)}`}
                    {r.reason && <> · {r.reason}</>}
                  </div>
                </div>
                <button
                  onClick={() => remove(r.id)}
                  disabled={pending}
                  className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
