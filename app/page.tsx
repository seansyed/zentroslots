import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import MarketingNav from "@/components/MarketingNav";
import Footer from "@/components/Footer";

/**
 * Root route — host-aware dispatch (Phase 17I-6).
 *
 * Two domains resolve to the same Next.js process via the upstream
 * reverse proxy:
 *
 *   zentromeet.com       → marketing (this file's JSX below)
 *   app.zentromeet.com   → application
 *
 * The application subdomain must NEVER render marketing content. We
 * detect the host on the server, and for any `app.*` host we redirect
 * straight to /dashboard. The existing /dashboard page already
 * handles its own auth gate (`if (!session) redirect("/dashboard/
 * login")`), so:
 *
 *   app.* + signed in   → /dashboard
 *   app.* + signed out  → /dashboard → /dashboard/login
 *   zentromeet.com + *  → marketing (byte-identical to before)
 *
 * Why detect on the SERVER rather than middleware:
 *   • This route is the only one that renders marketing-only chrome
 *     at the root path; every other route (/u/*, /dashboard/*,
 *     /reschedule/*, /reset-password/*, etc.) is already correctly
 *     host-agnostic.
 *   • A middleware change touches the whole app surface; a one-line
 *     redirect here is strictly additive.
 *
 * Host matching rule:
 *   Any incoming host beginning with `app.` (case-insensitive) is
 *   treated as the application domain. This covers app.zentromeet.com
 *   and any future white-label app subdomain (app.<custom>.com).
 *   Marketing rendering is unchanged for every other host.
 */
async function isAppSubdomain(): Promise<boolean> {
  const h = await headers();
  // Prefer the proxy-forwarded host when Caddy/nginx sits in front;
  // fall back to the direct host header otherwise. Lowercased to be
  // case-insensitive.
  const raw =
    h.get("x-forwarded-host")?.toLowerCase() ?? h.get("host")?.toLowerCase() ?? "";
  // Strip a possible port suffix (e.g. "app.zentromeet.com:443") for
  // clean prefix matching.
  const host = raw.split(":")[0];
  return host.startsWith("app.");
}

export default async function HomePage() {
  if (await isAppSubdomain()) {
    // /dashboard handles its own auth gate — when no session it
    // redirects to /dashboard/login. So a single redirect from here
    // covers both authenticated and unauthenticated visitors.
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-20 text-center">
        <div className="inline-flex rounded-full border bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
          Scheduling, done right
        </div>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Book meetings without the back-and-forth.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">
          A multi-tenant scheduling platform with custom branding, Google Meet, and
          enterprise-grade availability rules. Set it up in five minutes.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/dashboard/login"
            className="rounded-md bg-brand-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Start free →
          </Link>
          <Link
            href="/pricing"
            className="rounded-md border bg-white px-5 py-2.5 text-sm font-medium hover:bg-slate-50"
          >
            See pricing
          </Link>
        </div>
        <div className="mt-3 text-xs text-slate-500">Free plan to start · no credit card · upgrade or cancel anytime</div>
      </section>

      {/* Logo strip placeholder */}
      <section className="border-y bg-slate-50 py-8">
        <div className="mx-auto max-w-5xl px-6 text-center text-xs uppercase tracking-wider text-slate-400">
          Trusted by teams that hate scheduling email threads
        </div>
      </section>

      {/* Feature grid */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          <Feature title="Set hours once" body="Weekly availability + one-off overrides for vacations, holidays, and split-day schedules." />
          <Feature title="Public booking page" body="Branded URL per workspace. Color, logo, tagline — your business, your look." />
          <Feature title="Google Meet built-in" body="Every confirmed booking auto-creates a Google Meet event and emails the invite." />
          <Feature title="Multi-tenant from day one" body="Run multiple workspaces, isolated data, strict tenant boundaries." />
          <Feature title="Cancel & reschedule" body="Signed token links in every email — no logins, no friction." />
          <Feature title="Analytics that matter" body="Bookings, conversion, top services, revenue estimates. Simple charts." />
        </div>
      </section>

      {/* Business Phone — major launch feature */}
      <section className="border-t bg-slate-50 py-16">
        <div className="mx-auto max-w-5xl px-6">
          <div className="rounded-2xl border bg-white p-8 shadow-sm sm:p-10">
            <div className="grid items-center gap-8 lg:grid-cols-2">
              <div>
                <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                  New · Business Phone
                </span>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900">
                  Meetings, scheduling, and business calls — all in one place.
                </h2>
                <p className="mt-3 text-slate-600">
                  ZentroMeet now gives service businesses more than online booking. Manage appointments, reminders,
                  client communication, and a dedicated business phone line from one modern platform.
                </p>
                <Link
                  href="/business-phone"
                  className="mt-6 inline-flex rounded-md bg-brand-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Explore Business Phone →
                </Link>
              </div>

              <div className="rounded-xl border bg-slate-50 p-6">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-accent text-white">
                    <PhoneIcon className="h-6 w-6" />
                  </span>
                  <div>
                    <div className="font-medium text-slate-900">Business Phone</div>
                    <div className="text-sm text-slate-600">$29/month · 1,000 US &amp; Canada minutes</div>
                  </div>
                </div>
                <p className="mt-3 text-sm text-slate-600">
                  Add a dedicated business number, forward calls to your phone, click-to-call clients, and track call
                  usage inside ZentroMeet.
                </p>
                <ul className="mt-4 grid grid-cols-1 gap-1.5 text-sm text-slate-700 sm:grid-cols-2">
                  <li className="flex gap-2"><span className="text-green-600">✓</span>Dedicated business number</li>
                  <li className="flex gap-2"><span className="text-green-600">✓</span>Call forwarding</li>
                  <li className="flex gap-2"><span className="text-green-600">✓</span>Click-to-call</li>
                  <li className="flex gap-2"><span className="text-green-600">✓</span>Call logs and usage</li>
                  <li className="flex gap-2"><span className="text-green-600">✓</span>1,000 US &amp; Canada minutes</li>
                  <li className="flex gap-2 text-slate-500"><span aria-hidden>•</span>Softphone coming soon</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/*
        Testimonials section removed: the previous fake quote with
        a "Real testimonial coming soon" disclaimer was misleading
        to visitors. When real testimonials exist, this is the spot
        to add them back. Until then, the feature grid above + the
        CTA below are sufficient social-proof-light surface.
      */}

      {/* CTA */}
      <section className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Ready to stop emailing about meetings?</h2>
        <p className="mt-3 text-slate-600">Sign up free. Upgrade only when you outgrow it.</p>
        <Link
          href="/dashboard/login"
          className="mt-6 inline-flex rounded-md bg-brand-accent px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
        >
          Get started free
        </Link>
      </section>

      <Footer />
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="text-base font-medium text-slate-900">{title}</div>
      <p className="mt-2 text-sm text-slate-600">{body}</p>
    </div>
  );
}

/** Inline phone-handset glyph (outline) — keeps the marketing page dep-free. */
function PhoneIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
    </svg>
  );
}

