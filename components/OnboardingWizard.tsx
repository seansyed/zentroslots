"use client";

import { useState } from "react";
import { TEMPLATES } from "@/lib/templates";

type Step = "industry" | "service" | "hours" | "google" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "industry", label: "Industry" },
  { id: "service",  label: "First service" },
  { id: "hours",    label: "Working hours" },
  { id: "google",   label: "Calendar" },
  { id: "done",     label: "Finish" },
];

export default function OnboardingWizard({
  defaultTimezone,
  tenantSlug,
}: {
  defaultTimezone: string;
  tenantSlug: string;
}) {
  const [step, setStep] = useState<Step>("industry");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Industry template (optional)
  const [appliedTemplate, setAppliedTemplate] = useState<string | null>(null);

  // Service
  const [serviceName, setServiceName] = useState("30-min Intro Call");
  const [duration, setDuration] = useState(30);

  // Hours (defaults: Mon–Fri 9–5)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");

  function toggleDay(d: number) {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
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
      // Skip the manual "service" step since the template created services for them.
      setStep("hours");
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
      setStep("hours");
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
      setStep("google");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/onboarding/complete", { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? "Couldn't finish");
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
                onClick={() => setStep("service")}
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
                className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Connect Google
              </a>
              <button
                onClick={() => setStep("done")}
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

        <div className="mt-6 flex items-center justify-between">
          {stepIndex > 0 && step !== "done" ? (
            <button
              onClick={() => setStep(STEPS[stepIndex - 1].id)}
              disabled={busy}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              ← Back
            </button>
          ) : <div />}

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
            <button onClick={() => setStep("done")} disabled={busy} className="rounded-md border px-4 py-2 text-sm hover:bg-slate-50">
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
  );
}
