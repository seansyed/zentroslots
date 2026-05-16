"use client";

import { useEffect, useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { Skeleton, toast } from "@/components/ui/primitives";

type Props = {
  serviceId: string;
  staffId: string;
  staffName: string;
  durationMinutes: number;
};

type Step = "pick-time" | "confirm" | "done";

export default function BookingFlow({ serviceId, staffId, staffName, durationMinutes }: Props) {
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );

  const [date, setDate] = useState<string>(() => todayInTz(tz));
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("pick-time");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedMeetLink, setConfirmedMeetLink] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedSlot(null);

    const url = new URL("/api/slots", window.location.origin);
    url.searchParams.set("serviceId", serviceId);
    url.searchParams.set("staffUserId", staffId);
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", tz);

    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setSlots(Array.isArray(data.slots) ? data.slots : []);
      })
      .catch(() => !cancelled && setSlots([]))
      .finally(() => !cancelled && setLoadingSlots(false));

    return () => {
      cancelled = true;
    };
  }, [serviceId, staffId, date, tz]);

  async function submit() {
    if (!selectedSlot) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          staffUserId: staffId,
          startAt: selectedSlot,
          clientName,
          clientEmail,
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Booking failed");
      setConfirmedMeetLink(data.meetLink ?? null);
      setStep("done");
      toast("Booked! A confirmation is on its way.", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done") {
    const start = selectedSlot ? new Date(selectedSlot) : null;
    const end = start ? new Date(start.getTime() + durationMinutes * 60_000) : null;
    const fmtIcs = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const gcalUrl =
      start && end
        ? `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
            `Meeting with ${staffName}`
          )}&dates=${fmtIcs(start)}/${fmtIcs(end)}&details=${encodeURIComponent(
            confirmedMeetLink ? `Join: ${confirmedMeetLink}` : ""
          )}`
        : "";

    return (
      <div className="mt-8 rounded-lg border bg-white p-8 text-center shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100"
          aria-hidden
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-6 w-6 text-green-600">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="text-lg font-semibold">You&rsquo;re booked</div>
        <div className="mt-2 text-sm text-slate-600">
          {selectedSlot && formatInTimeZone(selectedSlot, tz, "EEEE, MMM d 'at' h:mm a")}
        </div>
        <div className="mt-1 text-xs text-slate-500">with {staffName} • {tz}</div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {confirmedMeetLink && (
            <a
              href={confirmedMeetLink}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open Google Meet
            </a>
          )}
          {gcalUrl && (
            <a
              href={gcalUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Add to Google Calendar
            </a>
          )}
        </div>

        <div className="mt-6 inline-flex items-center gap-1.5 text-[11px] text-slate-500">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
            <path d="M4 12l4 4L20 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          A confirmation with an <code>.ics</code> invite is on its way to {clientEmail}.
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 grid gap-6 sm:grid-cols-[1fr_1fr]">
      {/* Date column */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">
          Pick a date
        </label>
        <input
          type="date"
          className="mt-2 w-full rounded-md border px-3 py-2 text-sm"
          value={date}
          min={todayInTz(tz)}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="mt-3 text-xs text-slate-500">Your timezone: {tz}</div>
      </div>

      {/* Slots / confirm column */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        {step === "pick-time" && (
          <>
            <div className="text-sm font-medium text-slate-700">
              Available times ({durationMinutes} min)
            </div>

            {loadingSlots ? (
              <div className="mt-4 grid grid-cols-2 gap-2" aria-label="Loading available times">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : slots.length === 0 ? (
              <div className="mt-4 rounded-md border border-dashed bg-slate-50 p-4 text-center text-sm text-slate-500">
                No times available on this day. Try another date.
              </div>
            ) : (
              <div className="mt-4 grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1">
                {slots.map((iso) => (
                  <button
                    key={iso}
                    onClick={() => {
                      setSelectedSlot(iso);
                      setStep("confirm");
                    }}
                    className="rounded-md border px-3 py-2 text-sm hover:border-brand-accent hover:bg-blue-50"
                  >
                    {formatInTimeZone(iso, tz, "h:mm a")}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {step === "confirm" && selectedSlot && (
          <>
            <button
              onClick={() => setStep("pick-time")}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← Change time
            </button>

            <div className="mt-2 text-sm font-medium text-slate-700">
              Confirm your booking
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {formatInTimeZone(selectedSlot, tz, "EEEE, MMM d 'at' h:mm a")} ({tz})
            </div>

            <div className="mt-4 space-y-3">
              <input
                placeholder="Your name"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
              <input
                type="email"
                placeholder="Email address"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
              <textarea
                placeholder="Notes (optional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>

            {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

            <button
              onClick={submit}
              disabled={submitting || !clientName || !clientEmail}
              className="mt-4 w-full rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Booking…" : "Confirm booking"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function todayInTz(timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}
