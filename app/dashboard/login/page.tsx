"use client";

/**
 * /dashboard/login — premium enterprise auth surface for app.zentromeet.com.
 *
 * Layout (≥lg):
 *   ┌──────────────────────────┬───────────────────┐
 *   │ atmospheric product side │ elevated auth card │
 *   └──────────────────────────┴───────────────────┘
 *
 * Mobile (<lg): single-column auth card with brand at top.
 *
 * Auth surfaces preserved verbatim:
 *   • Google OAuth   — /api/auth/oauth/google/start
 *   • Microsoft OAuth — /api/auth/oauth/microsoft/start
 *   • Email + password login    — POST /api/auth/login
 *   • Email + password signup   — POST /api/auth/signup
 *   • Forgot password           — /forgot-password
 *   • GA4 events                — signup_started, signup_completed
 *   • OAUTH_ERROR_LABELS        — ?error=… query handling
 *
 * Premium pass (2026-05-27):
 *   • Split layout w/ ambient gradient mesh
 *   • Elevated glass auth card (rounded-3xl, layered shadows)
 *   • Cinematic but restrained motion (prefers-reduced-motion respected)
 *   • Product context panel: mini schedule preview + analytics tile
 *   • Trust chips: Google/Microsoft secured, encrypted, enterprise SLA
 *   • Refined OAuth chrome
 *   • Mobile-first responsive
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { trackEvent } from "@/lib/analytics/ga4/client";

const OAUTH_ERROR_LABELS: Record<string, string> = {
  cancelled: "You cancelled the sign-in. No worries — try again any time.",
  state_mismatch:
    "The sign-in link expired. Click Continue with Google or Microsoft to try again.",
  token_exchange_failed:
    "We couldn't reach the identity provider. Please try again in a moment.",
  email_not_verified:
    "That Google account's email isn't verified. Verify the email in your Google settings, then try again.",
  missing_email:
    "We couldn't read your email from that provider. Use email + password to continue.",
  invalid_callback: "Sign-in didn't complete. Please try again.",
  provider_error: "The identity provider returned an error. Please try again.",
  not_configured:
    "Single sign-on isn't configured yet on this workspace. Use email + password to continue.",
  session_mint_failed: "Sign-in completed, but we couldn't start your session. Please try again.",
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [signupStartedFired, setSignupStartedFired] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "staff" | "client">("admin");
  const [workspaceName, setWorkspaceName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<"google" | "microsoft" | null>(null);

  // GA4 — fire `signup_started` once per session when entering signup mode
  useEffect(() => {
    if (mode === "signup" && !signupStartedFired) {
      trackEvent("signup_started");
      setSignupStartedFired(true);
    }
  }, [mode, signupStartedFired]);

  // Surface OAuth-callback errors carried in the ?error= query string.
  useEffect(() => {
    const code = sp.get("error");
    if (code) {
      setError(OAUTH_ERROR_LABELS[code] ?? "Sign-in didn't complete. Please try again.");
      const url = new URL(window.location.href);
      url.searchParams.delete("error");
      window.history.replaceState({}, "", url.toString());
    }
  }, [sp]);

  function startOAuth(provider: "google" | "microsoft") {
    setError(null);
    setOauthLoading(provider);
    window.location.href = `/api/auth/oauth/${provider}/start`;
  }

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const url = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body =
        mode === "login"
          ? { email, password }
          : {
              email,
              password,
              name,
              role,
              timezone: tz,
              ...(role === "admin" ? { workspaceName } : { tenantSlug }),
            };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      if (mode === "signup") {
        trackEvent("signup_completed");
      }
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  const isLogin = mode === "login";

  return (
    <div className="zm-login relative min-h-screen w-full overflow-hidden bg-white text-slate-900">
      <AmbientMesh />

      <div className="relative grid min-h-screen lg:grid-cols-[1.05fr_1fr] xl:grid-cols-[1.12fr_1fr]">
        {/* ============ LEFT — Atmospheric product panel ============ */}
        <aside className="zm-fade-up relative hidden flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
          {/* Subtle vertical edge to separate from auth panel */}
          <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-slate-200/70 to-transparent" />

          {/* ── Brand row ── */}
          <div className="relative flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/zentromeet-wordmark.svg" alt="ZentroMeet" className="h-9 w-auto" />
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              All systems operational
            </span>
          </div>

          {/* ── Hero copy + product context ── */}
          <div className="relative space-y-9">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full border border-sky-200/70 bg-sky-50/60 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-sky-700">
                <SparkIcon className="h-3 w-3" />
                Operator-grade scheduling
              </div>
              <h2 className="mt-4 max-w-xl text-[34px] font-semibold leading-[1.08] tracking-tight text-slate-900 xl:text-[40px]">
                The scheduling platform built for{" "}
                <span className="bg-gradient-to-r from-sky-600 to-sky-500 bg-clip-text text-transparent">
                  serious operators.
                </span>
              </h2>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-slate-600">
                Run appointments, automate scheduling, and grow your business from
                one elegant operational command center.
              </p>
            </div>

            {/* Mini product previews */}
            <div className="grid gap-4 sm:grid-cols-2 xl:max-w-xl">
              <PreviewSchedule />
              <PreviewAnalytics />
            </div>

            {/* Trust strip */}
            <TrustStrip />
          </div>

          {/* ── Footer ── */}
          <div className="relative flex items-center justify-between text-[11px] text-slate-400">
            <span>© {new Date().getFullYear()} ZentroMeet · enterprise scheduling platform</span>
            <span className="inline-flex items-center gap-2">
              <a href="https://zentromeet.com/terms" className="hover:text-slate-600">Terms</a>
              <span className="text-slate-300">·</span>
              <a href="https://zentromeet.com/privacy" className="hover:text-slate-600">Privacy</a>
            </span>
          </div>
        </aside>

        {/* ============ RIGHT — Auth panel ============ */}
        <main className="relative flex items-center justify-center px-5 py-10 sm:px-8 sm:py-14 lg:px-10 lg:py-12">
          <div className="zm-fade-up-delayed relative w-full max-w-[440px]">
            {/* Mobile brand */}
            <div className="mb-8 flex justify-center lg:hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/zentromeet-wordmark.svg" alt="ZentroMeet" className="h-10 w-auto" />
            </div>

            {/* Heading */}
            <div className="text-center lg:text-left">
              <h1 className="text-[28px] font-semibold tracking-tight text-slate-900 sm:text-[30px]">
                {isLogin ? "Welcome back" : "Create your workspace"}
              </h1>
              <p className="mt-2 text-[14px] leading-relaxed text-slate-500">
                {isLogin
                  ? "Run appointments, automate scheduling, and grow your business with ZentroMeet."
                  : "Start your scheduling workspace in under a minute."}
              </p>
            </div>

            {/* Auth card — elevated glass surface */}
            <div className="zm-card mt-7 rounded-3xl border border-slate-200/80 bg-white/85 p-6 backdrop-blur-xl sm:p-7">
              {/* OAuth providers */}
              <div className="space-y-2.5">
                <ProviderButton
                  provider="google"
                  label={`Continue with Google${!isLogin ? " (new account)" : ""}`}
                  loading={oauthLoading === "google"}
                  disabled={Boolean(oauthLoading)}
                  onClick={() => startOAuth("google")}
                />
                <ProviderButton
                  provider="microsoft"
                  label={`Continue with Microsoft${!isLogin ? " (new account)" : ""}`}
                  loading={oauthLoading === "microsoft"}
                  disabled={Boolean(oauthLoading)}
                  onClick={() => startOAuth("microsoft")}
                />
              </div>

              {/* Divider */}
              <div className="my-6 flex items-center gap-3">
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-200 to-slate-200" />
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  or use email
                </span>
                <span className="h-px flex-1 bg-gradient-to-l from-transparent via-slate-200 to-slate-200" />
              </div>

              {/* Email / password form */}
              <form
                className="space-y-2.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!loading) submit();
                }}
              >
                {!isLogin && (
                  <>
                    <FormInput
                      placeholder="Full name"
                      value={name}
                      onChange={(v) => setName(v)}
                      autoComplete="name"
                    />
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as typeof role)}
                      className="block h-11 w-full rounded-xl border border-slate-300/90 bg-white px-3.5 text-[14px] text-slate-900 transition-colors focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
                    >
                      <option value="admin">Admin (create new workspace)</option>
                      <option value="staff">Staff (join existing workspace)</option>
                      <option value="client">Client (join existing workspace)</option>
                    </select>
                    {role === "admin" ? (
                      <FormInput
                        placeholder="Workspace name (e.g. Acme Tax Co.)"
                        value={workspaceName}
                        onChange={(v) => setWorkspaceName(v)}
                      />
                    ) : (
                      <FormInput
                        placeholder="Workspace slug (e.g. acme-tax)"
                        value={tenantSlug}
                        onChange={(v) => setTenantSlug(v)}
                      />
                    )}
                  </>
                )}

                <FormInput
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(v) => setEmail(v)}
                  autoComplete="email"
                />
                <FormInput
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(v) => setPassword(v)}
                  autoComplete={isLogin ? "current-password" : "new-password"}
                />

                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/80 px-3 py-2.5 text-[13px] leading-snug text-rose-800"
                  >
                    <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0 text-rose-500" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || Boolean(oauthLoading)}
                  className="zm-primary-btn group relative mt-1 inline-flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-4 text-[14px] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_22px_-8px_rgba(56,124,225,0.55)] transition-all duration-200 hover:from-sky-500 hover:to-sky-700 hover:shadow-[0_1px_0_rgba(255,255,255,0.3)_inset,0_12px_28px_-8px_rgba(56,124,225,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
                >
                  {loading && <Spinner />}
                  <span>
                    {loading
                      ? "Working…"
                      : isLogin
                      ? "Sign in with email"
                      : "Create account"}
                  </span>
                  {!loading && (
                    <ArrowIcon className="ml-0.5 h-3.5 w-3.5 translate-x-0 opacity-90 transition-transform duration-200 group-hover:translate-x-0.5" />
                  )}
                </button>
              </form>

              {/* Secondary actions */}
              <div className="mt-5 flex flex-col items-center gap-2 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setMode(isLogin ? "signup" : "login");
                    setError(null);
                  }}
                  className="text-[13px] text-slate-600 transition-colors hover:text-slate-900"
                >
                  {isLogin
                    ? "No account yet? "
                    : "Already have an account? "}
                  <span className="font-medium text-sky-700 hover:text-sky-800">
                    {isLogin ? "Create your workspace" : "Sign in"}
                  </span>
                </button>
                {isLogin && (
                  <a
                    href="/forgot-password"
                    className="text-[12.5px] text-slate-500 transition-colors hover:text-slate-800"
                  >
                    Forgot your password?
                  </a>
                )}
              </div>
            </div>

            {/* Mobile trust strip */}
            <div className="mt-6 lg:hidden">
              <TrustStrip compact />
            </div>

            {/* Terms */}
            <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-400">
              By signing in you agree to our{" "}
              <a
                href="https://zentromeet.com/terms"
                className="underline-offset-2 hover:text-slate-600 hover:underline"
              >
                Terms
              </a>{" "}
              and{" "}
              <a
                href="https://zentromeet.com/privacy"
                className="underline-offset-2 hover:text-slate-600 hover:underline"
              >
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </main>
      </div>

      {/* Scoped keyframes — restrained, prefers-reduced-motion aware */}
      <style>{`
        .zm-login { font-feature-settings: "ss01", "cv11"; }
        @keyframes zm-fade-up {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes zm-mesh-drift-a {
          0%, 100% { transform: translate(0%, 0%) scale(1); opacity: 0.55; }
          50% { transform: translate(2%, -1.5%) scale(1.06); opacity: 0.7; }
        }
        @keyframes zm-mesh-drift-b {
          0%, 100% { transform: translate(0%, 0%) scale(1); opacity: 0.35; }
          50% { transform: translate(-1.5%, 1.5%) scale(1.04); opacity: 0.5; }
        }
        @keyframes zm-mesh-drift-c {
          0%, 100% { transform: translate(0%, 0%) scale(1); opacity: 0.25; }
          50% { transform: translate(1%, -1%) scale(1.03); opacity: 0.4; }
        }
        .zm-fade-up { animation: zm-fade-up 700ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .zm-fade-up-delayed { animation: zm-fade-up 700ms cubic-bezier(0.22, 1, 0.36, 1) 120ms both; }
        .zm-card {
          box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.9) inset,
            0 1px 3px rgba(15, 23, 42, 0.04),
            0 12px 36px -10px rgba(15, 23, 42, 0.10),
            0 24px 56px -24px rgba(15, 23, 42, 0.12);
        }
        .zm-mesh-a { animation: zm-mesh-drift-a 22s ease-in-out infinite; }
        .zm-mesh-b { animation: zm-mesh-drift-b 28s ease-in-out infinite; }
        .zm-mesh-c { animation: zm-mesh-drift-c 34s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .zm-fade-up, .zm-fade-up-delayed { animation: none; }
          .zm-mesh-a, .zm-mesh-b, .zm-mesh-c { animation: none; }
        }
      `}</style>
    </div>
  );
}

