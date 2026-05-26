"use client";

/**
 * /dashboard/login — auth surface for app.zentromeet.com.
 *
 * Layout (top → bottom):
 *   ZentroMeet wordmark
 *   Heading + subheading
 *   Continue with Google      (Phase 17I-7)
 *   Continue with Microsoft   (Phase 17I-7)
 *   Divider                   (or use email and password)
 *   Email / password form
 *   Forgot password
 *   Switch to signup
 *
 * Provider buttons hit /api/auth/oauth/{google,microsoft}/start which
 * sets a CSRF state cookie + redirects to the provider's consent
 * screen. After consent the callback mints a ZentroMeet session
 * cookie (identical shape to the password-login route's cookie) and
 * lands the user at /dashboard.
 *
 * NO marketing content per the routing fix (Phase 17I-6).
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
  // Phase GA4 — guard against double-firing signup_started when the
  // user toggles mode back and forth between login and signup. We
  // fire once per page lifecycle.
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

  // Phase GA4 — fire `signup_started` the first time the visitor
  // enters signup mode (either by URL/state default or by clicking
  // "Create one" at the bottom of the form). One fire per session.
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
      // Strip the param so refresh doesn't re-show the message.
      const url = new URL(window.location.href);
      url.searchParams.delete("error");
      window.history.replaceState({}, "", url.toString());
    }
  }, [sp]);

  function startOAuth(provider: "google" | "microsoft") {
    setError(null);
    setOauthLoading(provider);
    // Full-page nav (NOT fetch) so the browser sends the cookies the
    // start route sets, and follows Google/Microsoft's 302 to consent.
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
      // Phase GA4 — fire `signup_completed` ONLY when the user came
      // through the signup form (not the login form). The OAuth
      // callbacks fire the same event for net-new identities, so
      // GA4 sees a unified "signup_completed" funnel across all three
      // entry surfaces (email/password, Google, Microsoft).
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-50 px-4 py-12">
      <div className="mx-auto max-w-md">
        {/* Brand lockup */}
        <div className="mb-8 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/zentromeet-wordmark.svg"
            alt="ZentroMeet"
            className="h-11 w-auto"
          />
        </div>

        <div className="text-center">
          <h1 className="text-[24px] font-semibold tracking-tight text-slate-900">
            {mode === "login" ? "Sign in to ZentroMeet" : "Create your workspace"}
          </h1>
          <p className="mt-1.5 text-[13px] text-slate-500">
            {mode === "login"
              ? "Welcome back. Continue with your provider or use email and password."
              : "Start your scheduling workspace in under a minute."}
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_1px_3px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.06)]">
          {/* ── OAuth provider buttons ─────────────────────────── */}
          <div className="space-y-2.5">
            <ProviderButton
              provider="google"
              label={`Continue with Google${mode === "signup" ? " (new account)" : ""}`}
              loading={oauthLoading === "google"}
              disabled={Boolean(oauthLoading)}
              onClick={() => startOAuth("google")}
            />
            <ProviderButton
              provider="microsoft"
              label={`Continue with Microsoft${mode === "signup" ? " (new account)" : ""}`}
              loading={oauthLoading === "microsoft"}
              disabled={Boolean(oauthLoading)}
              onClick={() => startOAuth("microsoft")}
            />
          </div>

          {/* ── Divider ────────────────────────────────────────── */}
          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              or use email
            </span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          {/* ── Email / password form ──────────────────────────── */}
          <form
            className="space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!loading) submit();
            }}
          >
            {mode === "signup" && (
              <>
                <input
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/15"
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/15"
                >
                  <option value="admin">Admin (create new workspace)</option>
                  <option value="staff">Staff (join existing workspace)</option>
                  <option value="client">Client (join existing workspace)</option>
                </select>
                {role === "admin" ? (
                  <input
                    placeholder="Workspace name (e.g. Acme Tax Co.)"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/15"
                  />
                ) : (
                  <input
                    placeholder="Workspace slug (e.g. acme-tax)"
                    value={tenantSlug}
                    onChange={(e) => setTenantSlug(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/15"
                  />
                )}
              </>
            )}

            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/15"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/15"
            />

            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || Boolean(oauthLoading)}
              className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-accent px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
            >
              {loading && <Spinner />}
              {loading
                ? "Working…"
                : mode === "login"
                ? "Sign in with email"
                : "Create account"}
            </button>
          </form>

          {/* ── Secondary actions ──────────────────────────────── */}
          <div className="mt-4 flex flex-col items-center gap-1.5 text-center">
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
              }}
              className="text-[12.5px] text-slate-600 hover:text-slate-900"
            >
              {mode === "login"
                ? "No account yet? Create your workspace"
                : "Already have an account? Sign in"}
            </button>
            {mode === "login" && (
              <a
                href="/forgot-password"
                className="text-[12px] text-slate-500 hover:text-slate-700"
              >
                Forgot your password?
              </a>
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-400">
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
    </div>
  );
}

// ─── Provider button ──────────────────────────────────────────────────

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
      className={[
        // Shared chrome
        "inline-flex w-full items-center justify-center gap-3 rounded-lg border px-4 py-2.5 text-sm font-medium",
        "transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:shadow-[0_4px_14px_rgba(15,23,42,0.08)]",
        "disabled:translate-y-0 disabled:opacity-60 disabled:shadow-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/30",
        // Provider-specific surface
        provider === "google"
          ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      ].join(" ")}
      aria-busy={loading}
    >
      {loading ? <Spinner /> : provider === "google" ? <GoogleG /> : <MicrosoftMark />}
      <span>{label}</span>
    </button>
  );
}

function GoogleG() {
  // Official multi-color "G" mark.
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.5-8 19.5-20 0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.1l6.6 4.8C14.8 15.2 19 12 24 12c3 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.1z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.4 35 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5c3.4 5.9 9.8 10 17.8 10z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.6l6.3 5.3C40.9 35.5 44 30.2 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}

function MicrosoftMark() {
  // Official 4-square Microsoft mark.
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
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
