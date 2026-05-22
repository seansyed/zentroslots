"use client";

/**
 * ClientPortalShell — Phase 18 polish pass.
 *
 * Same structural contract as before (header + desktop sidebar + mobile
 * bottom-nav). Three trust-and-usability fixes shipped here:
 *
 *   1. The "Messages" tab is GONE from the navigation. It was a
 *      "Coming soon" stub and eroded trust on a customer-facing surface.
 *      The /messages page itself now redirects to the portal home so
 *      bookmarks don't 404.
 *   2. The "Sign out" button is now visible on mobile too. Previously
 *      it was hidden behind `sm:inline-flex`, and the desktop sidebar
 *      copy was hidden behind `lg:block`, leaving mobile visitors with
 *      no visible sign-out path. The mobile variant uses a compact
 *      icon-only button to fit the header without crowding the avatar.
 *   3. A subtle gradient backdrop + ambient glow accents now match the
 *      premium tone of the rest of ZentroMeet (dashboard, governance,
 *      onboarding). No structural change — just calmer depth.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Calendar, Bell, User, LogOut } from "lucide-react";

type ShellProps = {
  tenant: { slug: string; name: string; logoUrl: string | null; primaryColor: string; hidePoweredBy: boolean };
  customer: { name: string; email: string };
  title: string;
  children: React.ReactNode;
};

type NavItem = {
  key: string;
  label: string;
  href: (slug: string) => string;
  matches: (pathname: string, slug: string) => boolean;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
};

// Note: "Messages" was removed in Phase 18. The route still exists but
// is a redirect → home; it's no longer surfaced as a tab so customers
// don't see a Coming Soon stub. Restore here once messaging ships.
const NAV: NavItem[] = [
  {
    key: "home",
    label: "Home",
    href: (s) => `/client/${s}`,
    matches: (p, s) => p === `/client/${s}` || p === `/client/${s}/`,
    Icon: Home,
  },
  {
    key: "bookings",
    label: "Bookings",
    href: (s) => `/client/${s}/bookings`,
    matches: (p, s) => p.startsWith(`/client/${s}/bookings`),
    Icon: Calendar,
  },
  {
    key: "notifications",
    label: "Alerts",
    href: (s) => `/client/${s}/notifications`,
    matches: (p, s) => p.startsWith(`/client/${s}/notifications`),
    Icon: Bell,
  },
  {
    key: "profile",
    label: "Profile",
    href: (s) => `/client/${s}/profile`,
    matches: (p, s) => p.startsWith(`/client/${s}/profile`),
    Icon: User,
  },
];

export default function ClientPortalShell({ tenant, customer, title, children }: ShellProps) {
  const pathname = usePathname();
  const accent = tenant.primaryColor;
  const initial = (customer.name || customer.email || "?").trim().charAt(0).toUpperCase();

  async function logout() {
    await fetch(`/api/client/${encodeURIComponent(tenant.slug)}/auth/logout`, { method: "POST" });
    window.location.href = `/client/${tenant.slug}/login`;
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50 via-white to-white pb-24 lg:pb-0">
      {/* Phase 18 — ambient depth (extremely subtle). Matches the
          treatment used on the dashboard / governance / onboarding
          surfaces so the portal stops feeling visually disconnected. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-32 -z-10 h-[28rem] w-[28rem] rounded-full opacity-50 blur-[120px]"
        style={{ backgroundColor: accent, opacity: 0.06 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-[28rem] -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.04] blur-[120px]"
      />

      {/* Top bar (mobile + desktop) */}
      <header
        className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur-md"
        style={{ borderTop: `3px solid ${accent}` }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {tenant.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logoUrl} alt="" className="h-8 w-8 rounded-md object-contain" />
            ) : (
              <div
                className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold text-white shadow-sm"
                style={{ backgroundColor: accent }}
                aria-hidden
              >
                {tenant.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{tenant.name}</div>
              <div className="truncate text-[11px] text-slate-500">Secure client portal</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden text-right text-xs sm:block">
              <div className="font-medium text-slate-900">{customer.name}</div>
              <div className="text-slate-500">{customer.email}</div>
            </div>
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              {initial}
            </div>

            {/* Sign-out — visible on every viewport.
                Desktop/tablet shows the text label; phone shows an
                icon-only button so the header doesn't crowd. */}
            <button
              type="button"
              onClick={logout}
              aria-label="Sign out"
              className="ml-1 hidden rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow sm:inline-flex"
            >
              Sign out
            </button>
            <button
              type="button"
              onClick={logout}
              aria-label="Sign out"
              className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 shadow-sm transition active:scale-95 sm:hidden"
            >
              <LogOut className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        </div>
      </header>

      <div className="relative mx-auto flex max-w-5xl gap-6 px-4 py-6 lg:px-6">
        {/* Desktop sidebar */}
        <aside className="hidden w-56 shrink-0 lg:block">
          <nav className="sticky top-24 space-y-1" aria-label="Portal">
            {NAV.map((item) => {
              const active = item.matches(pathname, tenant.slug);
              return (
                <Link
                  key={item.key}
                  href={item.href(tenant.slug)}
                  className={
                    "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition " +
                    (active
                      ? "bg-white font-medium text-slate-900 shadow-sm ring-1 ring-slate-200"
                      : "text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-sm")
                  }
                  style={active ? { color: accent } : undefined}
                >
                  <item.Icon
                    className="h-5 w-5"
                    strokeWidth={1.75}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
            <button
              type="button"
              onClick={logout}
              className="mt-3 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-white hover:text-slate-900"
            >
              <LogOut className="h-5 w-5" strokeWidth={1.75} />
              Sign out
            </button>
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
          <div className="mt-5">{children}</div>

          {!tenant.hidePoweredBy && (
            <footer className="mt-12 border-t border-slate-200 pt-4 text-center text-[11px] text-slate-400">
              Secure scheduling · Powered by ZentroMeet
            </footer>
          )}
        </main>
      </div>

      {/* Mobile bottom nav — 4 tabs since Messages removed. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden"
        aria-label="Portal"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex max-w-md items-stretch justify-around">
          {NAV.map((item) => {
            const active = item.matches(pathname, tenant.slug);
            return (
              <Link
                key={item.key}
                href={item.href(tenant.slug)}
                aria-current={active ? "page" : undefined}
                className="flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2.5 text-[10px] font-medium transition"
                style={{ color: active ? accent : "#64748b" }}
              >
                <item.Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
