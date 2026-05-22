"use client";

/**
 * FeedbackChip — F31 1-tap post-visit rating.
 *
 * Renders inline on a completed booking card. Single tap on a star
 * fires the POST and transitions to a thank-you state. Optional note
 * field opens AFTER the rating lands so the customer can add context
 * without blocking the primary action.
 *
 * Auth + ownership are enforced server-side by the endpoint; this
 * component is intentionally trusting of its `bookingId` prop because
 * the surrounding bookings page already filters to the customer's own
 * rows.
 */

import { useState } from "react";

type Props = {
  tenantSlug: string;
  bookingId: string;
  serviceName: string;
  staffName: string;
  accent: string;
};

export default function FeedbackChip({ tenantSlug, bookingId, serviceName, staffName, accent }: Props) {
  type Phase = "idle" | "submitting" | "submitted" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [rating, setRating] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(starValue: number, includeNote: boolean) {
    if (phase === "submitting") return;
    setPhase("submitting");
    setError(null);
    try {
      const res = await fetch(
        `/api/client/${encodeURIComponent(tenantSlug)}/bookings/${encodeURIComponent(bookingId)}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rating: starValue,
            ...(includeNote && note.trim().length > 0 ? { note: note.trim() } : {}),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data?.error as string) ?? "Couldn't save");
      setRating(starValue);
      setPhase("submitted");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  if (phase === "submitted") {
    return (
      <div className="relative overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 shadow-sm">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
        <div className="flex items-center gap-2.5">
          <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5">
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1 text-[12px] text-emerald-900">
            <div className="font-semibold">Thanks for the feedback.</div>
            <div className="text-emerald-800/85">
              {rating}-star rating recorded for {serviceName} with {staffName}.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const displayed = hover ?? rating ?? 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50/70 to-white p-3 shadow-sm">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        How was your appointment?
      </div>
      <div className="mt-0.5 text-[12px] text-slate-700">
        Rate your <span className="font-medium text-slate-900">{serviceName}</span> with{" "}
        <span className="font-medium text-slate-900">{staffName}</span>.
      </div>

      {/* Star row — 1-tap submits on click. Keyboard-friendly: each
          star is a real button. */}
      <div className="mt-2 flex items-center gap-1.5" role="radiogroup" aria-label="Rate this appointment">
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = displayed >= n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
              disabled={phase === "submitting"}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(n)}
              onBlur={() => setHover(null)}
              onClick={() => submit(n, noteOpen)}
              className="rounded-md p-1 transition-all duration-150 active:scale-95 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-offset-1"
              style={{
                color: filled ? accent : "#cbd5e1",
                /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                ["--tw-ring-color" as any]: accent,
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6" aria-hidden>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          );
        })}
        {phase === "submitting" && (
          <span className="ml-2 inline-flex items-center gap-1.5 text-[11px] text-slate-500">
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
            />
            Saving…
          </span>
        )}
      </div>

      {/* Optional note. Doesn't block the 1-tap rating — appears as a
          collapsible affordance below. */}
      {!noteOpen ? (
        <button
          type="button"
          onClick={() => setNoteOpen(true)}
          className="mt-2 text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          + Add a note (optional)
        </button>
      ) : (
        <div className="mt-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Any details you'd like to share?"
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-[12.5px] text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
          />
          <div className="mt-1 text-[10.5px] text-slate-400">
            The note saves with your next star tap.
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-[11.5px] text-red-700" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
