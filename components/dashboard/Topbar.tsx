"use client";

import * as React from "react";
import Link from "next/link";
import { Search, LogOut, ShieldCheck, ChevronDown } from "lucide-react";

import { Avatar } from "@/components/ui/primitives";
import ThemeToggle from "./ThemeToggle";
import NotificationBell from "./NotificationBell";
import CommandPalette, { useCommandPalette } from "./CommandPalette";
import { cn } from "@/lib/cn";

type Crumb = { label: string; href?: string };

export default function Topbar({
  title,
  subtitle,
  crumbs,
  actions,
  user,
  onOpenSidebar,
}: {
  title?: string;
  subtitle?: string;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  user?: { name: string; email: string; role: string };
  onOpenSidebar?: () => void;
}) {
  const cmd = useCommandPalette();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur-xl sm:px-6">
      {onOpenSidebar && (
        <button
          type="button"
          aria-label="Open navigation"
          onClick={onOpenSidebar}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink lg:hidden"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
            <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
          </svg>
        </button>
      )}

      <div className="min-w-0 flex-1">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="hidden text-[11px] text-ink-muted sm:flex sm:items-center sm:gap-1.5">
            {crumbs.map((c, i) => (
              <React.Fragment key={`${i}:${c.label}`}>
                {i > 0 && <span className="text-ink-subtle">/</span>}
                {c.href ? (
                  <Link href={c.href} className="transition-colors hover:text-ink">
                    {c.label}
                  </Link>
                ) : (
                  <span className="font-medium text-ink">{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}
        {title && (
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink sm:text-base">
              {title}
            </h1>
            {subtitle && (
              <span className="hidden truncate text-[12px] text-ink-muted sm:inline">
                · {subtitle}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Search trigger (CommandPalette) — premium look */}
      <button
        type="button"
        onClick={cmd.open}
        className="hidden h-9 items-center gap-2 rounded-lg border border-border bg-surface-subtle px-3 text-[13px] text-ink-subtle transition-all hover:border-border-strong hover:bg-surface md:inline-flex md:w-64 lg:w-80"
      >
        <Search className="h-4 w-4" strokeWidth={1.75} />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="hidden rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle md:inline">
          ⌘K
        </kbd>
      </button>

      <div className="flex items-center gap-1">
        {actions}
        <button
          type="button"
          onClick={cmd.open}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink md:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <NotificationBell />
        <ThemeToggle />
        {user && <ProfileMenu user={user} />}
      </div>

      <CommandPalette open={cmd.isOpen} onClose={cmd.close} />
    </header>
  );
}

// ─── Profile dropdown ─────────────────────────────────────────────────

function ProfileMenu({ user }: { user: { name: string; email: string; role: string } }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "ml-1 inline-flex items-center gap-1.5 rounded-lg p-1 transition-colors",
          open ? "bg-surface-inset" : "hover:bg-surface-inset"
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar name={user.name} size="sm" />
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-ink-subtle transition-transform",
            open && "rotate-180"
          )}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-64 origin-top-right overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        >
          <div className="border-b border-border px-3 py-3">
            <div className="flex items-center gap-2.5">
              <Avatar name={user.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{user.name}</div>
                <div className="truncate text-[11px] text-ink-muted">{user.email}</div>
                <div className="mt-1">
                  <span className="rounded bg-brand-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand-accent">
                    {user.role}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="py-1">
            <Link
              href="/dashboard/settings/security"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
              role="menuitem"
            >
              <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
              Security
            </Link>
            <form action="/api/auth/logout" method="POST" className="block">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
                role="menuitem"
              >
                <LogOut className="h-4 w-4" strokeWidth={1.75} />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
