"use client";

/**
 * PortalReschedulePicker — Phase 2A F1.
 *
 * Customer-facing reschedule UI inside the portal. Mirrors the date-
 * strip + slot-grid pattern from PublicReschedule but with the portal's
 * premium styling and a session-authenticated submit endpoint.
 *
 * Reuses the existing GET /api/slots endpoint (no engine changes).
 * On submit, POSTs to /api/client/[slug]/bookings/[id]/reschedule which
 * delegates to lib/reschedule.performReschedule — the same engine the
 * token route uses, so behavior is identical.
 *
 * Edge cases handled:
 *   - 409 slot conflict (someone else just took it) → inline recovery
 *     with a "Pick another time" hint + a `slotsTick` refetch
 *   - Empty day → empty state with hint to try another date
 *   - Double-tap on Confirm → guarded via `submitting`
 *   - Stale slot grid after manual back-nav → slotsTick invalidation
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";

type Props = {
  tenantSlug: string;
  bookingId: string;
  serviceId: string;
  staffId: string;
  staffName: string;
  /** Used in the timezone-confirmation chip so the customer sees the
   *  staff's working timezone alongside their browser timezone. */
  staffTimezone: string;
  durationMinutes: number;
  accent: string;
};

function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function buildDateStrip(tz: string, days: number) {
  const out: { iso: string; wd: string; dd: string; mo: string }[] = [];
  const isoFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const ddFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" });
  const moFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short" });
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    out.push({
      iso: isoFmt.format(d),
      wd: wdFmt.format(d),
      dd: ddFmt.format(d),
      mo: moFmt.format(d),
    });
  }
  return out;
}

