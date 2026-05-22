"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

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
  icon: React.ReactNode;
};

const NAV: NavItem[] = [
  {
    key: "home",
    label: "Home",
    href: (s) => `/client/${s}`,
    matches: (p, s) => p === `/client/${s}` || p === `/client/${s}/`,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
        <path d="M3 12l9-9 9 9M5 10v10h14V10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "bookings",
    label: "Bookings",
    href: (s) => `/client/${s}/bookings`,
    matches: (p, s) => p.startsWith(`/client/${s}/bookings`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "messages",
    label: "Messages",
    href: (s) => `/client/${s}/messages`,
    matches: (p, s) => p.startsWith(`/client/${s}/messages`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "notifications",
    label: "Alerts",
    href: (s) => `/client/${s}/notifications`,
    matches: (p, s) => p.startsWith(`/client/${s}/notifications`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "profile",
    label: "Profile",
    href: (s) => `/client/${s}/profile`,
    matches: (p, s) => p.startsWith(`/client/${s}/profile`),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
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
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white pb-20 lg:pb-0">
      {/* Top bar (mobile + desktop) */}
      <header
        className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur"
        style={{ borderTop: `4px solid ${accent}` }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {tenant.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenant.logoUrl} alt="" className="h-8 w-8 rounded-md object-contain" />
            ) : (
              <div
                className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold text-white"
                style={{ backgroundColor: accent }}
                aria-hidden
              >
                {tenant.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{tenant.name}</div>
              <div className="truncate text-[11px] text-slate-500">Client portal</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden text-right text-xs sm:block">
              <div className="font-medium text-slate-900">{customer.name}</div>
              <div className="text-slate-500">{customer.email}</div>
            </div>
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold text-white"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              {initial}
            </div>
            <button
              onClick={logout}
              className="ml-1 hidden rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 sm:inline-flex"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl gap-6 px-4 py-6 lg:px-6">
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
                  <span style={active ? { color: accent } : undefined}>{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
            <button
              onClick={logout}
              className="mt-3 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-white hover:text-slate-900"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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
              Powered by ZentroMeet
            </footer>
          )}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden"
        aria-label="Portal"
      >
        <div className="mx-auto flex max-w-md items-stretch justify-around">
          {NAV.map((item) => {
            const active = item.matches(pathname, tenant.slug);
            return (
              <Link
                key={item.key}
                href={item.href(tenant.slug)}
                className="flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2.5 text-[10px] font-medium transition"
                style={{ color: active ? accent : "#64748b" }}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
