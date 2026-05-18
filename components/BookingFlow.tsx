"use client";

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
};

type Step = "pick-time" | "confirm" | "done";

const DEFAULT_ACCENT = "#2563eb";

export default function BookingFlow({
  serviceId,
  staffId,
  staffName,
  durationMinutes,
  accentColor,
  tenantName,
  autoRouted = false,
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
      toast("Booked! A confirmation is on its way.", "success");
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
    // Outlook web — works for outlook.com / live.com personal accounts.
    const outlookUrl =
      start && end
        ? `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&startdt=${start.toISOString()}&enddt=${end.toISOString()}&subject=${encodeURIComponent(title)}&body=${encodeURIComponent(description)}`
        : "";

    return (
      <section
        className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500"
        aria-live="polite"
      >
        {/* Accent banner */}
        <div className="h-1.5 w-full" style={{ backgroundColor: accent }} aria-hidden />

        <div className="px-6 py-8 text-center sm:px-10 sm:py-10">
          {/* Animated success check */}
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 ring-4 ring-green-50" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-7 w-7 text-green-600 animate-in zoom-in duration-300">
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <h2 className="mt-5 text-xl font-semibold tracking-tight text-slate-900">
            You&rsquo;re booked
          </h2>
          <p className="mt-1 text-sm text-slate-600">A confirmation is on its way to {clientEmail}.</p>

          {/* Appointment summary card */}
          {start && (
            <div className="mx-auto mt-6 max-w-sm rounded-xl border border-slate-200 bg-slate-50 p-4 text-left text-sm">
              <div className="flex items-start gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg text-white"
                  style={{ backgroundColor: accent }}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
                    {formatInTimeZone(start, tz, "MMM")}
                  </span>
                  <span className="text-base font-semibold leading-none">
                    {formatInTimeZone(start, tz, "d")}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900">
                    {formatInTimeZone(start, tz, "EEEE, h:mm a")}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-600">
                    {durationMinutes} min with {staffName}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">{tz}</div>
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
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:opacity-90"
                style={{ backgroundColor: accent }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
                  <path d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Open Google Meet
              </a>
            )}
            {gcalUrl && (
              <a
                href={gcalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Google Calendar
              </a>
            )}
            {outlookUrl && (
              <a
                href={outlookUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Outlook
              </a>
            )}
          </div>

          <p className="mt-6 text-[11px] text-slate-500">
            You&rsquo;ll receive reminder emails before your appointment. Need to change it? Use the link in your confirmation email.
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
      {/* Date strip + native picker */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <label className="text-sm font-medium text-slate-900">Pick a date</label>
          <span className="text-[11px] text-slate-500">{tz}</span>
        </div>

        {/* Horizontal date pills — mobile-first, scrolls on overflow */}
        <div
          className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1"
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
                  "flex shrink-0 flex-col items-center justify-center rounded-xl border px-3 py-2 text-center transition focus:outline-none focus:ring-2 focus:ring-offset-1 " +
                  (disabled
                    ? "border-slate-200 bg-slate-50 text-slate-300 line-through cursor-not-allowed"
                    : isSelected
                      ? "border-transparent text-white shadow-md"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:shadow-sm")
                }
                style={
                  !disabled && isSelected
                    ? ({
                        backgroundColor: accent,
                        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                        "--tw-ring-color": accent,
                      } as React.CSSProperties)
                    : ({
                        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                        "--tw-ring-color": accent,
                      } as React.CSSProperties)
                }
              >
                <span className={"text-[10px] font-semibold uppercase tracking-wider " + (isSelected ? "opacity-80" : "text-slate-400")}>
                  {d.wd}
                </span>
                <span className="mt-0.5 text-base font-semibold leading-none tabular-nums">{d.dd}</span>
                <span className={"mt-0.5 text-[10px] " + (isSelected ? "opacity-70" : "text-slate-400")}>{d.mo}</span>
              </button>
            );
          })}

          {/* "More dates" — opens the native picker via a hidden input */}
          <label
            className="flex shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2 text-center text-slate-500 transition hover:border-slate-400 hover:text-slate-700"
            title="Pick another date"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider">More</span>
            <span className="mt-0.5 text-base leading-none">📅</span>
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

      {/* Slot grid */}
      {step === "pick-time" && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">{selectedDateLabel}</div>
              <div className="text-xs text-slate-500">{durationMinutes} min appointments</div>
            </div>
            {!loadingSlots && slots.length > 0 && (
              <span className="text-xs text-slate-500">
                <span className="tabular-nums font-medium text-slate-900">{slots.length}</span> open
              </span>
            )}
          </div>

          {loadingSlots ? (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Loading available times">
              {Array.from({ length: 9 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
              No times available on this day.
              <div className="mt-1 text-xs text-slate-400">Try another date above.</div>
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
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <button
            onClick={() => setStep("pick-time")}
            className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-900"
          >
            ← Change time
          </button>

          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="flex items-start gap-3">
              <div
                className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg text-white"
                style={{ backgroundColor: accent }}
                aria-hidden
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
                  {formatInTimeZone(selectedSlot, tz, "MMM")}
                </span>
                <span className="text-base font-semibold leading-none">
                  {formatInTimeZone(selectedSlot, tz, "d")}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900">
                  {formatInTimeZone(selectedSlot, tz, "EEEE, h:mm a")}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {durationMinutes} min with {staffName} · {tz}
                </div>
              </div>
            </div>
          </div>

          <h3 className="mt-5 text-sm font-medium text-slate-900">Your details</h3>

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
                className="peer w-full rounded-lg border border-slate-300 bg-white px-3 pb-2 pt-5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2"
                style={{
                  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                  "--tw-ring-color": accent,
                } as React.CSSProperties}
              />
              <label
                htmlFor="bk-notes"
                className="pointer-events-none absolute left-3 top-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500"
              >
                Notes (optional)
              </label>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={submitting || !clientName || !clientEmail}
            className="mt-5 inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {submitting ? "Booking…" : "Confirm booking"}
          </button>
          <p className="mt-2 text-center text-[11px] text-slate-500">
            By confirming you&rsquo;ll receive an email with your meeting details and reminders.
          </p>
        </div>
      )}
    </section>
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
    <div className="mt-4 space-y-4">
      {groups.map((g) => {
        if (g.slots.length === 0) return null;
        return (
          <div key={g.key}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {g.label}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.slots.map((iso) => (
                <button
                  key={iso}
                  onClick={() => onPick(iso)}
                  className="group rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:-translate-y-0.5 hover:border-transparent hover:bg-slate-900 hover:text-white hover:shadow focus:outline-none focus:ring-2"
                  style={{
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    "--tw-ring-color": accent,
                  } as React.CSSProperties}
                >
                  <span className="tabular-nums">{formatInTimeZone(iso, tz, "h:mm a")}</span>
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
        className="peer w-full rounded-lg border border-slate-300 bg-white px-3 pb-2 pt-5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2"
        style={{
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          "--tw-ring-color": accent,
        } as React.CSSProperties}
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute left-3 top-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500"
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
