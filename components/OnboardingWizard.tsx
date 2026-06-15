"use client";

/**
 * Premium onboarding wizard — luxury activation experience.
 *
 * Composition:
 *   Hero            → workspace name + step + readiness score + ETA
 *   ProgressRail    → animated segmented stepper
 *   MainGrid        → step content (left) + contextual side panel (right)
 *   Footer          → escape hatch + Back + Continue
 *
 * Hardened behaviors (DO NOT REGRESS — see lib/onboarding/*):
 *   • Step transitions persist via PATCH /api/onboarding/progress
 *   • Template application is idempotent + transactional server-side
 *   • OAuth round-trip restores wizard at the same step
 *   • "Finish later" sets onboarding_skipped_at (no fake complete)
 *   • Activation integrity is enforced server-side at /complete
 *
 * Visual system mirrors Security Center / Governance Center / Analytics:
 *   PremiumCard surfaces, brand-tinted glows, FadeIn entrances,
 *   shimmer skeletons, animated progress fill, hover lift + ring rings.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCircle2,
  Sparkles,
  Calendar,
  Clock,
  Globe,
  ShieldCheck,
  Video,
  Layers,
  Copy,
  Mail,
  ExternalLink,
  Rocket,
  PartyPopper,
  QrCode,
  ChevronRight,
  Info,
  Briefcase,
  Calculator,
  Stethoscope,
  Scissors,
  Target,
  Scale,
  Receipt,
  HeartHandshake,
  Dumbbell,
  Sparkle,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import QRCode from "qrcode";

import { TEMPLATES, getTemplate, type IndustryTemplate } from "@/lib/templates";
import { PremiumCard, InsightCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import {
  ONBOARDING_STEPS,
  computeProgressPercent,
  type OnboardingProgress,
  type OnboardingStep,
} from "@/lib/onboarding/types";
import { cn } from "@/lib/cn";

// ── Step definitions ───────────────────────────────────────────────

type StepDef = {
  id: OnboardingStep;
  label: string;
  shortLabel: string;
  etaMin: number;
};

const STEPS: StepDef[] = [
  { id: "industry", label: "Choose your industry", shortLabel: "Industry", etaMin: 1 },
  { id: "service",  label: "Add your first service", shortLabel: "Service", etaMin: 1 },
  { id: "hours",    label: "Set your working hours", shortLabel: "Hours", etaMin: 1 },
  { id: "google",   label: "Connect calendar (optional)", shortLabel: "Calendar", etaMin: 1 },
  { id: "done",     label: "Launch your workspace", shortLabel: "Go live", etaMin: 0 },
];

// ── Icon registry for templates ─────────────────────────────────────

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  Calculator,
  Stethoscope,
  Scissors,
  Target,
  Scale,
  Briefcase,
  Receipt,
  HeartHandshake,
  Dumbbell,
};

function templateIcon(t: IndustryTemplate): LucideIcon {
  if (t.iconName && TEMPLATE_ICONS[t.iconName]) return TEMPLATE_ICONS[t.iconName];
  return Briefcase;
}

// ── Persistence helper ─────────────────────────────────────────────

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
    // will re-resume at whatever the last-persisted step was.
  }
}

// ── Plan-aware messaging (no upsell blocking) ───────────────────────

type PlanTier = "free" | "pro" | "team" | "enterprise" | string;

function isPaid(plan: PlanTier): boolean {
  return plan !== "free";
}

// ── Component ──────────────────────────────────────────────────────

export type OnboardingWizardProps = {
  defaultTimezone: string;
  tenantName: string;
  tenantSlug: string;
  tenantPlan: string;
  userEmail: string;
  userName: string;
  initialStep?: OnboardingStep;
  initialProgress?: OnboardingProgress;
  hasGoogleConnected?: boolean;
};

export default function OnboardingWizard(props: OnboardingWizardProps) {
  const {
    defaultTimezone,
    tenantName,
    tenantSlug,
    tenantPlan,
    userEmail,
    userName,
    initialStep,
    initialProgress,
    hasGoogleConnected = false,
  } = props;

  const safeInitial: OnboardingStep =
    initialStep && (ONBOARDING_STEPS as readonly string[]).includes(initialStep)
      ? initialStep
      : "industry";

  const [step, setStep] = useState<OnboardingStep>(safeInitial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completionBlockers, setCompletionBlockers] = useState<string[]>([]);

  // Per-step working state ────────────────────────────────────────
  const [appliedTemplate, setAppliedTemplate] = useState<string | null>(
    initialProgress?.templateApplied ?? null,
  );
  const appliedTpl = useMemo(
    () => (appliedTemplate ? getTemplate(appliedTemplate) ?? null : null),
    [appliedTemplate],
  );

  // Service step
  const [serviceName, setServiceName] = useState("30-min Intro Call");
  const [duration, setDuration] = useState(30);

  // Hours step — initialize from template if available
  const [days, setDays] = useState<number[]>(
    appliedTpl?.defaultHours?.days ?? [1, 2, 3, 4, 5],
  );
  const [start, setStart] = useState(appliedTpl?.defaultHours?.start ?? "09:00");
  const [end, setEnd] = useState(appliedTpl?.defaultHours?.end ?? "17:00");

  // If template gets applied mid-session, refresh hours defaults — only
  // if the user hasn't already adjusted them.
  const userTouchedHours = useRef(false);
  useEffect(() => {
    if (!appliedTpl?.defaultHours) return;
    if (userTouchedHours.current) return;
    setDays(appliedTpl.defaultHours.days);
    setStart(appliedTpl.defaultHours.start);
    setEnd(appliedTpl.defaultHours.end);
  }, [appliedTpl]);

  // Derived progress
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const stepDef = STEPS[stepIndex] ?? STEPS[0];
  const progressPercent = computeProgressPercent(initialProgress ?? {});
  const visualPercent = Math.max(
    progressPercent,
    Math.round(((stepIndex + 1) / STEPS.length) * 100),
  );
  const remainingMin = STEPS.slice(stepIndex).reduce((sum, s) => sum + s.etaMin, 0);

  // ── Step navigation ─────────────────────────────────────────────

  function gotoStep(next: OnboardingStep) {
    setStep(next);
    setError(null);
    setCompletionBlockers([]);
    void persistStep(next, "in_progress");
    // Scroll the top of the workspace into view for long step content.
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    }
  }

  // ── Actions ─────────────────────────────────────────────────────

  async function applyTemplate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/apply-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Couldn't apply template");
      setAppliedTemplate(id);
      gotoStep("hours");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function createService() {
    setBusy(true);
    setError(null);
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
    // Guard the all-days-off state: an empty schedule saves zero
    // availability rows, which the API accepts but which leaves the
    // tenant un-completable (the activation gate requires availability)
    // and routes the user to the terminal "done" step. Require at least
    // one working day before advancing.
    if (days.length === 0) {
      setError("Select at least one working day before continuing.");
      return;
    }
    setBusy(true);
    setError(null);
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

  function startGoogleConnect() {
    void persistStep("google", "in_progress");
  }

  function skipGoogle() {
    void persistStep("google", "skipped");
    gotoStep("done");
  }

  function continueFromGoogle() {
    void persistStep("google", hasGoogleConnected ? "complete" : "skipped");
    gotoStep("done");
  }

  async function finish() {
    setBusy(true);
    setError(null);
    setCompletionBlockers([]);
    try {
      const res = await fetch("/api/onboarding/complete", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
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

  async function finishLater() {
    setBusy(true);
    setError(null);
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

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-brand-subtle/30 via-surface to-surface">
      {/* Ambient glows — pin to the page so they stay in place on scroll. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-accent/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-1/3 h-72 w-72 rounded-full bg-violet-400/10 blur-3xl"
      />

      <div className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
        <Hero
          tenantName={tenantName}
          userName={userName}
          tenantPlan={tenantPlan}
          stepLabel={stepDef.label}
          stepIndex={stepIndex}
          stepCount={STEPS.length}
          readinessPercent={visualPercent}
          remainingMin={remainingMin}
        />

        <ProgressRail
          steps={STEPS}
          currentIndex={stepIndex}
          className="mt-6"
        />

        <div className="mt-7 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px]">
          {/* ── Main step content ────────────────────────────── */}
          <FadeIn className="min-w-0" key={step}>
            <PremiumCard interactive={false} className="relative overflow-hidden">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand-accent/8 blur-3xl"
              />

              {step === "industry" && (
                <IndustryStep
                  templates={TEMPLATES}
                  appliedTemplate={appliedTemplate}
                  busy={busy}
                  onApply={applyTemplate}
                  onStartFromScratch={() => {
                    void persistStep("industry", "skipped");
                    gotoStep("service");
                  }}
                />
              )}

              {step === "service" && (
                <ServiceStep
                  name={serviceName}
                  duration={duration}
                  onName={setServiceName}
                  onDuration={setDuration}
                />
              )}

              {step === "hours" && (
                <HoursStep
                  days={days}
                  start={start}
                  end={end}
                  timezone={defaultTimezone}
                  templateSummary={appliedTpl?.defaultHours?.summary}
                  templateLabel={appliedTpl?.label}
                  onToggleDay={(d) => {
                    userTouchedHours.current = true;
                    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
                  }}
                  onStart={(v) => { userTouchedHours.current = true; setStart(v); }}
                  onEnd={(v) => { userTouchedHours.current = true; setEnd(v); }}
                />
              )}

              {step === "google" && (
                <GoogleStep
                  onConnect={startGoogleConnect}
                  onSkip={skipGoogle}
                  hasConnected={hasGoogleConnected}
                />
              )}

              {step === "done" && (
                <DoneStep
                  tenantName={tenantName}
                  tenantSlug={tenantSlug}
                  tenantPlan={tenantPlan}
                  userEmail={userEmail}
                />
              )}

              {error && (
                <div
                  role="alert"
                  className="relative mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50/70 p-3 text-[12.5px] text-red-800"
                >
                  <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
                  <div className="min-w-0">
                    <div className="font-medium">{error}</div>
                    {completionBlockers.length > 0 && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {completionBlockers.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}

              <StepFooter
                step={step}
                stepIndex={stepIndex}
                busy={busy}
                onBack={() => gotoStep(STEPS[stepIndex - 1]?.id ?? "industry")}
                onContinue={() => {
                  if (step === "service") void createService();
                  else if (step === "hours") void saveHours();
                  else if (step === "google") void continueFromGoogle();
                  else if (step === "done") void finish();
                }}
                onFinishLater={finishLater}
              />
            </PremiumCard>
          </FadeIn>

          {/* ── Contextual side panel ─────────────────────────── */}
          <SidePanel
            step={step}
            appliedTpl={appliedTpl}
            tenantPlan={tenantPlan}
            visualPercent={visualPercent}
          />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// HERO
// ─────────────────────────────────────────────────────────────────────

function Hero({
  tenantName,
  userName,
  tenantPlan,
  stepLabel,
  stepIndex,
  stepCount,
  readinessPercent,
  remainingMin,
}: {
  tenantName: string;
  userName: string;
  tenantPlan: string;
  stepLabel: string;
  stepIndex: number;
  stepCount: number;
  readinessPercent: number;
  remainingMin: number;
}) {
  const planLabel = tenantPlan === "free" ? "Free" : tenantPlan.replace(/^\w/, (c) => c.toUpperCase());
  return (
    <FadeIn className="relative">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
              Workspace launch
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-ink-subtle">
              <Sparkle className="h-2.5 w-2.5" strokeWidth={2.5} /> {planLabel}
            </span>
          </div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight text-ink sm:text-[30px]">
            {greeting()}, {firstName(userName)}.
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-muted">
            Let&rsquo;s get <span className="font-medium text-ink">{tenantName}</span> ready to take its first booking — about {remainingMin} {remainingMin === 1 ? "minute" : "minutes"} left.
          </p>
        </div>

        <ReadinessRing
          percent={readinessPercent}
          subtitle={`Step ${Math.min(stepIndex + 1, stepCount)} of ${stepCount}`}
          label={stepLabel}
        />
      </div>
    </FadeIn>
  );
}

function ReadinessRing({
  percent,
  subtitle,
  label,
}: {
  percent: number;
  subtitle: string;
  label: string;
}) {
  const r = 28;
  const c = 2 * Math.PI * r;
  const dash = (percent / 100) * c;
  return (
    <div className="flex items-center gap-3 self-stretch sm:self-auto">
      <div className="relative h-[72px] w-[72px] shrink-0" aria-hidden>
        <svg viewBox="0 0 72 72" className="h-[72px] w-[72px] -rotate-90">
          <circle cx="36" cy="36" r={r} className="fill-none stroke-surface-inset" strokeWidth="6" />
          <circle
            cx="36"
            cy="36"
            r={r}
            className="fill-none stroke-brand-accent transition-[stroke-dasharray] duration-700 ease-out"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
            style={{ filter: "drop-shadow(0 0 8px rgba(53,157,243,0.45))" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[14px] font-semibold tabular-nums text-ink">{percent}%</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{subtitle}</div>
        <div className="mt-0.5 text-[13.5px] font-medium tracking-tight text-ink">{label}</div>
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
function firstName(name: string): string {
  return name?.split(/\s+/)[0] || "there";
}

// ─────────────────────────────────────────────────────────────────────
// PROGRESS RAIL
// ─────────────────────────────────────────────────────────────────────

function ProgressRail({
  steps,
  currentIndex,
  className,
}: {
  steps: StepDef[];
  currentIndex: number;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      {/* Mobile: stacked rail with current label */}
      <div className="sm:hidden">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-inset ring-1 ring-border/60">
          {steps.map((_, i) => (
            <div
              key={i}
              className={cn(
                "flex-1 transition-all duration-500 ease-out",
                i < currentIndex
                  ? "bg-brand-accent"
                  : i === currentIndex
                    ? "bg-gradient-to-r from-brand-accent to-brand-hover"
                    : "bg-transparent",
                i < steps.length - 1 && "mr-0.5",
              )}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="font-medium text-ink-muted">
            <span className="tabular-nums text-ink">{currentIndex + 1}</span>
            <span> of </span>
            <span className="tabular-nums">{steps.length}</span>
          </span>
          <span className="font-medium text-brand-accent">{steps[currentIndex]?.shortLabel ?? ""}</span>
        </div>
      </div>

      {/* Desktop: segmented rail with labels */}
      <ol className="hidden items-center gap-2 sm:flex">
        {steps.map((s, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <li key={s.id} className="flex flex-1 items-center gap-2">
              <div
                className={cn(
                  "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-300",
                  done
                    ? "bg-brand-accent text-white shadow-[0_0_0_4px_rgba(53,157,243,0.12)]"
                    : active
                      ? "bg-brand-accent text-white shadow-[0_0_0_6px_rgba(53,157,243,0.18)]"
                      : "border border-border bg-surface text-ink-subtle",
                )}
                aria-current={active ? "step" : undefined}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
              </div>
              <div className="hidden min-w-0 flex-1 md:block">
                <div
                  className={cn(
                    "truncate text-[11.5px] font-medium tracking-tight transition-colors",
                    done ? "text-ink" : active ? "text-ink" : "text-ink-subtle",
                  )}
                >
                  {s.shortLabel}
                </div>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    "h-px flex-1 transition-colors duration-500",
                    done ? "bg-brand-accent" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SIDE PANEL (contextual tips + plan teasers)
// ─────────────────────────────────────────────────────────────────────

function SidePanel({
  step,
  appliedTpl,
  tenantPlan,
  visualPercent,
}: {
  step: OnboardingStep;
  appliedTpl: IndustryTemplate | null;
  tenantPlan: string;
  visualPercent: number;
}) {
  return (
    <aside className="space-y-4">
      <FadeIn delay={1}>
        <PremiumCard interactive={false} compact className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/15">
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
                Guidance
              </div>
              <div className="text-[13px] font-semibold text-ink">{tipFor(step).title}</div>
            </div>
          </div>
          <p className="text-[12px] leading-relaxed text-ink-muted">{tipFor(step).body}</p>

          {step === "hours" && appliedTpl?.defaultHours && (
            <div className="rounded-lg border border-brand-accent/15 bg-brand-subtle/50 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-brand-accent">
                <Clock className="h-3 w-3" strokeWidth={2.25} />
                {appliedTpl.label}
              </div>
              <div className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                {appliedTpl.defaultHours.summary}
              </div>
            </div>
          )}
        </PremiumCard>
      </FadeIn>

      {/* Launch progress card */}
      <FadeIn delay={2}>
        <PremiumCard interactive={false} compact>
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              Launch readiness
            </div>
            <div className="text-[14px] font-semibold tabular-nums text-brand-accent">
              {visualPercent}%
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-inset">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-accent to-brand-hover transition-[width] duration-700"
              style={{ width: `${visualPercent}%` }}
            />
          </div>
          <ul className="mt-3 space-y-1.5 text-[12px]">
            {STEPS.filter((s) => s.id !== "done").map((s, i) => {
              const idx = STEPS.findIndex((x) => x.id === step);
              const done = i < idx;
              const active = s.id === step;
              return (
                <li key={s.id} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                      done
                        ? "bg-emerald-500 text-white"
                        : active
                          ? "bg-brand-subtle text-brand-accent ring-2 ring-brand-accent/30"
                          : "bg-surface-inset text-ink-subtle",
                    )}
                  >
                    {done ? (
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    ) : active ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-brand-accent" />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "truncate",
                      done ? "text-ink-muted line-through decoration-emerald-400/50" : active ? "text-ink font-medium" : "text-ink-subtle",
                    )}
                  >
                    {s.shortLabel}
                  </span>
                </li>
              );
            })}
          </ul>
        </PremiumCard>
      </FadeIn>

      {/* Plan teaser — non-blocking */}
      {step !== "done" && !isPaid(tenantPlan) && step !== "industry" && (
        <FadeIn delay={3}>
          <InsightCard title="Coming on Pro">
            <span className="text-ink">
              Recurring appointments, follow-up automations, and waitlists — all unlock when you
              upgrade. <span className="text-ink-muted">No pressure during setup.</span>
            </span>
          </InsightCard>
        </FadeIn>
      )}
    </aside>
  );
}

function tipFor(step: OnboardingStep): { title: string; body: string } {
  switch (step) {
    case "industry":
      return {
        title: "Use a template",
        body: "Templates pre-fill services, an intake form, departments, and brand colors based on your industry. Most users save 10–15 minutes of manual setup.",
      };
    case "service":
      return {
        title: "Start small",
        body: "One service is enough to start. Most businesses launch with a single discovery / intro offering and add more later as patterns settle.",
      };
    case "hours":
      return {
        title: "Pick realistic hours",
        body: "Your weekly schedule sets what clients can book. You can add specific exceptions and time-off later under Availability.",
      };
    case "google":
      return {
        title: "Why connect Google",
        body: "Every booking automatically creates a Google Meet link and blocks your calendar — preventing double-bookings without manual sync.",
      };
    case "done":
      return {
        title: "You're live",
        body: "Your booking page is live and ready to accept appointments. Try sending the link to a friend or yourself to see the full experience.",
      };
  }
}

// ─────────────────────────────────────────────────────────────────────
// STEP: INDUSTRY
// ─────────────────────────────────────────────────────────────────────

function IndustryStep({
  templates,
  appliedTemplate,
  busy,
  onApply,
  onStartFromScratch,
}: {
  templates: IndustryTemplate[];
  appliedTemplate: string | null;
  busy: boolean;
  onApply: (id: string) => void;
  onStartFromScratch: () => void;
}) {
  return (
    <div className="relative">
      <StepHeader
        eyebrow="Step 1 of 5"
        title="What kind of business are you running?"
        body="Pick a template — we'll create services, an intake form, departments, and brand colors. You can edit anything later in 2 clicks."
      />

      <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {templates.map((t, idx) => (
          <FadeIn key={t.id} delay={Math.min(idx, 6)}>
            <TemplateCard
              template={t}
              applied={appliedTemplate === t.id}
              busy={busy}
              onClick={() => onApply(t.id)}
            />
          </FadeIn>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-border bg-surface-subtle px-4 py-3 text-[12px]">
        <div className="text-ink-muted">
          <span className="font-medium text-ink">Not in this list?</span> Start from scratch and add your own services next.
        </div>
        <button
          type="button"
          onClick={onStartFromScratch}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-[11.5px] font-medium text-ink-muted transition-all hover:-translate-y-0.5 hover:border-brand-accent/30 hover:text-ink disabled:opacity-50"
        >
          Skip templates
          <ChevronRight className="h-3 w-3" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  applied,
  busy,
  onClick,
}: {
  template: IndustryTemplate;
  applied: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const Icon = templateIcon(template);
  const sample = template.services.slice(0, 3);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={`Apply ${template.label} template`}
      className={cn(
        "group relative w-full overflow-hidden rounded-2xl border bg-surface p-4 text-left transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft",
        applied
          ? "border-brand-accent/60 ring-2 ring-brand-accent/15 shadow-soft"
          : "border-border",
        busy && "opacity-60",
      )}
    >
      {/* Hover glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-80"
        style={{ background: `${template.primaryColor}30` }}
      />

      <div className="relative flex items-start gap-3">
        <div
          aria-hidden
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-border/60 transition-transform duration-200 group-hover:scale-105"
          style={{ background: `${template.primaryColor}14`, color: template.primaryColor }}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[14px] font-semibold tracking-tight text-ink">
              {template.label}
            </div>
            {applied && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-700">
                <CheckCircle2 className="h-2.5 w-2.5" strokeWidth={3} />
                Applied
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">{template.blurb}</p>

          {/* Best-for chips */}
          {template.bestFor && template.bestFor.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {template.bestFor.slice(0, 3).map((b) => (
                <span
                  key={b}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-subtle"
                >
                  {b}
                </span>
              ))}
            </div>
          )}

          {/* Sample services preview */}
          <div className="mt-2.5 space-y-1 border-t border-border/60 pt-2.5">
            {sample.map((s) => (
              <div key={s.name} className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 truncate text-ink-muted">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: s.color ?? template.primaryColor }}
                  />
                  <span className="truncate">{s.name}</span>
                </div>
                <span className="ml-2 shrink-0 tabular-nums text-ink-subtle">{s.durationMinutes}m</span>
              </div>
            ))}
          </div>

          {template.automationExamples && template.automationExamples.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-ink-subtle">
              <Sparkles className="h-2.5 w-2.5" strokeWidth={2.25} />
              {template.automationExamples[0]}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP: SERVICE
// ─────────────────────────────────────────────────────────────────────

const SERVICE_PRESETS = [
  { name: "30-min Intro Call", duration: 30, hint: "Discovery / consult" },
  { name: "1-on-1 Session", duration: 60, hint: "Standard appointment" },
  { name: "Quick 15-min Chat", duration: 15, hint: "Fast Q&A" },
  { name: "Deep-dive Strategy", duration: 90, hint: "Premium offering" },
];

function ServiceStep({
  name,
  duration,
  onName,
  onDuration,
}: {
  name: string;
  duration: number;
  onName: (s: string) => void;
  onDuration: (n: number) => void;
}) {
  return (
    <div className="relative">
      <StepHeader
        eyebrow="Step 2 of 5"
        title="Add your first service"
        body="What's the simplest thing customers will book? You can add more later."
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {SERVICE_PRESETS.map((p) => {
          const active = name === p.name && duration === p.duration;
          return (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                onName(p.name);
                onDuration(p.duration);
              }}
              className={cn(
                "group rounded-xl border p-3 text-left transition-all duration-200 ease-out",
                "hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft",
                active
                  ? "border-brand-accent/60 bg-brand-subtle/50 ring-1 ring-brand-accent/15"
                  : "border-border bg-surface",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-semibold text-ink">{p.name}</div>
                {active && <CheckCircle2 className="h-4 w-4 text-brand-accent" strokeWidth={2} />}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
                <span className="inline-flex items-center gap-1 rounded-md bg-surface-inset px-1.5 py-0.5 font-medium">
                  <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                  {p.duration}m
                </span>
                <span>{p.hint}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Service name
          </label>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink shadow-sm transition-all focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Duration (min)
          </label>
          <input
            type="number"
            min={5}
            step={5}
            value={duration}
            onChange={(e) => onDuration(Number(e.target.value))}
            className="mt-1.5 block w-24 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] tabular-nums text-ink shadow-sm transition-all focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>
      </div>

      {/* Booking preview */}
      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-gradient-to-br from-surface-subtle to-surface">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-subtle">
          <span>Booking preview</span>
          <span className="font-mono text-[10px] normal-case tracking-normal text-ink-subtle">/u/your-slug</span>
        </div>
        <div className="p-3.5">
          <div className="text-[13px] font-semibold text-ink">{name || "Your service"}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-muted">
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-subtle px-1.5 py-0.5 font-medium text-brand-accent">
              <Clock className="h-2.5 w-2.5" strokeWidth={2.5} /> {duration}m
            </span>
            <span>Free</span>
          </div>
          <div className="mt-2.5 grid grid-cols-4 gap-1.5">
            {["9:00", "9:30", "10:00", "10:30"].map((t) => (
              <div
                key={t}
                className="rounded-md border border-border bg-surface px-1 py-1 text-center text-[11px] tabular-nums text-ink"
              >
                {t}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP: HOURS
// ─────────────────────────────────────────────────────────────────────

function HoursStep({
  days,
  start,
  end,
  timezone,
  templateSummary,
  templateLabel,
  onToggleDay,
  onStart,
  onEnd,
}: {
  days: number[];
  start: string;
  end: string;
  timezone: string;
  templateSummary?: string;
  templateLabel?: string;
  onToggleDay: (d: number) => void;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
}) {
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="relative">
      <StepHeader
        eyebrow="Step 3 of 5"
        title="When are you available?"
        body={
          <>
            Pick the days and hours customers can book.{" "}
            <span className="inline-flex items-center gap-1 align-baseline">
              <Globe className="h-3 w-3 -translate-y-px text-ink-subtle" strokeWidth={2.25} />
              Times shown in <span className="font-medium text-ink">{timezone}</span>
            </span>
          </>
        }
      />

      {templateSummary && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-brand-accent/15 bg-brand-subtle/40 p-3">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-accent" strokeWidth={2} />
          <div className="text-[12px] leading-relaxed text-ink">
            <span className="font-semibold">{templateLabel}:</span>{" "}
            <span className="text-ink-muted">{templateSummary}</span>{" "}
            <span className="text-ink-subtle">(you can adjust)</span>
          </div>
        </div>
      )}

      <div className="mt-5">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          Working days
        </label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {dayLabels.map((label, d) => {
            const active = days.includes(d);
            return (
              <button
                key={label}
                type="button"
                onClick={() => onToggleDay(d)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-10 min-w-[3.25rem] items-center justify-center rounded-xl border text-[12.5px] font-semibold tracking-tight transition-all duration-200 ease-out",
                  "hover:-translate-y-0.5",
                  active
                    ? "border-brand-accent bg-brand-accent text-white shadow-soft"
                    : "border-border bg-surface text-ink-muted hover:border-brand-accent/30 hover:text-ink",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Start
          </label>
          <input
            type="time"
            value={start}
            onChange={(e) => onStart(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] tabular-nums text-ink shadow-sm transition-all focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            End
          </label>
          <input
            type="time"
            value={end}
            onChange={(e) => onEnd(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] tabular-nums text-ink shadow-sm transition-all focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
          />
        </div>
      </div>

      {/* Visual week summary */}
      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-surface-subtle">
        <div className="border-b border-border/60 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-subtle">
          Weekly schedule preview
        </div>
        <div className="grid grid-cols-7 divide-x divide-border">
          {dayLabels.map((label, d) => {
            const active = days.includes(d);
            return (
              <div
                key={label}
                className={cn(
                  "min-h-[68px] px-2 py-2 text-center",
                  active ? "bg-brand-subtle/60" : "bg-surface",
                )}
              >
                <div
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-wider",
                    active ? "text-brand-accent" : "text-ink-subtle",
                  )}
                >
                  {label}
                </div>
                {active ? (
                  <div className="mt-1 space-y-1">
                    <div className="rounded bg-brand-accent/15 px-1 py-0.5 text-[10px] tabular-nums text-brand-accent">
                      {start}
                    </div>
                    <div className="text-[8px] text-ink-subtle">to</div>
                    <div className="rounded bg-brand-accent/15 px-1 py-0.5 text-[10px] tabular-nums text-brand-accent">
                      {end}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-[10px] text-ink-subtle">Closed</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP: GOOGLE
// ─────────────────────────────────────────────────────────────────────

function GoogleStep({
  onConnect,
  onSkip,
  hasConnected,
}: {
  onConnect: () => void;
  onSkip: () => void;
  hasConnected: boolean;
}) {
  return (
    <div className="relative">
      <StepHeader
        eyebrow="Step 4 of 5 — optional"
        title="Connect Google Calendar"
        body="Sync availability, prevent double-bookings, and auto-generate Meet links. Takes about 10 seconds."
      />

      {hasConnected && (
        <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
          <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500 text-white shadow-sm">
            <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1 text-[12.5px]">
            <div className="font-semibold text-emerald-900">Google Calendar connected</div>
            <div className="text-emerald-800/70">
              Every new booking will create a Meet link and block your calendar automatically.
            </div>
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <BenefitCard
          icon={ShieldCheck}
          title="Conflict prevention"
          body="Existing meetings block matching booking slots in real time."
        />
        <BenefitCard
          icon={Video}
          title="Auto Meet links"
          body="Every confirmed booking includes a fresh Google Meet URL."
        />
        <BenefitCard
          icon={Layers}
          title="Cross-device sync"
          body="Appointments appear on every device the moment they're booked."
        />
      </div>

      <div className="mt-5 flex flex-col gap-2.5 rounded-xl border border-border bg-surface-subtle p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-border">
            <GoogleLogo />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">Google Calendar</div>
            <div className="text-[11.5px] text-ink-muted">
              {hasConnected ? "Connected — re-authorize if needed" : "Read availability, write bookings"}
            </div>
          </div>
        </div>
        <a
          href="/api/google/connect"
          onClick={onConnect}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-accent px-4 py-2 text-[12.5px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md"
        >
          {hasConnected ? "Reconnect" : "Connect Google"}
          <ExternalLink className="h-3 w-3" strokeWidth={2.25} />
        </a>
      </div>

      <div className="mt-4 flex items-center justify-center gap-2 text-[11.5px] text-ink-subtle">
        <ShieldCheck className="h-3 w-3" strokeWidth={2.25} />
        Read-only access to availability. Revocable anytime in Google Account → Security.
      </div>

      <div className="mt-5 flex items-center justify-center">
        <button
          type="button"
          onClick={onSkip}
          className="text-[12px] font-medium text-ink-subtle underline-offset-4 hover:text-ink hover:underline"
        >
          Skip for now — connect later in Settings
        </button>
      </div>
    </div>
  );
}

function BenefitCard({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="group rounded-xl border border-border bg-surface p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft">
      <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/15">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <div className="mt-2 text-[12.5px] font-semibold text-ink">{title}</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.7 4.7-6.2 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2.1 1.4-4.6 2.4-7.2 2.4-5.1 0-9.5-3.3-11.2-7.9l-6.5 5C9.5 39.5 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C41.4 35.8 44 30.3 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP: DONE — "Go Live" celebration
// ─────────────────────────────────────────────────────────────────────

function DoneStep({
  tenantName,
  tenantSlug,
  tenantPlan,
  userEmail,
}: {
  tenantName: string;
  tenantSlug: string;
  tenantPlan: string;
  userEmail: string;
}) {
  const [origin, setOrigin] = useState("");
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const bookingUrl = origin ? `${origin}/u/${tenantSlug}` : `/u/${tenantSlug}`;

  // QR code is generated lazily — only when the user clicks "Show QR".
  useEffect(() => {
    if (!showQr || qrSrc || qrError || !origin) return;
    QRCode.toDataURL(bookingUrl, {
      width: 192,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then(setQrSrc)
      .catch(() => setQrError(true));
  }, [showQr, qrSrc, qrError, origin, bookingUrl]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard permission — fall back to selectable text.
    }
  }

  const mailtoHref =
    `mailto:${encodeURIComponent(userEmail)}` +
    `?subject=${encodeURIComponent(`${tenantName} — your booking link`)}` +
    `&body=${encodeURIComponent(
      `Your ${tenantName} booking page is live.\n\n${bookingUrl}\n\nShare this link with anyone who needs to book time with you.`,
    )}`;

  return (
    <div className="relative">
      {/* Celebration glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-emerald-400/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-10 -bottom-16 h-40 w-40 rounded-full bg-brand-accent/15 blur-3xl"
      />

      <div className="relative flex items-start gap-3.5">
        <div className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_10px_28px_rgba(53,157,243,0.42)]">
          <PartyPopper className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
            Workspace live
          </div>
          <h2 className="mt-0.5 text-[22px] font-semibold tracking-tight text-ink sm:text-[26px]">
            {tenantName} is ready to take bookings.
          </h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            Share the link below — anyone with it can book time with you immediately.
          </p>
        </div>
      </div>

      {/* Booking link card */}
      <div className="relative mt-5 overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
              Your booking link
            </div>
            <div className="mt-1 truncate font-mono text-[14px] font-medium tracking-tight text-ink">
              {bookingUrl || "…"}
            </div>
          </div>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-accent px-3 py-2 text-[12px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md"
            aria-label="Copy booking link"
          >
            {copied ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.25} /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" strokeWidth={2.25} /> Copy
              </>
            )}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <a
            href={bookingUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[11.5px] font-semibold text-ink transition-all hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.25} />
            Open page
          </a>
          <a
            href={bookingUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[11.5px] font-semibold text-ink transition-all hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft"
          >
            <Calendar className="h-3.5 w-3.5" strokeWidth={2.25} />
            Test booking
          </a>
          <a
            href={mailtoHref}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[11.5px] font-semibold text-ink transition-all hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft"
          >
            <Mail className="h-3.5 w-3.5" strokeWidth={2.25} />
            Email me link
          </a>
          <button
            type="button"
            onClick={() => setShowQr((s) => !s)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[11.5px] font-semibold transition-all hover:-translate-y-0.5 hover:shadow-soft",
              showQr
                ? "border-brand-accent/40 bg-brand-subtle text-brand-accent"
                : "border-border bg-surface text-ink hover:border-brand-accent/30",
            )}
          >
            <QrCode className="h-3.5 w-3.5" strokeWidth={2.25} />
            {showQr ? "Hide QR" : "Show QR"}
          </button>
        </div>

        {showQr && (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-xl border border-border bg-surface p-4">
            {qrSrc ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrSrc}
                  alt={`QR code for ${bookingUrl}`}
                  className="h-44 w-44 rounded-lg"
                />
                <div className="text-[11px] text-ink-muted">
                  Scan with a phone camera to open your booking page.
                </div>
              </>
            ) : qrError ? (
              <div className="text-[11px] text-red-600">Couldn&rsquo;t render QR — try again.</div>
            ) : (
              <div className="h-44 w-44 animate-pulse rounded-lg bg-surface-inset" aria-hidden />
            )}
          </div>
        )}
      </div>

      {/* Readiness checklist */}
      <div className="relative mt-5 grid gap-3 sm:grid-cols-3">
        <ReadyTile icon={Rocket} label="Public page" subtitle="Live + indexable" />
        <ReadyTile icon={Calendar} label="Availability" subtitle="Schedule active" />
        <ReadyTile icon={Sparkles} label="Bookable" subtitle="Ready to receive" />
      </div>

      {/* Plan teaser — Pro-or-up */}
      {!isPaid(tenantPlan) ? (
        <FadeIn delay={2} className="mt-5">
          <InsightCard title="Next: scale with Pro">
            <span className="text-ink">
              Automated follow-ups, recurring appointments, waitlists, no-show recovery, custom
              domain — available whenever you&rsquo;re ready.{" "}
              <span className="text-ink-muted">Upgrade anytime · cancel anytime.</span>
            </span>
          </InsightCard>
        </FadeIn>
      ) : (
        <FadeIn delay={2} className="mt-5">
          <InsightCard title={`You're on ${tenantPlan.replace(/^\w/, (c) => c.toUpperCase())}`}>
            <span className="text-ink">
              Automation, recurring scheduling, and advanced routing are all unlocked. Set them up
              from Settings whenever you&rsquo;re ready.
            </span>
          </InsightCard>
        </FadeIn>
      )}

      <div className="relative mt-5 flex items-center justify-center gap-1.5 text-[11px] text-ink-subtle">
        <TrendingUp className="h-3 w-3" strokeWidth={2.25} />
        <span>Most workspaces book their first appointment within 24 hours of going live.</span>
      </div>
    </div>
  );
}

function ReadyTile({
  icon: Icon,
  label,
  subtitle,
}: {
  icon: LucideIcon;
  label: string;
  subtitle: string;
}) {
  return (
    <div className="group rounded-xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/50 to-surface p-3">
      <div className="flex items-center gap-2.5">
        <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-[0_4px_12px_rgba(16,185,129,0.25)]">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-emerald-900">{label}</div>
          <div className="text-[10.5px] text-emerald-800/70">{subtitle}</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// STEP HEADER (shared)
// ─────────────────────────────────────────────────────────────────────

function StepHeader({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <header className="relative">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
        {title}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FOOTER (back / continue / finish later)
// ─────────────────────────────────────────────────────────────────────

function StepFooter({
  step,
  stepIndex,
  busy,
  onBack,
  onContinue,
  onFinishLater,
}: {
  step: OnboardingStep;
  stepIndex: number;
  busy: boolean;
  onBack: () => void;
  onContinue: () => void;
  onFinishLater: () => void;
}) {
  const continueLabel =
    step === "service" || step === "hours"
      ? "Save & continue"
      : step === "google"
        ? "Continue"
        : step === "done"
          ? "Go to dashboard"
          : "Continue";

  return (
    <div className="relative mt-6 flex flex-col-reverse gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        {stepIndex > 0 ? (
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.25} />
            Back
          </button>
        ) : (
          <span />
        )}

        {/* "Finish later" stays available on every step — including the
            terminal "done" step. If completion is blocked by an activation
            integrity check (e.g. no availability / no bookable staff), this
            is the user's escape hatch to /api/onboarding/skip; without it
            the done step is a dead-end with no Back and no way out. */}
        <button
          type="button"
          onClick={onFinishLater}
          disabled={busy}
          className="text-[11.5px] font-medium text-ink-subtle underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
        >
          {busy ? "…" : "Finish later"}
        </button>
      </div>

      {/* Continue button — except on industry step, where each card IS the action */}
      {step !== "industry" && (
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-2.5 text-[13px] font-semibold shadow-sm transition-all duration-200 ease-out",
            step === "done"
              ? "bg-gradient-to-r from-brand-accent to-brand-hover text-white hover:-translate-y-0.5 hover:shadow-lift"
              : "bg-brand-accent text-white hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md",
            busy && "opacity-60",
          )}
        >
          {busy && step !== "done" ? "Saving…" : busy && step === "done" ? "Going live…" : continueLabel}
          {!busy && (step === "done" ? <Rocket className="h-3.5 w-3.5" strokeWidth={2.25} /> : <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />)}
        </button>
      )}
    </div>
  );
}

