"use client";

/**
 * NotFoundExperience — premium 404 surface for app.zentromeet.com.
 *
 * Renders inside app/not-found.tsx. The server-side entry passes in
 * `primaryHref` and `primaryLabel` so the call-to-action lands the
 * visitor in the right place (authenticated → dashboard, anonymous →
 * login). Everything else lives in this client component so we can
 * use window.history.back() for the secondary action.
 *
 * Design language matches the premium login pass:
 *   • Ambient gradient mesh (sky + indigo + cyan) with restrained drift
 *   • Glass card surface (rounded-3xl, layered shadow stack)
 *   • Cinematic entrance (700ms fade-up, prefers-reduced-motion aware)
 *   • Brand sky accent on the 404 wordmark + primary CTA
 *   • Lucide Compass icon — calming, navigational, not playful
 *   • Footer attribution + secondary helper links
 *
 * Accessibility:
 *   • role="alertdialog" so SR users understand "something went wrong"
 *   • Focus order: primary CTA → secondary CTA → footer links
 *   • Buttons keyboard navigable; visible focus rings
 *   • aria-hidden on decorative SVGs and mesh layer
 */

import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";
import { useCallback } from "react";

export default function NotFoundExperience({
  primaryHref,
  primaryLabel,
}: {
  primaryHref: string;
  primaryLabel: string;
}) {
  const goBack = useCallback(() => {
    // history.length includes the current entry; >1 means there is a
    // real previous page in this tab. Otherwise fall back to the same
    // primary destination so the user is never stranded.
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
    } else if (typeof window !== "undefined") {
      window.location.href = primaryHref;
    }
  }, [primaryHref]);

  return (
    <div
      role="alertdialog"
      aria-labelledby="zm-404-title"
      aria-describedby="zm-404-desc"
      className="zm-404 relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-white px-5 py-12 text-slate-900 sm:px-8"
    >
      <AmbientMesh />

      <div className="zm-fade-up relative w-full max-w-[560px]">
        {/* Brand row */}
        <div className="mb-8 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/zentromeet-wordmark.svg"
            alt="ZentroMeet"
            className="h-9 w-auto"
          />
        </div>

        {/* Glass card */}
        <div className="zm-card relative overflow-hidden rounded-3xl border border-slate-200/80 bg-white/85 px-6 py-9 text-center backdrop-blur-xl sm:px-10 sm:py-12">
          {/* Floating compass disc — visual cue, not a button */}
          <div
            aria-hidden
            className="zm-compass mx-auto mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-50 to-sky-100/70 ring-1 ring-inset ring-sky-200/80"
          >
            <Compass className="h-7 w-7 text-sky-600" strokeWidth={1.6} />
          </div>

          {/* 404 wordmark */}
          <div
            className="bg-gradient-to-b from-slate-900 via-slate-800 to-slate-500 bg-clip-text text-[88px] font-semibold leading-none tracking-tight text-transparent sm:text-[104px]"
            style={{ fontVariantNumeric: "tabular-nums" }}
            aria-hidden
          >
            404
          </div>

          {/* Headline + supporting text */}
          <h1
            id="zm-404-title"
            className="mt-5 text-[22px] font-semibold tracking-tight text-slate-900 sm:text-[24px]"
          >
            Page not found
          </h1>
          <p
            id="zm-404-desc"
            className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-slate-500"
          >
            The page you&rsquo;re looking for may have been moved, deleted, or
            never existed. Let&rsquo;s get you back on track.
          </p>

          {/* CTAs */}
          <div className="mt-7 flex flex-col items-stretch justify-center gap-2.5 sm:flex-row sm:gap-3">
            <Link
              href={primaryHref}
              prefetch={false}
              className="zm-primary-btn group relative inline-flex h-11 items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-b from-sky-500 to-sky-600 px-5 text-[14px] font-medium text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_22px_-8px_rgba(56,124,225,0.55)] transition-all duration-200 hover:from-sky-500 hover:to-sky-700 hover:shadow-[0_1px_0_rgba(255,255,255,0.3)_inset,0_12px_28px_-8px_rgba(56,124,225,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 focus-visible:ring-offset-2"
            >
              <span>{primaryLabel}</span>
              <span
                aria-hidden
                className="translate-x-0 transition-transform duration-200 group-hover:translate-x-0.5"
              >
                →
              </span>
            </Link>

            <button
              type="button"
              onClick={goBack}
              className="group inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-300/90 bg-white px-5 text-[14px] font-medium text-slate-700 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:border-slate-400/80 hover:bg-slate-50/70 hover:text-slate-900 hover:shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_4px_14px_rgba(15,23,42,0.08)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 focus-visible:ring-offset-2"
            >
              <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
              <span>Go back</span>
            </button>
          </div>

          {/* Optional helper links */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12.5px]">
            <Link
              href="/dashboard/login"
              prefetch={false}
              className="text-slate-500 transition-colors hover:text-slate-800"
            >
              Sign in
            </Link>
            <span className="text-slate-300" aria-hidden>
              ·
            </span>
            <a
              href="https://zentromeet.com"
              className="text-slate-500 transition-colors hover:text-slate-800"
            >
              Product home
            </a>
            <span className="text-slate-300" aria-hidden>
              ·
            </span>
            <a
              href="https://zentromeet.com/support"
              className="text-slate-500 transition-colors hover:text-slate-800"
            >
              Support
            </a>
          </div>
        </div>

        {/* Footer attribution */}
        <p className="mt-6 text-center text-[11px] text-slate-400">
          ZentroMeet · enterprise scheduling platform
        </p>
      </div>

      {/* Scoped keyframes — restrained, prefers-reduced-motion aware */}
      <style>{`
        @keyframes zm-404-fade-up {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes zm-404-mesh-a {
          0%, 100% { transform: translate(0%, 0%) scale(1); opacity: 0.55; }
          50% { transform: translate(2%, -1.5%) scale(1.06); opacity: 0.7; }
        }
        @keyframes zm-404-mesh-b {
          0%, 100% { transform: translate(0%, 0%) scale(1); opacity: 0.35; }
          50% { transform: translate(-1.5%, 1.5%) scale(1.04); opacity: 0.5; }
        }
        @keyframes zm-404-mesh-c {
          0%, 100% { transform: translate(0%, 0%) scale(1); opacity: 0.25; }
          50% { transform: translate(1%, -1%) scale(1.03); opacity: 0.4; }
        }
        @keyframes zm-404-compass-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        .zm-fade-up { animation: zm-404-fade-up 700ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .zm-card {
          box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.9) inset,
            0 1px 3px rgba(15, 23, 42, 0.04),
            0 12px 36px -10px rgba(15, 23, 42, 0.10),
            0 24px 56px -24px rgba(15, 23, 42, 0.12);
        }
        .zm-mesh-a { animation: zm-404-mesh-a 22s ease-in-out infinite; }
        .zm-mesh-b { animation: zm-404-mesh-b 28s ease-in-out infinite; }
        .zm-mesh-c { animation: zm-404-mesh-c 34s ease-in-out infinite; }
        .zm-compass { animation: zm-404-compass-float 6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .zm-fade-up, .zm-mesh-a, .zm-mesh-b, .zm-mesh-c, .zm-compass {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

// ─── Ambient mesh background ──────────────────────────────────────────

function AmbientMesh() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Base radial wash */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_0%,rgba(37,99,235,0.10)_0%,rgba(37,99,235,0)_55%),radial-gradient(100%_100%_at_50%_100%,rgba(15,23,42,0.05)_0%,rgba(15,23,42,0)_60%)]" />
      {/* Floating blurred blobs */}
      <div className="zm-mesh-a absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full bg-sky-400/35 blur-[120px]" />
      <div className="zm-mesh-b absolute -bottom-40 right-1/4 h-[28rem] w-[28rem] rounded-full bg-indigo-300/25 blur-[140px]" />
      <div className="zm-mesh-c absolute -right-40 top-1/3 h-[26rem] w-[26rem] rounded-full bg-cyan-200/35 blur-[120px]" />
      {/* Subtle grain */}
      <div className="absolute inset-0 opacity-[0.04] [background-image:radial-gradient(rgba(15,23,42,0.7)_1px,transparent_1px)] [background-size:3px_3px]" />
    </div>
  );
}
