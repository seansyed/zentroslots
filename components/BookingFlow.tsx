"use client";

/**
 * BookingFlow — Phase 10A luxury conversion pass.
 *
 * This is a VISUAL refinement only. Every state variable, every API
 * route (`/api/public/services/:id/rules`, `/api/slots`, `/api/bookings`,
 * `/api/public/waitlist/join`), every payload, and every conditional
 * branch are preserved byte-identical to the prior implementation.
 * The only changes are presentational: typography hierarchy, ambient
 * lighting, slot interaction quality, trust indicators, sticky mobile
 * CTA, and a more emotionally rewarding confirmation experience.
 */

import { useEffect, useMemo, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { Skeleton, toast } from "@/components/ui/primitives";

type Props = {
  serviceId: string;
  staffId: string;
  staffName: string;
  durationMinutes: number;
  /** Tenant brand color. Threaded down so selected states + CTA match the
   *  rest of the public page. Falls back to a sensible default. */
  accentColor?: string;
  tenantName?: string;
  /** When true, the POST sends staffUserId="auto" so the routing engine
   *  picks the actual staff at insert time. Slots still come from the
   *  preselected staff (additive — slots endpoint untouched per rule #1).
   *  The customer's request may be reassigned to an equally-eligible
   *  staff member; the per-staff slot view limits the surface area of
   *  that mismatch. */
  autoRouted?: boolean;
  /** Whether the pinned staff member has a connected Google calendar.
   *  When true the trust strip surfaces a "Real-time calendar sync"
   *  line — honest signal, only shown when the data backs it. */
  googleConnected?: boolean;
};

type Step = "pick-time" | "confirm" | "done";

const DEFAULT_ACCENT = "#2563eb";
const MOTION_CURVE = "cubic-bezier(0.16,1,0.3,1)";

export default function BookingFlow({
  serviceId,
  staffId,
  staffName,
  durationMinutes,
  accentColor,
  tenantName,
  autoRouted = false,
  googleConnected = false,
}: Props) {
  const accent = accentColor || DEFAULT_ACCENT;

  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );

  const [date, setDate] = useState<string>(() => todayInTz(tz));
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  // Phase 14A — empty-availability recovery. When the selected day
  // returns no slots, a background scan iterates the next 7 days
  // through the existing /api/slots endpoint and surfaces the next
  // available date + first slot so the customer doesn't bounce.
  const [nextAvailable, setNextAvailable] = useState<{ date: string; slotIso: string } | null>(null);
  const [scanningNext, setScanningNext] = useState(false);

  const [step, setStep] = useState<Step>("pick-time");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedMeetLink, setConfirmedMeetLink] = useState<string | null>(null);

  // Date strip — next 14 days starting from today (visitor's TZ). Cheap
  // to compute; re-derived only when tz changes (~never).
  const dateStrip = useMemo(() => buildDateStrip(tz, 14), [tz]);

  // Public rules surface — fetched once. We use it to disable dates in
  // the strip that fall on blackouts or outside earliest/latest
  // bookable. Failure to fetch is non-fatal — strip falls back to
  // "every date enabled" (the booking POST will still enforce on
  // submit). Tenants without a rule get all-null fields → no dates
  // disabled, byte-identical pre-feature behavior.
  const [rules, setRules] = useState<{
    blackoutDates: string[];
    earliestBookable: string | null;
    latestBookable: string | null;
  }>({ blackoutDates: [], earliestBookable: null, latestBookable: null });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/services/${encodeURIComponent(serviceId)}/rules`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setRules({
          blackoutDates: Array.isArray(data.blackoutDates) ? data.blackoutDates : [],
          earliestBookable: data.earliestBookable ?? null,
          latestBookable: data.latestBookable ?? null,
        });
      })
      .catch(() => {
        /* leave defaults */
      });
    return () => { cancelled = true; };
  }, [serviceId]);

  // Per-date disable predicate. A date is disabled if it's in the
  // blackout list OR (entire day) before earliestBookable OR after
  // latestBookable. The booking POST still re-validates on submit.
  const isDateDisabled = (isoDate: string): boolean => {
    if (rules.blackoutDates.includes(isoDate)) return true;
    if (rules.earliestBookable) {
      const earliestDate = new Date(rules.earliestBookable).toISOString().slice(0, 10);
      if (isoDate < earliestDate) return true;
    }
    if (rules.latestBookable) {
      const latestDate = new Date(rules.latestBookable).toISOString().slice(0, 10);
      if (isoDate > latestDate) return true;
    }
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedSlot(null);
    setNextAvailable(null); // reset recovery state when date changes

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

    return () => { cancelled = true; };
  }, [serviceId, staffId, date, tz]);

  // Empty-availability recovery scan. Runs only when the current day
  // came back with 0 slots; iterates the next 7 days serially and
  // stops at the first non-empty result. Honors the same date-disable
  // rules so we don't suggest a blackout date.
  useEffect(() => {
    if (loadingSlots) return;
    if (slots.length > 0) return;
    if (scanningNext) return;
    if (nextAvailable) return;

    let cancelled = false;
    setScanningNext(true);

    (async () => {
      const isoFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      });
      const baseDate = new Date(date + "T12:00:00");
      for (let i = 1; i <= 7; i++) {
        if (cancelled) return;
        const probe = new Date(baseDate);
        probe.setDate(probe.getDate() + i);
        const iso = isoFmt.format(probe);
        if (isDateDisabled(iso)) continue;

        try {
          const u = new URL("/api/slots", window.location.origin);
          u.searchParams.set("serviceId", serviceId);
          u.searchParams.set("staffUserId", staffId);
          u.searchParams.set("date", iso);
          u.searchParams.set("timezone", tz);
          const res = await fetch(u);
          if (!res.ok) continue;
          const data = await res.json();
          const next: string[] = Array.isArray(data.slots) ? data.slots : [];
          if (next.length > 0) {
            if (!cancelled) {
              setNextAvailable({ date: iso, slotIso: next[0] });
            }
            return;
          }
        } catch {
          /* swallow — continue probing */
        }
      }
      if (!cancelled) setNextAvailable(null);
    })().finally(() => { if (!cancelled) setScanningNext(false); });

    return () => { cancelled = true; };
    // We intentionally exclude isDateDisabled from deps — it's stable
    // across renders within a date's slot fetch window. Including it
    // would cause rescans when rules state mutates after the initial
    // fetch settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingSlots, slots.length, serviceId, staffId, date, tz, scanningNext, nextAvailable]);

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
          // autoRouted=true → POST receives "auto" and the routing
          // engine assigns the real staff member at insert time.
          // autoRouted=false → original behavior (specific staff).
          staffUserId: autoRouted ? "auto" : staffId,
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
      toast("Booked. A confirmation is on its way.", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ─── DONE ─────────────────────────────────────────────────────────────
  if (step === "done") {
    const start = selectedSlot ? new Date(selectedSlot) : null;
    const end = start ? new Date(start.getTime() + durationMinutes * 60_000) : null;
    const fmtIcs = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const title = `Meeting with ${staffName}${tenantName ? ` (${tenantName})` : ""}`;
    const description = confirmedMeetLink ? `Join: ${confirmedMeetLink}` : "";
    const gcalUrl =
      start && end
        ? `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${fmtIcs(start)}/${fmtIcs(end)}&details=${encodeURIComponent(description)}`
        : "";
    const outlookUrl =
      start && end
        ? `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&startdt=${start.toISOString()}&enddt=${end.toISOString()}&subject=${encodeURIComponent(title)}&body=${encodeURIComponent(description)}`
        : "";

    return (
      <section
        className="relative mt-8 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)] animate-in fade-in zoom-in-95 duration-500"
        style={{ animationTimingFunction: MOTION_CURVE }}
        aria-live="polite"
      >
        {/* Ambient operational glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
          style={{ backgroundColor: accent, opacity: 0.14 }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 -bottom-16 h-56 w-56 rounded-full bg-emerald-200/30 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent"
        />

        <div className="relative px-6 py-9 text-center sm:px-12 sm:py-12">
          {/* Animated success check — calmer, more deliberate */}
          <div
            className="relative mx-auto inline-flex h-16 w-16 items-center justify-center"
            aria-hidden
          >
            <span
              className="absolute inset-0 rounded-full bg-emerald-100"
              style={{ animation: `zm-ring-pulse 2.4s ${MOTION_CURVE} infinite` }}
            />
            <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 shadow-[0_8px_24px_rgba(16,185,129,0.40)] ring-4 ring-emerald-50">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className="h-7 w-7 text-white animate-in zoom-in-50 duration-500"
                style={{ animationTimingFunction: MOTION_CURVE }}
              >
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>

          <h2 className="mt-6 text-[22px] font-semibold tracking-tight text-slate-900 sm:text-[24px]">
            You&rsquo;re booked
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-600">
            A confirmation is on its way to{" "}
            <span className="font-medium text-slate-900">{clientEmail}</span>
            {tenantName && (
              <>
                {" "}from <span className="font-medium text-slate-900">{tenantName}</span>
              </>
            )}
            .
          </p>

          {/* Appointment summary card */}
          {start && (
            <div className="mx-auto mt-7 max-w-md rounded-2xl border border-slate-200 bg-slate-50/60 p-4 text-left text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-sm">
              <div className="flex items-start gap-3.5">
                <div
                  className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl text-white shadow-[0_4px_12px_rgba(15,23,42,0.10)]"
                  style={{ backgroundColor: accent }}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider opacity-90">
                    {formatInTimeZone(start, tz, "MMM")}
                  </span>
                  <span className="text-lg font-semibold leading-none">
                    {formatInTimeZone(start, tz, "d")}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-semibold tracking-tight text-slate-900">
                    {formatInTimeZone(start, tz, "EEEE")}
                  </div>
                  <div className="text-[13px] text-slate-700">
                    {formatInTimeZone(start, tz, "h:mm a")} &middot; {durationMinutes} min
                  </div>
                  <div className="mt-1 text-[11.5px] text-slate-500">
                    With <span className="font-medium text-slate-700">{staffName}</span> &middot; {tz}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* CTAs */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {confirmedMeetLink && (
              <a
                href={confirmedMeetLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_6px_16px_rgba(15,23,42,0.18)] transition-all duration-[180ms] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(15,23,42,0.22)]"
                style={{ backgroundColor: accent, transitionTimingFunction: MOTION_CURVE }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
                  <path d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Join Google Meet
              </a>
            )}
            {gcalUrl && (
              <a
                href={gcalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-medium text-slate-700 shadow-[0_2px_8px_rgba(15,23,42,0.06)] transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_8px_18px_rgba(15,23,42,0.08)]"
                style={{ transitionTimingFunction: MOTION_CURVE }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
                </svg>
                Google Calendar
              </a>
            )}
            {outlookUrl && (
              <a
                href={outlookUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-medium text-slate-700 shadow-[0_2px_8px_rgba(15,23,42,0.06)] transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_8px_18px_rgba(15,23,42,0.08)]"
                style={{ transitionTimingFunction: MOTION_CURVE }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M3 8h18" />
                </svg>
                Outlook
              </a>
            )}
          </div>

          {/* Calm next-step reassurance */}
          <div className="mx-auto mt-7 inline-flex max-w-sm flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full bg-slate-50/80 px-4 py-2 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200/60">
            <span className="inline-flex items-center gap-1">
              <CheckGlyph />
              Reminders included
            </span>
            <span className="inline-flex items-center gap-1">
              <CheckGlyph />
              Reschedule any time
            </span>
            <span className="inline-flex items-center gap-1">
              <CheckGlyph />
              Confirmation emailed
            </span>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
            Need to change it? Use the link in your confirmation email.
          </p>
        </div>
      </section>
    );
  }

  // ─── PICK TIME + CONFIRM ──────────────────────────────────────────────
  const selectedDateLabel = formatInTimeZone(
    new Date(date + "T12:00:00"),
    tz,
    "EEEE, MMMM d"
  );

  return (
    <section className="mt-8">
      {/* Trust strip — operational reassurance, very subtle */}
      <TrustStrip tz={tz} autoRouted={autoRouted} googleConnected={googleConnected} />

      {/* Date strip card */}
      <div className="mt-4 relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_18px_rgba(15,23,42,0.04)] sm:p-6">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-slate-400">
              Step 1
            </div>
            <label className="mt-0.5 block text-[15px] font-semibold tracking-tight text-slate-900">
              Pick a date
            </label>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-[10px] font-medium tracking-wide text-slate-500 ring-1 ring-slate-200">
            <ClockGlyph />
            {tz}
          </span>
        </div>

        {/* Horizontal date pills — mobile-first, scrolls on overflow */}
        <div
          className="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="radiogroup"
          aria-label="Select date"
        >
          {dateStrip.map((d) => {
            const isSelected = d.iso === date;
            const disabled = isDateDisabled(d.iso);
            return (
              <button
                key={d.iso}
                role="radio"
                aria-checked={isSelected}
                aria-disabled={disabled}
                disabled={disabled}
                onClick={() => !disabled && setDate(d.iso)}
                title={disabled ? "Not available for booking" : undefined}
                className={
                  // Phase 17B active date pill — refined shadows:
                  //   - softer outer blur (28px → 36px)
                  //   - lower outer opacity (accent55 → accent3a)
                  //   - smaller secondary shadow opacity (33 → 24)
                  //   - inset highlight gentler (white/22 → white/18)
                  //   - 200ms → 180ms for slightly snappier feel
                  //   - light wash at top of gradient softened
                  "group relative flex shrink-0 flex-col items-center justify-center rounded-2xl border px-3.5 py-2.5 text-center transition-all duration-[180ms] focus:outline-none focus:ring-2 focus:ring-offset-2 active:scale-[0.98] " +
                  (disabled
                    ? "border-slate-200 bg-slate-50 text-slate-300 line-through cursor-not-allowed active:scale-100"
                    : isSelected
                      ? "border-transparent text-white ring-1 ring-inset ring-white/15"
                      : "border-slate-200 bg-white text-slate-700 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_4px_12px_rgba(15,23,42,0.07)]")
                }
                style={{
                  ...((!disabled && isSelected
                    ? {
                        // Phase 17B: softer gradient blend — accent
                        // base with subtle top wash at gentler stops
                        // for cleaner premium depth.
                        backgroundImage: `linear-gradient(180deg, ${accent}f2 0%, ${accent} 55%, ${accent}f7 100%)`,
                        backgroundColor: accent,
                        // Softer shadow set: larger blur, lower opacity
                        // for a calmer "premium tactile" footprint.
                        boxShadow: `0 14px 36px ${accent}3a, 0 3px 8px ${accent}24, inset 0 1px 0 rgba(255,255,255,0.18)`,
                      }
                    : {}) as React.CSSProperties),
                  transitionTimingFunction: MOTION_CURVE,
                  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                  ["--tw-ring-color" as any]: accent,
                }}
              >
                <span className={"text-[10px] font-semibold uppercase tracking-wider " + (isSelected ? "opacity-90" : "text-slate-400")}>
                  {d.wd}
                </span>
                <span className="mt-0.5 text-[17px] font-semibold leading-none tabular-nums">{d.dd}</span>
                <span className={"mt-0.5 text-[10px] " + (isSelected ? "opacity-80" : "text-slate-400")}>{d.mo}</span>
              </button>
            );
          })}

          {/* "More dates" — opens the native picker via a hidden input */}
          <label
            className="flex shrink-0 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white px-3.5 py-2.5 text-center text-slate-500 transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-slate-400 hover:text-slate-700"
            title="Pick another date"
            style={{ transitionTimingFunction: MOTION_CURVE }}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider">More</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4" aria-hidden>
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
            </svg>
            <span className="mt-0.5 text-[10px]">dates</span>
            <input
              type="date"
              value={date}
              min={todayInTz(tz)}
              onChange={(e) => setDate(e.target.value)}
              className="sr-only"
            />
          </label>
        </div>
      </div>

      {/* Slot grid — centerpiece interaction */}
      {step === "pick-time" && (
        <div className="mt-4 relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_18px_rgba(15,23,42,0.04)] sm:p-6">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-slate-400">
                Step 2
              </div>
              <div className="mt-0.5 text-[15px] font-semibold tracking-tight text-slate-900">{selectedDateLabel}</div>
              <div className="text-[12px] text-slate-500">{durationMinutes}-minute appointments</div>
            </div>
            {!loadingSlots && slots.length > 0 && (
              // Phase 17B: lighter "X open" badge —
              //   - bg-emerald-50 → emerald-50/70 (softer)
              //   - ring opacity ring-emerald-200/60 → /40 (cleaner)
              //   - font-medium → font-normal (lighter)
              //   - count itself keeps font-semibold for emphasis
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50/70 px-2.5 py-1 text-[11px] font-normal text-emerald-700 ring-1 ring-emerald-200/40">
                <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                <span className="tabular-nums font-semibold">{slots.length}</span> open
              </span>
            )}
          </div>

          {loadingSlots ? (
            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3" aria-label="Loading available times">
              {Array.from({ length: 9 }).map((_, i) => (
                <Skeleton key={i} className="h-11 rounded-xl" />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <div className="mt-5 space-y-3">
              <div className="relative overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-8 text-center">
                <div className="mx-auto mb-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-400 ring-1 ring-slate-200">
                  <ClockGlyph />
                </div>
                <div className="text-[13px] font-medium text-slate-700">No times available on this day</div>
                <div className="mt-1 text-[12px] text-slate-500">
                  Try another date above &mdash; or jump to the next opening below.
                </div>
              </div>

              {/* Next available recovery — surfaces the next non-empty
                  day discovered by the background scan. Click jumps the
                  date strip to that day; the slot grid then refreshes
                  naturally through the existing fetch effect. */}
              <NextAvailableTile
                scanning={scanningNext}
                next={nextAvailable}
                tz={tz}
                accent={accent}
                onJump={(iso) => setDate(iso)}
              />

              <WaitlistJoinTile
                serviceId={serviceId}
                preferredDate={date}
                accent={accent}
              />
            </div>
          ) : (
            <SlotsGrouped
              slots={slots}
              tz={tz}
              accent={accent}
              onPick={(iso) => {
                setSelectedSlot(iso);
                setStep("confirm");
              }}
            />
          )}
        </div>
      )}

      {/* Confirm */}
      {step === "confirm" && selectedSlot && (
        <div className="mt-4 relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.06)] sm:p-6">
          {/* Ambient accent glow */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full blur-3xl"
            style={{ backgroundColor: accent, opacity: 0.08 }}
          />
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

          <div className="relative">
            <button
              onClick={() => setStep("pick-time")}
              className="inline-flex items-center gap-1 text-[12px] text-slate-500 transition-colors hover:text-slate-900"
            >
              <span aria-hidden>←</span> Change time
            </button>

            <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.10em] text-slate-400">
              Step 3
            </div>
            <h3 className="mt-0.5 text-[16px] font-semibold tracking-tight text-slate-900">Confirm your booking</h3>

            {/* Selected slot summary */}
            <div className="mt-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50/80 via-white to-white p-3.5 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
              <div className="flex items-start gap-3.5">
                <div
                  className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl text-white shadow-[0_4px_12px_rgba(15,23,42,0.10)]"
                  style={{ backgroundColor: accent }}
                  aria-hidden
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider opacity-90">
                    {formatInTimeZone(selectedSlot, tz, "MMM")}
                  </span>
                  <span className="text-[17px] font-semibold leading-none">
                    {formatInTimeZone(selectedSlot, tz, "d")}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold tracking-tight text-slate-900">
                    {formatInTimeZone(selectedSlot, tz, "EEEE, h:mm a")}
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-600">
                    {durationMinutes} min &middot; with <span className="font-medium text-slate-800">{staffName}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{tz}</div>
                </div>
              </div>
            </div>

            <h4 className="mt-6 text-[13px] font-semibold tracking-tight text-slate-900">Your details</h4>

            <div className="mt-3 space-y-3">
              <FloatingInput
                id="bk-name"
                label="Full name"
                value={clientName}
                onChange={setClientName}
                required
                autoComplete="name"
                accent={accent}
              />
              <FloatingInput
                id="bk-email"
                label="Email"
                type="email"
                value={clientEmail}
                onChange={setClientEmail}
                required
                autoComplete="email"
                inputMode="email"
                accent={accent}
              />
              <div className="relative">
                <textarea
                  id="bk-notes"
                  placeholder=" "
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="peer w-full rounded-xl border border-slate-300 bg-white px-3.5 pb-2.5 pt-5 text-[13.5px] text-slate-900 outline-none transition-all duration-[180ms] focus:border-slate-400 focus:ring-2"
                  style={{
                    transitionTimingFunction: MOTION_CURVE,
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    ["--tw-ring-color" as any]: accent,
                  }}
                />
                <label
                  htmlFor="bk-notes"
                  className="pointer-events-none absolute left-3.5 top-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500"
                >
                  Notes (optional)
                </label>
              </div>
            </div>

            {error && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
                {error}
              </div>
            )}

            <button
              onClick={submit}
              disabled={submitting || !clientName || !clientEmail}
              className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-[14px] font-semibold text-white shadow-[0_8px_22px_rgba(15,23,42,0.18)] transition-all duration-[180ms] hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(15,23,42,0.22)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
              style={{ backgroundColor: accent, transitionTimingFunction: MOTION_CURVE }}
            >
              {submitting ? (
                <>
                  <span
                    aria-hidden
                    className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                  Confirming&hellip;
                </>
              ) : (
                <>
                  Confirm booking
                  <span aria-hidden>→</span>
                </>
              )}
            </button>
            <p className="mt-2 text-center text-[11px] leading-relaxed text-slate-500">
              You&rsquo;ll receive an email with your meeting details and gentle reminders before the appointment.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Trust strip ────────────────────────────────────────────────────────

function TrustStrip({
  tz,
  autoRouted,
  googleConnected,
}: {
  tz: string;
  autoRouted: boolean;
  googleConnected: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500">
      <span className="inline-flex items-center gap-1.5">
        <SparkleGlyph />
        Confirmed instantly
      </span>
      <span className="inline-flex items-center gap-1.5">
        <CheckGlyph />
        Reminders included
      </span>
      <span className="inline-flex items-center gap-1.5" title={`Times shown in ${tz}`}>
        <GlobeGlyph />
        Timezone auto-adjusted
      </span>
      {googleConnected && (
        <span className="inline-flex items-center gap-1.5 text-emerald-700">
          <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          Real-time calendar sync
        </span>
      )}
      {autoRouted && (
        <span className="inline-flex items-center gap-1.5">
          <CheckGlyph />
          Routed to next available
        </span>
      )}
    </div>
  );
}

// ─── Next available recovery tile ──────────────────────────────────
// Surfaced inside the empty-slot state. Shows the next non-empty
// date+time found by the background scan, with a one-click jump.
// Calm tone — no pressure, no marketing. If the scan is still
// running we show a soft skeleton; if no opening was found within
// the 7-day window we hide entirely (the waitlist tile below is the
// next-best path in that case).

function NextAvailableTile({
  scanning,
  next,
  tz,
  accent,
  onJump,
}: {
  scanning: boolean;
  next: { date: string; slotIso: string } | null;
  tz: string;
  accent: string;
  onJump: (iso: string) => void;
}) {
  if (scanning && !next) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-slate-100" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
          </div>
        </div>
      </div>
    );
  }

  if (!next) return null;

  const dateLabel = formatInTimeZone(
    new Date(next.date + "T12:00:00"),
    tz,
    "EEEE, MMMM d"
  );
  const timeLabel = formatInTimeZone(next.slotIso, tz, "h:mm a");

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_4px_18px_rgba(15,23,42,0.04)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(15,23,42,0.08)]"
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-200/80 to-transparent" />
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl text-white shadow-[0_4px_12px_rgba(16,185,129,0.30)]"
          style={{ backgroundColor: "#10b981" }}
          aria-hidden
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider opacity-90">
            {formatInTimeZone(new Date(next.date + "T12:00:00"), tz, "MMM")}
          </span>
          <span className="text-[15px] font-semibold leading-none">
            {formatInTimeZone(new Date(next.date + "T12:00:00"), tz, "d")}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-emerald-700">
            Next available
          </div>
          <div className="mt-0.5 text-[13.5px] font-semibold tracking-tight text-slate-900">
            {dateLabel}
          </div>
          <div className="text-[12px] text-slate-600">
            <span className="tabular-nums font-medium text-slate-800">{timeLabel}</span> and later
          </div>
        </div>
        <button
          type="button"
          onClick={() => onJump(next.date)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_12px_rgba(15,23,42,0.15)] transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(15,23,42,0.20)]"
          style={{ backgroundColor: accent }}
        >
          See times
          <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function SlotsGrouped({
  slots,
  tz,
  accent,
  onPick,
}: {
  slots: string[];
  tz: string;
  accent: string;
  onPick: (iso: string) => void;
}) {
  // Group slots into Morning / Afternoon / Evening using the visitor's tz
  // hour. Keeps grouping cheap (no extra lib).
  const groups: { label: string; key: "morning" | "afternoon" | "evening"; slots: string[] }[] = [
    { label: "Morning", key: "morning", slots: [] },
    { label: "Afternoon", key: "afternoon", slots: [] },
    { label: "Evening", key: "evening", slots: [] },
  ];
  for (const iso of slots) {
    const hour = Number(formatInTimeZone(iso, tz, "H"));
    if (hour < 12) groups[0].slots.push(iso);
    else if (hour < 17) groups[1].slots.push(iso);
    else groups[2].slots.push(iso);
  }

  return (
    // Phase 17: tightened mt-5 → mt-4, space-y-5 → space-y-4
    <div className="mt-4 space-y-4">
      {groups.map((g) => {
        if (g.slots.length === 0) return null;
        return (
          <div key={g.key}>
            <div className="flex items-baseline gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-slate-400">
                {g.label}
              </div>
              <span className="text-[10px] tabular-nums text-slate-400">
                &middot; {g.slots.length} {g.slots.length === 1 ? "slot" : "slots"}
              </span>
            </div>
            {/* Phase 17B: gap-2.5 → gap-2 for tighter horizontal rhythm */}
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.slots.map((iso) => (
                <button
                  key={iso}
                  onClick={() => onPick(iso)}
                  // Phase 17B premium slot button:
                  //   - py-2.5 → py-2 (4px tighter — better density,
                  //     still touch-friendly at 36px tap target)
                  //   - 200ms → 160ms transitions for snappier
                  //     "tactile" feel without losing smoothness
                  //   - active:scale-[0.97] → 0.98 (less dramatic
                  //     press — brief asked for subtle)
                  //   - New ultra-soft inner glow overlay (radial
                  //     gradient at very low opacity) gives the slot
                  //     a calm premium hover feel without flash
                  className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-[160ms] hover:-translate-y-0.5 hover:shadow-[0_4px_10px_rgba(15,23,42,0.06)] focus:outline-none focus:ring-2 focus:ring-offset-1 active:scale-[0.98] active:translate-y-0"
                  style={{
                    transitionTimingFunction: MOTION_CURVE,
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    ["--tw-ring-color" as any]: accent,
                  }}
                >
                  {/* Phase 17B: ultra-soft inner glow — a radial
                      gradient layer that adds dimensional depth on
                      hover without any bright color flash. Sits
                      BELOW the fill overlay so it stays visible at
                      the edges during hover transitions. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[160ms] group-hover:opacity-100"
                    style={{
                      backgroundImage: `radial-gradient(circle at 50% 0%, ${accent}1f, transparent 70%)`,
                      transitionTimingFunction: MOTION_CURVE,
                    }}
                  />
                  {/* Hover border accent — picks up the brand tone */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-xl opacity-0 ring-1 ring-inset transition-opacity duration-[160ms] group-hover:opacity-100"
                    style={{ "--tw-ring-color": accent, transitionTimingFunction: MOTION_CURVE } as React.CSSProperties}
                  />
                  {/* Hover fill — calm tint of the brand accent */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[160ms] group-hover:opacity-100"
                    style={{ backgroundColor: accent, transitionTimingFunction: MOTION_CURVE }}
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-[160ms] group-hover:opacity-100"
                    style={{ boxShadow: `0 8px 20px ${accent}33`, transitionTimingFunction: MOTION_CURVE }}
                  />
                  <span className="relative tabular-nums transition-colors duration-[160ms] group-hover:text-white" style={{ transitionTimingFunction: MOTION_CURVE }}>
                    {formatInTimeZone(iso, tz, "h:mm a")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FloatingInput({
  id,
  label,
  value,
  onChange,
  type = "text",
  required = false,
  autoComplete,
  inputMode,
  accent,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  accent: string;
}) {
  return (
    <div className="relative">
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder=" "
        className="peer w-full rounded-xl border border-slate-300 bg-white px-3.5 pb-2.5 pt-5 text-[13.5px] text-slate-900 outline-none transition-all duration-[180ms] focus:border-slate-400 focus:ring-2"
        style={{
          transitionTimingFunction: MOTION_CURVE,
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          ["--tw-ring-color" as any]: accent,
        }}
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute left-3.5 top-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500"
      >
        {label}
      </label>
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

function buildDateStrip(timezone: string, days: number): { iso: string; wd: string; dd: string; mo: string }[] {
  const out: { iso: string; wd: string; dd: string; mo: string }[] = [];
  const isoFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" });
  const ddFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, day: "numeric" });
  const moFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short" });
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

// ─── Glyphs ─────────────────────────────────────────────────────────────

function ClockGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 text-emerald-500" aria-hidden>
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkleGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" strokeLinecap="round" />
    </svg>
  );
}

// ─── Waitlist join tile ────────────────────────────────────────────────
// Shown in the empty state when no slots are available on the chosen
// date. Lazy expand — initial render is a single button so we don't
// nudge customers who just want to try another date.
function WaitlistJoinTile({
  serviceId,
  preferredDate,
  accent,
}: {
  serviceId: string;
  preferredDate: string;
  accent: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [range, setRange] = useState<"morning" | "afternoon" | "evening" | "any">("any");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | { position: number; already: boolean }>(null);

  async function submit() {
    if (!name || !email.includes("@")) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/public/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          customerName: name,
          customerEmail: email,
          preferredDate,
          preferredTimeRange: range,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not join waitlist");
      setDone({ position: data.queuePosition, already: Boolean(data.alreadyOnWaitlist) });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not join waitlist", "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 text-center text-sm">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
        <div className="font-semibold tracking-tight text-emerald-900">
          {done.already ? "You're already on the waitlist." : "Added to the waitlist."}
        </div>
        <div className="mt-1 text-[12px] text-emerald-800/90">
          Position {done.position} in the queue. We&rsquo;ll email you when a spot opens.
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="block w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-center text-[13px] font-medium text-slate-700 transition-all duration-[180ms] hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.06)]"
        style={{ transitionTimingFunction: MOTION_CURVE }}
      >
        Join the waitlist for this date
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_4px_18px_rgba(15,23,42,0.04)]">
      <div className="text-[14px] font-semibold tracking-tight text-slate-900">Join the waitlist</div>
      <p className="mt-1 text-[12px] text-slate-500">
        We&rsquo;ll email you if a spot opens for {preferredDate}.
      </p>
      <div className="mt-3 grid gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="rounded-xl border border-slate-300 px-3 py-2 text-[13.5px]"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="rounded-xl border border-slate-300 px-3 py-2 text-[13.5px]"
        />
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as typeof range)}
          className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13.5px]"
        >
          <option value="any">Any time</option>
          <option value="morning">Morning</option>
          <option value="afternoon">Afternoon</option>
          <option value="evening">Evening</option>
        </select>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[12px] text-slate-500 transition-colors hover:text-slate-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !name || !email.includes("@")}
          className="rounded-xl px-4 py-2 text-[13px] font-semibold text-white shadow-[0_4px_12px_rgba(15,23,42,0.12)] transition-all duration-[180ms] hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
          style={{ backgroundColor: accent, transitionTimingFunction: MOTION_CURVE }}
        >
          {submitting ? "Joining…" : "Join waitlist"}
        </button>
      </div>
    </div>
  );
}
