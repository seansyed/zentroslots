"use client";

import { useState } from "react";
import { TEMPLATES } from "@/lib/templates";
import {
  ONBOARDING_STEPS,
  type OnboardingProgress,
  type OnboardingStep,
} from "@/lib/onboarding/types";

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: "industry", label: "Industry" },
  { id: "service",  label: "First service" },
  { id: "hours",    label: "Working hours" },
  { id: "google",   label: "Calendar" },
  { id: "done",     label: "Finish" },
];

// Persist a step's status to the server. Fire-and-forget at the call
// site — the wizard's local state is the source of truth for the
// current render; this just makes the next reload / OAuth return /
// "Finish later" come back at the same place.
async function persistStep(
  step: OnboardingStep,
  status: "in_progress" | "complete" | "skipped",
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch("/api/onboarding/progress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, status, ...(data ? { data } : {}) }),
    });
  } catch {
    // Persistence failure must NOT block the wizard. The next page load
    // will simply re-resume at whatever the last-persisted step was.
  }
}

export default function OnboardingWizard({
  defaultTimezone,
  tenantSlug,
  initialStep,
  initialProgress,
}: {
  defaultTimezone: string;
  tenantSlug: string;
  initialStep?: OnboardingStep;
  initialProgress?: OnboardingProgress;
}) {
  // Resume at the persisted step if we have one; otherwise start at the
  // very beginning. Defensive: validate against the known step set so a
  // stale stored value can't crash the component.
  const safeInitial: OnboardingStep =
    initialStep && (ONBOARDING_STEPS as readonly string[]).includes(initialStep)
      ? initialStep
      : "industry";

  const [step, setStep] = useState<OnboardingStep>(safeInitial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completionBlockers, setCompletionBlockers] = useState<string[]>([]);

  // ── Industry template state ──
  // If a template was already applied (persisted in progress), surface
  // it as the badge on the hours step.
  const [appliedTemplate, setAppliedTemplate] = useState<string | null>(
    initialProgress?.templateApplied ?? null,
  );

  // Service step inputs (local; not persisted at the field level — only
  // the resulting `services` row is the source of truth).
  const [serviceName, setServiceName] = useState("30-min Intro Call");
  const [duration, setDuration] = useState(30);

  // Hours step inputs (defaults: Mon–Fri 9–5).
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");

  function toggleDay(d: number) {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  }

  // Wraps setStep with a server-side step-viewed mark so resume works.
  function gotoStep(next: OnboardingStep) {
    setStep(next);
    setError(null);
    setCompletionBlockers([]);
    void persistStep(next, "in_progress");
  }

  async function applyTemplate(id: string) {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/onboarding/apply-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Couldn't apply template");
      setAppliedTemplate(id);
      // The server-side apply-template route persists `service: skipped`
      // and `currentStep: hours`, so just transition the UI to match.
      gotoStep("hours");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function createService() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: serviceName, durationMinutes: duration }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Couldn't create service");
      void persistStep("service", "complete", { serviceName, duration });
      gotoStep("hours");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveHours() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/availability", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: days.map((d) => ({ dayOfWeek: d, startTime: `${start}:00`, endTime: `${end}:00` })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Couldn't save hours");
      void persistStep("hours", "complete", { days, start, end });
      gotoStep("google");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  // Called before the Google OAuth redirect so when the user returns
  // here via the dashboard's "not-yet-complete" redirect chain, the
  // wizard resumes on the `google` step with the connect badge already
  // reflecting the new state. The OAuth flow itself is unchanged.
  function startGoogleConnect() {
    void persistStep("google", "in_progress");
  }

  function skipGoogle() {
    void persistStep("google", "skipped");
    gotoStep("done");
  }

  function continueFromGoogle() {
    void persistStep("google", "complete");
    gotoStep("done");
  }

  async function finish() {
    setBusy(true); setError(null); setCompletionBlockers([]);
    try {
      const res = await fetch("/api/onboarding/complete", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 400 with blockerMessages array = integrity check failed.
        if (Array.isArray(data?.blockerMessages) && data.blockerMessages.length > 0) {
          setCompletionBlockers(data.blockerMessages as string[]);
          throw new Error("Almost there — a couple of items still need attention.");
        }
        throw new Error((data?.error as string) ?? "Couldn't finish");
      }
      window.location.href = "/dashboard";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  }

  // Escape hatch — does NOT mark complete. Server sets
  // `onboarding_skipped_at`; dashboard redirect gate then allows the
  // admin to use the app while keeping the wizard resumable.
  async function finishLater() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/onboarding/skip", { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? "Couldn't save");
      }
      window.location.href = "/dashboard";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setBusy(false);
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="mt-6">
      {/* Progress */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex flex-1 items-center gap-2">
            <div
              className={
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium " +
                (i < stepIndex
                  ? "bg-brand-accent text-white"
                  : i === stepIndex
                    ? "bg-brand-accent text-white ring-4 ring-blue-100"
                    : "bg-slate-200 text-slate-500")
              }
            >
              {i < stepIndex ? "✓" : i + 1}
            </div>
            {i < STEPS.length - 1 && (
              <div className={"h-px flex-1 " + (i < stepIndex ? "bg-brand-accent" : "bg-slate-200")} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wider text-slate-500">{STEPS[stepIndex].label}</div>

      <div className="mt-6 rounded-xl border bg-white p-6 shadow-sm">
        {step === "industry" && (
          <>
            <h2 className="text-lg font-medium">What kind of business are you running?</h2>
            <p className="mt-1 text-sm text-slate-600">
              Pick a template and we&rsquo;ll pre-fill services, an intake form, and brand colors.
              You can edit everything later.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t.id)}
                  disabled={busy}
                  className="flex items-start gap-3 rounded-lg border bg-white p-3 text-left transition hover:border-brand-accent hover:shadow-sm disabled:opacity-50"
                  aria-label={`Apply ${t.label} template`}
                >
                  <span className="text-2xl" aria-hidden>{t.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">{t.label}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{t.blurb}</div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: t.primaryColor }} aria-hidden />
                      {t.services.length} services · {t.intakeForm ? "intake form" : "no intake"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-4">
              <button
                onClick={() => {
                  void persistStep("industry", "skipped");
                  gotoStep("service");
                }}
                disabled={busy}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                Skip — I&rsquo;ll start from scratch →
              </button>
            </div>
          </>
        )}

        {step === "service" && (
          <>
            <h2 className="text-lg font-medium">Create your first service</h2>
            <p className="mt-1 text-sm text-slate-600">You can add more later.</p>
            <label className="mt-4 block text-sm font-medium">Service name</label>
            <input
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            />
            <label className="mt-4 block text-sm font-medium">Duration (minutes)</label>
            <input
              type="number" min={5} step={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="mt-1 w-32 rounded-md border px-3 py-2 text-sm"
            />
          </>
        )}

        {step === "hours" && (
          <>
            <h2 className="text-lg font-medium">When are you available?</h2>
            <p className="mt-1 text-sm text-slate-600">Times are in {defaultTimezone}.</p>
            {appliedTemplate && (
              <p className="mt-2 inline-flex rounded-md bg-green-50 px-2 py-0.5 text-xs text-green-700">
                ✓ Template applied
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, d) => (
                <button
                  key={label}
                  onClick={() => toggleDay(d)}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm " +
                    (days.includes(d) ? "border-brand-accent bg-brand-accent text-white" : "bg-white hover:bg-slate-50")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="rounded-md border px-2 py-1 text-sm" />
              <span className="text-slate-400">–</span>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded-md border px-2 py-1 text-sm" />
            </div>
          </>
        )}

        {step === "google" && (
          <>
            <h2 className="text-lg font-medium">Connect Google Calendar</h2>
            <p className="mt-1 text-sm text-slate-600">
              Optional — when connected, every booking creates a Google Meet event and sends an invite.
            </p>
            <div className="mt-4 flex gap-2">
              <a
                href="/api/google/connect"
                onClick={startGoogleConnect}
                className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Connect Google
              </a>
              <button
                onClick={skipGoogle}
                className="rounded-md border px-4 py-2 text-sm hover:bg-slate-50"
              >
                Skip for now
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h2 className="text-lg font-medium">You&rsquo;re ready</h2>
            <p className="mt-1 text-sm text-slate-600">
              Your public booking page is <code className="rounded bg-slate-100 px-1.5 py-0.5">/u/{tenantSlug}</code>.
              Share it to start taking bookings.
            </p>
            <div className="mt-4 rounded-md border bg-slate-50 p-3 font-mono text-xs">
              {typeof window !== "undefined" ? window.location.origin : ""}/u/{tenantSlug}
            </div>
          </>
        )}

        {error && <div className="mt-4 text-sm text-red-600">{error}</div>}
        {completionBlockers.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-red-600">
            {completionBlockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}

        <div className="mt-6 flex items-center justify-between">
          {stepIndex > 0 && step !== "done" ? (
            <button
              onClick={() => gotoStep(STEPS[stepIndex - 1].id)}
              disabled={busy}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              ← Back
            </button>
          ) : <div />}

          <div className="flex items-center gap-3">
            {/* "Finish later" — escape hatch. Visible on every step
                except the final celebration. Server sets skipped_at;
                the wizard remains resumable. */}
            {step !== "done" && (
              <button
                onClick={finishLater}
                disabled={busy}
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
              >
                {busy ? "…" : "Finish later"}
              </button>
            )}

            {step === "industry" && <span />}
            {step === "service" && (
              <button onClick={createService} disabled={busy} className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? "Saving…" : "Continue"}
              </button>
            )}
            {step === "hours" && (
              <button onClick={saveHours} disabled={busy} className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? "Saving…" : "Continue"}
              </button>
            )}
            {step === "google" && (
              <button onClick={continueFromGoogle} disabled={busy} className="rounded-md border px-4 py-2 text-sm hover:bg-slate-50">
                Continue
              </button>
            )}
            {step === "done" && (
              <button onClick={finish} disabled={busy} className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? "Finishing…" : "Go to dashboard"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
