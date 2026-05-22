import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { getClientSession } from "@/lib/client-auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function ClientLoginPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ invalid?: string }>;
}) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const linkExpired = sp.invalid === "1";

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) {
    // Premium workspace-not-found card (Phase 18 polish). Mirrors the
    // 404 the public booking page returns — never confirms whether the
    // slug exists, but presents the dead-end with care instead of a
    // bare line of grey text.
    return (
      <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50 via-white to-white">
        <div
          aria-hidden
          className="pointer-events-none absolute -left-40 top-40 -z-10 h-[28rem] w-[28rem] rounded-full bg-slate-300/[0.10] blur-[120px]"
        />
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-400 shadow-sm ring-1 ring-slate-200">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M9 9h.01M15 9h.01M8.5 15a4 4 0 0 1 7 0" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="mt-4 text-[18px] font-semibold tracking-tight text-slate-900">
            We couldn&rsquo;t find this workspace
          </h1>
          <p className="mt-1 max-w-sm text-[13.5px] leading-relaxed text-slate-500">
            The link may have a typo, or the workspace may have moved.
            Double-check the URL with the business you booked with.
          </p>
        </main>
      </div>
    );
  }

  // Already signed in? Send them straight to the portal.
  const session = await getClientSession();
  if (session && session.tenantId === tenant.id) {
    redirect(`/client/${slug}`);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50 via-white to-white">
      {/* Tenant-tinted ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-32 -z-10 h-[28rem] w-[28rem] rounded-full opacity-50 blur-[120px]"
        style={{ backgroundColor: tenant.primaryColor, opacity: 0.07 }}
      />

      <header
        className="border-b border-slate-200 bg-white/85 backdrop-blur-md"
        style={{ borderTop: `3px solid ${tenant.primaryColor}` }}
      >
        <div className="mx-auto max-w-md px-6 py-7">
          <div className="flex items-center gap-3">
            {tenant.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={tenant.logoUrl}
                alt=""
                className="h-10 w-10 rounded-lg object-contain shadow-sm ring-1 ring-slate-200"
              />
            ) : (
              <div
                className="flex h-10 w-10 items-center justify-center rounded-lg text-base font-semibold text-white shadow-sm"
                style={{ backgroundColor: tenant.primaryColor }}
                aria-hidden
              >
                {tenant.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                {tenant.name}
              </h1>
              <div className="text-[11px] text-slate-500">Secure client portal</div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md px-6 py-10">
        {linkExpired && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[13px] text-amber-900 shadow-sm"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" strokeLinecap="round" />
            </svg>
            <div>
              <div className="font-medium">That sign-in link is expired or invalid.</div>
              <div className="mt-0.5 text-[12px] text-amber-800/85">
                Enter your email below and we&rsquo;ll send a fresh one — they last 15 minutes.
              </div>
            </div>
          </div>
        )}

        <LoginForm slug={slug} accentColor={tenant.primaryColor} />

        {/* Phase 18 — calm trust strip. Three operational signals that
            cost nothing to claim because they're true: the portal is
            HTTPS, the magic-link uses a signed JWT with a 15-min TTL,
            and the booking link in the confirmation email lets the
            customer reschedule without ever signing in. */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11px] font-medium text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
              <path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" strokeLinejoin="round" />
              <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Secure portal
          </span>
          <span aria-hidden className="text-slate-300">·</span>
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" strokeLinecap="round" />
            </svg>
            Encrypted in transit
          </span>
          <span aria-hidden className="text-slate-300">·</span>
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Magic links expire in 15 min
          </span>
        </div>

        {!tenant.hidePoweredBy && (
          <footer className="mt-10 border-t border-slate-200/70 pt-4 text-center text-[11px] text-slate-400">
            Secure scheduling · Powered by ZentroMeet
          </footer>
        )}
      </main>
    </div>
  );
}
