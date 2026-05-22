"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

type Info = {
  booking: { id: string; startAt: string; status: string; clientName: string };
  service?: { name: string; durationMinutes: number };
  staff?: { name: string; timezone: string };
  tenant?: { name: string };
};

export default function PublicCancel({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // F30 — optional reason captured here, posted to the cancel endpoint.
  // Kept lightweight — single optional textarea, no required validation,
  // no PII restrictions surfaced to the customer.
  const [reason, setReason] = useState("");

  useEffect(() => {
    fetch(`/api/public/booking/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error ?? "Invalid link");
        setInfo(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [token]);

  async function cancel() {
    setSubmitting(true); setError(null);
    try {
      const trimmed = reason.trim();
      const res = await fetch(`/api/public/booking/${encodeURIComponent(token)}/cancel`, {
        method: "POST",
        // Only send a body when there's something to send — keeps the
        // wire small + lets the endpoint's tolerant parser take the
        // no-body path on legacy clients.
        ...(trimmed.length > 0
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: trimmed }),
            }
          : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Cancel failed");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  if (!info) return <div className="mt-6 text-sm text-slate-500">Loading…</div>;

  const tz = info.staff?.timezone ?? "UTC";
  if (done || info.booking.status === "cancelled") {
    return (
      <div className="mt-6 rounded-md border border-green-200 bg-green-50 p-6 text-sm text-green-800">
        Cancelled. The other party has been notified.
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-lg border bg-white p-6 shadow-sm">
      <div className="text-xs uppercase text-slate-500">{info.tenant?.name}</div>
      <div className="mt-1 text-lg font-medium">{info.service?.name}</div>
      <div className="mt-1 text-sm text-slate-600">
        {formatInTimeZone(info.booking.startAt, tz, "EEEE, MMM d 'at' h:mm a zzz")}
      </div>
      <div className="mt-1 text-xs text-slate-500">with {info.staff?.name}</div>

      {/* F30 — optional reason. No label asterisk; truly optional.
          Aria-described so screen readers announce the helper text. */}
      <div className="mt-5">
        <label htmlFor="cancel-reason" className="block text-xs font-medium uppercase tracking-wider text-slate-500">
          Reason for cancelling
          <span className="ml-1 font-normal normal-case tracking-normal text-slate-400">(optional)</span>
        </label>
        <textarea
          id="cancel-reason"
          aria-describedby="cancel-reason-hint"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Anything you'd like them to know? (Helps them plan better.)"
          className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
        />
        <p id="cancel-reason-hint" className="mt-1 text-[11px] text-slate-500">
          Shared with {info.tenant?.name ?? "the team"} only.
        </p>
      </div>

      <button
        onClick={cancel}
        disabled={submitting}
        className="mt-5 w-full rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
      >
        {submitting ? "Cancelling…" : "Cancel my appointment"}
      </button>
    </div>
  );
}
