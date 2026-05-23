"use client";

import * as React from "react";
import Link from "next/link";
import {
  Search,
  LogOut,
  ShieldCheck,
  ChevronDown,
  Plus,
  CalendarPlus,
  Users,
  Repeat,
  Ban,
  Building2,
  Shuffle,
} from "lucide-react";

import { Avatar } from "@/components/ui/primitives";
import ThemeToggle from "./ThemeToggle";
import NotificationBell from "./NotificationBell";
import NewAppointmentModal from "./NewAppointmentModal";
import NewBlockedTimeModal from "./NewBlockedTimeModal";
import NewGroupSessionModal from "./NewGroupSessionModal";
import NewInternalMeetingModal from "./NewInternalMeetingModal";
import NewRoundRobinModal from "./NewRoundRobinModal";
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
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border/70 bg-surface/70 px-4 backdrop-blur-2xl supports-[backdrop-filter]:bg-surface/55 sm:px-6">
      {/* Subtle bottom shadow that fades in once the user scrolls — pure CSS */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-border to-transparent"
      />
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

      {/* Search trigger (CommandPalette) — Linear/Vercel-style elevated */}
      <button
        type="button"
        onClick={cmd.open}
        className={cn(
          "hidden h-9 items-center gap-2 rounded-xl border border-border bg-surface-subtle px-3 text-[13px] text-ink-subtle transition-all duration-200 md:inline-flex md:w-64 lg:w-80",
          "hover:border-brand-accent/30 hover:bg-surface hover:text-ink hover:shadow-soft",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/30 focus-visible:border-brand-accent/40"
        )}
      >
        <Search className="h-4 w-4" strokeWidth={1.75} />
        <span className="flex-1 text-left">Search anything…</span>
        <kbd className="hidden h-5 items-center rounded-md border border-border bg-surface px-1.5 font-mono text-[10px] text-ink-subtle md:inline-flex">
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
        {/* Phase 17H — global Create dropdown. Only mounts when we
            have a user (sign-in pages don't show it). */}
        {user && <CreateMenu />}
        <NotificationBell />
        <ThemeToggle />
        {user && <ProfileMenu user={user} />}
      </div>

      <CommandPalette open={cmd.isOpen} onClose={cmd.close} />
    </header>
  );
}

// ─── Create dropdown (Phase 17H) ───────────────────────────────────────
//
// Global "Create" entry point. v1 ships ONE working item (One-on-One
// Appointment) + 4 "Coming soon" placeholders to signal the upcoming
// surface area (Group Session, Round Robin, Blocked Time, Internal
// Meeting). The placeholders are non-interactive — clicking does
// nothing. Future commits replace them with their own modals.

interface MeResponse {
  id: string;
  role: "admin" | "manager" | "staff" | "client";
}