export default function PortalReschedulePicker(props: Props) {
  const router = useRouter();
  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const [date, setDate] = useState<string>(() => todayInTz(browserTz));
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [slotsTick, setSlotsTick] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotConflict, setSlotConflict] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // 14-day strip in the visitor's tz; deterministic per tz.
  const dateStrip = useMemo(() => buildDateStrip(browserTz, 14), [browserTz]);

  // Fetch slots when date / forced-refetch tick changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingSlots(true);
    setPicked(null);
    setSlotConflict(false);

    const url = new URL("/api/slots", window.location.origin);
    url.searchParams.set("serviceId", props.serviceId);
    url.searchParams.set("staffUserId", props.staffId);
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", browserTz);

    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setSlots(Array.isArray(d.slots) ? d.slots : []);
      })
      .catch(() => !cancelled && setSlots([]))
      .finally(() => !cancelled && setLoadingSlots(false));

    return () => {
      cancelled = true;
    };
  }, [props.serviceId, props.staffId, date, browserTz, slotsTick]);

  async function submit() {
    if (!picked || submitting) return;
    setSubmitting(true);
    setError(null);
    setSlotConflict(false);
    try {
      const res = await fetch(
        `/api/client/${encodeURIComponent(props.tenantSlug)}/bookings/${encodeURIComponent(props.bookingId)}/reschedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startAt: picked }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setSlotConflict(true);
          throw new Error(
            (data?.error as string) ?? "That time was just taken — please pick another.",
          );
        }
        throw new Error((data?.error as string) ?? "Reschedule failed");
      }
      setDone(picked);
      // Brief pause so the success state is visible before we leave.
      window.setTimeout(() => {
        router.push(`/client/${props.tenantSlug}/bookings`);
        router.refresh();
      }, 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reschedule failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success state ───────────────────────────────────────────────
  if (done) {
    return (
      <div className="relative mt-5 overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50/70 to-white p-6 text-center shadow-sm">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-[0_8px_22px_rgba(16,185,129,0.30)]" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-6 w-6">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="mt-3 text-[16px] font-semibold tracking-tight text-emerald-900">
          Rescheduled
        </h2>
        <p className="mt-1 text-[12.5px] text-emerald-800/85">
          Confirmed for {formatInTimeZone(done, browserTz, "EEEE, MMM d 'at' h:mm a")}.
          We&rsquo;ve emailed you the new details.
        </p>
        <p className="mt-2 text-[11px] text-emerald-700/70">Taking you back to your bookings…</p>
      </div>
    );
  }

  // ── Picker ──────────────────────────────────────────────────────
  return (
    <section className="relative mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
      />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            Pick a new time
          </div>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Your time zone: <span className="font-medium text-slate-700">{browserTz}</span>
            {browserTz !== props.staffTimezone && (
              <>
                {" · "}
                {props.staffName} is in{" "}
                <span className="font-medium text-slate-700">{props.staffTimezone}</span>
              </>
            )}
          </p>
        </div>
        {!loadingSlots && slots.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50/70 px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200/50">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="tabular-nums font-semibold">{slots.length}</span> open
          </span>
        )}
      </div>

      {/* Horizontal date strip */}
      <div
        className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="radiogroup"
        aria-label="Select date"
      >
        {dateStrip.map((d) => {
          const active = d.iso === date;
          return (
            <button
              key={d.iso}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setDate(d.iso)}
              className={
                "group flex shrink-0 flex-col items-center justify-center rounded-2xl border px-3.5 py-2.5 text-center transition-all duration-200 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-1 " +
                (active
                  ? "border-transparent text-white shadow-md"
                  : "border-slate-200 bg-white text-slate-700 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm")
              }
              style={{
                ...((active
                  ? { backgroundColor: props.accent, boxShadow: `0 8px 24px ${props.accent}33` }
                  : {}) as React.CSSProperties),
                /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                ["--tw-ring-color" as any]: props.accent,
              }}
            >
              <span className={`text-[10px] font-semibold uppercase tracking-wider ${active ? "opacity-90" : "text-slate-400"}`}>
                {d.wd}
              </span>
              <span className="mt-0.5 text-[17px] font-semibold leading-none tabular-nums">{d.dd}</span>
              <span className={`mt-0.5 text-[10px] ${active ? "opacity-80" : "text-slate-400"}`}>{d.mo}</span>
            </button>
          );
        })}
      </div>

      {/* Slot grid / loading / empty */}
      <div className="mt-4">
        {loadingSlots ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Loading available times">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        ) : slots.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center">
            <div className="text-[13px] font-medium text-slate-700">No times available on this day</div>
            <div className="mt-1 text-[12px] text-slate-500">Try another date from the strip above.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {slots.map((iso) => {
              const active = iso === picked;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setPicked(iso)}
                  className={
                    "group relative min-h-[40px] rounded-xl border px-3 py-2 text-[13px] font-medium transition-all duration-200 ease-out active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-1 " +
                    (active
                      ? "border-transparent text-white shadow-md"
                      : "border-slate-200 bg-white text-slate-700 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm")
                  }
                  style={{
                    ...((active
                      ? { backgroundColor: props.accent, boxShadow: `0 6px 18px ${props.accent}33` }
                      : {}) as React.CSSProperties),
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    ["--tw-ring-color" as any]: props.accent,
                  }}
                >
                  <span className="tabular-nums">
                    {formatInTimeZone(iso, browserTz, "h:mm a")}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Warning + error states */}
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-700"
        >
          <div>{error}</div>
          {slotConflict && (
            <button
              type="button"
              onClick={() => setSlotsTick((t) => t + 1)}
              className="mt-2 inline-flex items-center gap-1 rounded-lg border border-red-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-red-700 transition-all hover:-translate-y-0.5 hover:bg-red-50 hover:shadow-sm"
            >
              Refresh times <span aria-hidden>↻</span>
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11px] leading-relaxed text-slate-500">
          Your original time will be released the moment this saves. Reminders are reset for the
          new time automatically.
        </p>
        <button
          type="button"
          onClick={submit}
          disabled={!picked || submitting}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-5 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          style={{ backgroundColor: props.accent }}
        >
          {submitting ? "Saving…" : "Confirm new time"}
          {!submitting && <span aria-hidden>→</span>}
        </button>
      </div>
    </section>
  );
}
