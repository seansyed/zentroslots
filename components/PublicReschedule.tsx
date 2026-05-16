"use client";

import { useEffect, useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

type Info = {
  booking: { id: string; startAt: string; status: string };
  service?: { id: string; name: string; durationMinutes: number };
  staff?: { id: string; name: string; timezone: string };
  tenant?: { name: string };
};

function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export default function PublicReschedule({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [date, setDate] = useState(() => todayInTz(tz));
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/public/booking/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error ?? "Invalid link");
        setInfo(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [token]);

  useEffect(() => {
    if (!info?.service || !info?.staff) return;
    let cancelled = false;
    setLoadingSlots(true);
    setPicked(null);
    const url = new URL("/api/slots", window.location.origin);
    url.searchParams.set("serviceId", info.service.id);
    url.searchParams.set("staffUserId", info.staff.id);
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", tz);
    fetch(url)
      .then((r) => r.json())
      .then((d) => !cancelled && setSlots(Array.isArray(d.slots) ? d.slots : []))
      .catch(() => !cancelled && setSlots([]))
      .finally(() => !cancelled && setLoadingSlots(false));
    return () => { cancelled = true; };
  }, [info, date, tz]);

  async function submit() {
    if (!picked) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(token)}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startAt: picked }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Reschedule failed");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reschedule failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>;
  if (!info) return <div className="mt-6 text-sm text-slate-500">Loading…</div>;

  if (done) return (
    <div className="mt-6 rounded-md border border-green-200 bg-green-50 p-6 text-sm text-green-800">
      Rescheduled to {picked && formatInTimeZone(picked, tz, "EEEE, MMM d 'at' h:mm a")}.
    </div>
  );

  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <div className="text-xs uppercase text-slate-500">{info.tenant?.name}</div>
        <div className="mt-1 text-lg font-medium">{info.service?.name}</div>
        <div className="mt-1 text-sm text-slate-600">
          Current: {formatInTimeZone(info.booking.startAt, info.staff?.timezone ?? "UTC", "MMM d 'at' h:mm a zzz")}
        </div>
      </div>

      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">Pick a new date</label>
        <input
          type="date" value={date} min={todayInTz(tz)}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
        />
        <div className="mt-4 text-sm font-medium text-slate-700">Available times ({tz})</div>
        {loadingSlots ? (
          <div className="mt-2 text-sm text-slate-500">Loading…</div>
        ) : slots.length === 0 ? (
          <div className="mt-2 text-sm text-slate-500">No times available on this day.</div>
        ) : (
          <div className="mt-2 grid max-h-56 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
            {slots.map((iso) => {
              const active = iso === picked;
              return (
                <button
                  key={iso}
                  onClick={() => setPicked(iso)}
                  className={
                    "rounded-md border px-3 py-2 text-sm " +
                    (active ? "border-blue-600 bg-blue-600 text-white" : "hover:border-blue-400 hover:bg-blue-50")
                  }
                >
                  {formatInTimeZone(iso, tz, "h:mm a")}
                </button>
              );
            })}
          </div>
        )}
        <button
          onClick={submit}
          disabled={!picked || submitting}
          className="mt-4 w-full rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Confirm new time"}
        </button>
      </div>
    </div>
  );
}