function CreateMenu() {
  const [open, setOpen] = React.useState(false);
  const [showApptModal, setShowApptModal] = React.useState(false);
  const [showBlockedModal, setShowBlockedModal] = React.useState(false);
  const [showMeetingModal, setShowMeetingModal] = React.useState(false);
  const [showGroupModal, setShowGroupModal] = React.useState(false);
  const [showRoundRobinModal, setShowRoundRobinModal] = React.useState(false);
  const [me, setMe] = React.useState<MeResponse | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  // Lazy-load the current user once. Identity rarely changes during a
  // session, and the modal is gated on it.
  React.useEffect(() => {
    if (me) return;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as MeResponse;
          setMe(data);
        }
      } catch {
        /* swallow — menu still renders; appointment item just won't open */
      }
    })();
  }, [me]);

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

  // Hide entirely for client role — they don't get to create from
  // inside the dashboard. Server also rejects.
  if (me && me.role === "client") return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[12.5px] font-semibold text-white shadow-soft transition-all hover:bg-brand-accent/90",
          open && "ring-2 ring-brand-accent/40",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
        <span className="hidden sm:inline">Create</span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
          strokeWidth={2.25}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-72 origin-top-right overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        >
          <div className="px-3 py-2 border-b border-border">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Appointments
            </div>
          </div>
          <div className="py-1">
            {/* v1 — fully wired */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!me) return;
                setOpen(false);
                setShowApptModal(true);
              }}
              disabled={!me}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-inset disabled:opacity-50"
            >
              <CalendarPlus className="h-4 w-4 mt-0.5 text-brand-accent" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">One-on-One Appointment</div>
                <div className="text-[11px] text-ink-muted">
                  Manually book a customer with one staff member
                </div>
              </div>
            </button>

            {/* Phase 17I-2B — Blocked Time & Internal Meeting active */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!me) return;
                setOpen(false);
                setShowBlockedModal(true);
              }}
              disabled={!me}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-inset disabled:opacity-50"
            >
              <Ban className="h-4 w-4 mt-0.5 text-slate-600" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">Blocked Time</div>
                <div className="text-[11px] text-ink-muted">
                  Mark a slot unavailable (lunch, PTO, focus)
                </div>
              </div>
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!me) return;
                setOpen(false);
                setShowMeetingModal(true);
              }}
              disabled={!me}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-inset disabled:opacity-50"
            >
              <Building2 className="h-4 w-4 mt-0.5 text-indigo-600" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">Internal Meeting</div>
                <div className="text-[11px] text-ink-muted">
                  Multi-staff calendar event — Teams / Meet / Zoom
                </div>
              </div>
            </button>

            {/* Phase 17I-3A — Group Session active */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!me) return;
                setOpen(false);
                setShowGroupModal(true);
              }}
              disabled={!me}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-inset disabled:opacity-50"
            >
              <Users className="h-4 w-4 mt-0.5 text-emerald-600" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">Group Session</div>
                <div className="text-[11px] text-ink-muted">
                  Webinar / workshop / office hours — one host, many attendees
                </div>
              </div>
            </button>

            {/* Phase 17I-4A — Round Robin active */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (!me) return;
                setOpen(false);
                setShowRoundRobinModal(true);
              }}
              disabled={!me}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface-inset disabled:opacity-50"
            >
              <Shuffle className="h-4 w-4 mt-0.5 text-violet-600" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">Round Robin</div>
                <div className="text-[11px] text-ink-muted">
                  Auto-assign across eligible staff (uses your routing rule)
                </div>
              </div>
            </button>
          </div>
        </div>
      )}

      {me && (
        <>
          <NewAppointmentModal
            open={showApptModal}
            onClose={() => setShowApptModal(false)}
            onCreated={() => {
              // Refresh the current page so the new booking appears in
              // calendar/appointment lists immediately.
              if (typeof window !== "undefined") window.location.reload();
            }}
            viewerRole={me.role}
            viewerUserId={me.id}
          />
          <NewBlockedTimeModal
            open={showBlockedModal}
            onClose={() => setShowBlockedModal(false)}
            onCreated={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
            viewerRole={me.role}
            viewerUserId={me.id}
          />
          <NewInternalMeetingModal
            open={showMeetingModal}
            onClose={() => setShowMeetingModal(false)}
            onCreated={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
            viewerRole={me.role}
            viewerUserId={me.id}
          />
          <NewGroupSessionModal
            open={showGroupModal}
            onClose={() => setShowGroupModal(false)}
            onCreated={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
            viewerRole={me.role}
            viewerUserId={me.id}
          />
          <NewRoundRobinModal
            open={showRoundRobinModal}
            onClose={() => setShowRoundRobinModal(false)}
            onCreated={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
            viewerRole={me.role}
            viewerUserId={me.id}
          />
        </>
      )}
    </div>
  );
}

function ComingSoonRow({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex w-full items-start gap-2.5 px-3 py-2 cursor-not-allowed opacity-60">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-ink-muted">{title}</span>
          <span className="rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/50">
            Soon
          </span>
        </div>
        <div className="text-[11px] text-ink-subtle">{hint}</div>
      </div>
    </div>
  );
}

// ─── Profile dropdown ─────────────────────────────────────────────────

function ProfileMenu({ user }: { user: { name: string; email: string; role: string } }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Phase 17I-5 — lazy-load the signed-in user's avatar URL from
  // /api/auth/me. The Shell's user prop is server-rendered and
  // intentionally lean (name + email + role + permissions); plumbing
  // avatarUrl through 36 page.tsx callers would be invasive. One
  // client-side fetch on mount is the additive path. Initials remain
  // the fallback while the request resolves OR when no avatar has
  // been uploaded.
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { avatarUrl?: string | null };
        if (!cancelled && data.avatarUrl) setAvatarUrl(data.avatarUrl);
      } catch {
        /* swallow — initials fallback already in place */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        <Avatar name={user.name} src={avatarUrl} size="sm" />
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
              <Avatar name={user.name} src={avatarUrl} size="sm" />
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