// ─── Ambient mesh background ──────────────────────────────────────────

function AmbientMesh() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Base gradient wash */}
      <div className="absolute inset-0 bg-[radial-gradient(125%_120%_at_0%_0%,rgba(53,157,243,0.10)_0%,rgba(53,157,243,0)_55%),radial-gradient(95%_100%_at_100%_100%,rgba(15,23,42,0.06)_0%,rgba(15,23,42,0)_60%)]" />
      {/* Floating blurred blobs */}
      <div className="zm-mesh-a absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full bg-sky-400/40 blur-[120px]" />
      <div className="zm-mesh-b absolute -bottom-40 left-1/4 h-[28rem] w-[28rem] rounded-full bg-indigo-300/30 blur-[140px]" />
      <div className="zm-mesh-c absolute -right-40 top-1/3 h-[26rem] w-[26rem] rounded-full bg-cyan-200/40 blur-[120px]" />
      {/* Subtle grain to break up the gradients */}
      <div className="absolute inset-0 opacity-[0.04] [background-image:radial-gradient(rgba(15,23,42,0.7)_1px,transparent_1px)] [background-size:3px_3px]" />
    </div>
  );
}

// ─── Mini product previews ────────────────────────────────────────────

function PreviewSchedule() {
  const slots = [
    { time: "9:00", label: "Discovery call · Mira", tone: "sky", live: false },
    { time: "11:30", label: "Q3 strategy · Nia", tone: "violet", live: true },
    { time: "2:00", label: "Onboarding · Tobi", tone: "emerald", live: false },
  ] as const;
  const tones = {
    sky: "border-sky-200 bg-sky-50/70 text-sky-800",
    violet: "border-violet-200 bg-violet-50/70 text-violet-800",
    emerald: "border-emerald-200 bg-emerald-50/70 text-emerald-800",
  } as const;
  return (
    <div className="zm-card rounded-2xl border border-slate-200/80 bg-white/85 p-4 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
          Today
        </div>
        <span className="text-[10px] font-medium text-slate-400">3 of 6 booked</span>
      </div>
      <div className="mt-2.5 space-y-1.5">
        {slots.map((s) => (
          <div
            key={s.time}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium ${tones[s.tone]}`}
          >
            <span className="font-mono tabular-nums opacity-80">{s.time}</span>
            <span className="truncate">{s.label}</span>
            {s.live && (
              <span className="ml-auto inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wider text-emerald-700">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                live
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewAnalytics() {
  // Static sparkline path — deterministic, no data leakage
  const points = [10, 16, 14, 22, 20, 30, 28, 38, 36, 44, 42, 52];
  const max = Math.max(...points);
  const w = 130;
  const h = 38;
  const stepX = w / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - (p / max) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div className="zm-card rounded-2xl border border-slate-200/80 bg-white/85 p-4 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">
          Bookings · 7d
        </div>
        <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
          +24%
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className="text-[22px] font-semibold tracking-tight text-slate-900"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          1,284
        </span>
        <span className="text-[11px] text-slate-500">appointments</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-10 w-full">
        <defs>
          <linearGradient id="zm-spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(56,189,248)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(56,189,248)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill="url(#zm-spark-fill)" />
        <path d={path} fill="none" stroke="rgb(14,165,233)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-slate-500">
        <AutomationIcon className="h-3 w-3 text-sky-600" />
        4 automations live
      </div>
    </div>
  );
}

// ─── Trust strip ──────────────────────────────────────────────────────

function TrustStrip({ compact = false }: { compact?: boolean }) {
  const chips = [
    { icon: ShieldIcon, label: compact ? "Encrypted" : "Encrypted infrastructure" },
    { icon: KeyIcon, label: compact ? "SSO secured" : "Google + Microsoft secured" },
    { icon: EnterpriseIcon, label: compact ? "Enterprise SLA" : "Enterprise-grade scheduling" },
    { icon: AutomationIcon, label: compact ? "Automations" : "Automation platform" },
  ];
  return (
    <div className={`flex flex-wrap items-center ${compact ? "justify-center gap-1.5" : "gap-2"}`}>
      {chips.map(({ icon: Icon, label }) => (
        <span
          key={label}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/70 px-2.5 py-1 text-[10.5px] font-medium text-slate-600 backdrop-blur-md transition-colors hover:border-slate-300 hover:text-slate-800"
        >
          <Icon className="h-3 w-3 text-slate-500" />
          {label}
        </span>
      ))}
    </div>
  );
}

// ─── Form input ───────────────────────────────────────────────────────

function FormInput({
  type = "text",
  placeholder,
  value,
  onChange,
  autoComplete,
}: {
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      className="block h-11 w-full rounded-xl border border-slate-300/90 bg-white px-3.5 text-[14px] text-slate-900 placeholder:text-slate-400 transition-all duration-150 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400/20"
    />
  );
}

// ─── OAuth Provider button ────────────────────────────────────────────

function ProviderButton({
  provider,
  label,
  loading,
  disabled,
  onClick,
}: {
  provider: "google" | "microsoft";
  label: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={loading}
      className={[
        "group relative inline-flex h-11 w-full items-center justify-center gap-3 overflow-hidden rounded-xl border bg-white px-4 text-[14px] font-medium text-slate-800",
        "border-slate-300/90 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_1px_2px_rgba(15,23,42,0.04)]",
        "transition-all duration-200 ease-out",
        "hover:border-slate-400/80 hover:bg-slate-50/70 hover:shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_4px_14px_rgba(15,23,42,0.08)]",
        "active:translate-y-px active:shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_1px_2px_rgba(15,23,42,0.04)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-60",
      ].join(" ")}
    >
      <span className="flex h-5 w-5 items-center justify-center">
        {loading ? <Spinner /> : provider === "google" ? <GoogleG /> : <MicrosoftMark />}
      </span>
      <span>{label}</span>
    </button>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.5-8 19.5-20 0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.1l6.6 4.8C14.8 15.2 19 12 24 12c3 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.1z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.4 35 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5c3.4 5.9 9.8 10 17.8 10z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.6l6.3 5.3C40.9 35.5 44 30.2 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 23 23" className="h-4 w-4" aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="#F35325" />
      <rect x="12" y="1" width="10" height="10" fill="#81BC06" />
      <rect x="1" y="12" width="10" height="10" fill="#05A6F0" />
      <rect x="12" y="12" width="10" height="10" fill="#FFBA08" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Glyphs ───────────────────────────────────────────────────────────

function ShieldIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function KeyIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="15" r="4" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
function EnterpriseIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 7v10M15 7v10M3 12h18" />
    </svg>
  );
}
function AutomationIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
function SparkIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" />
    </svg>
  );
}
function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}
