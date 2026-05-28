"use client";

import * as React from "react";
import Link from "next/link";
import { Tooltip } from "@/components/ui/primitives";

type Notif = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

// Polling cadence. 20s is the sweet spot — fast enough that a "new
// booking just landed" badge appears within one breath, slow enough that
// idle tabs don't generate noise. Live signals below (focus, visibility,
// custom invalidate event, cross-tab storage event) bypass this cadence
// so the badge usually updates instantly anyway.
const POLL_INTERVAL_MS = 20_000;

/**
 * Cross-component invalidation hook — any component that mutates the
 * notification state (creates a booking, marks something read, etc.)
 * can call `invalidateNotificationCount()` to trigger every mounted bell
 * to refetch immediately. Decoupled from React Query so it works from
 * server-action callbacks and plain fetches alike.
 *
 *   import { invalidateNotificationCount } from "@/components/dashboard/NotificationBell";
 *   await fetch("/api/something-that-creates-a-notification", { method: "POST" });
 *   invalidateNotificationCount();
 */
const INVALIDATE_EVENT = "zentromeet:notifications:invalidate";

/** Broadcast invalidation to OTHER tabs in the same browser. localStorage
 *  writes fire `storage` events on every other tab; the writing tab does
 *  NOT receive its own storage event (this is intentional cross-tab
 *  signalling, not a self-signal). */
function broadcastCrossTabInvalidate() {
  try {
    localStorage.setItem(INVALIDATE_EVENT, String(Date.now()));
  } catch {
    // private mode / disk full / storage disabled — fine, just degrade.
  }
}

/**
 * Trigger every mounted bell to refetch its unread count immediately.
 * Call this from any component that just mutated something likely to
 * have produced a notification (booking created, customer messaged the
 * tenant, etc.). Covers both same-tab (custom event) and other tabs
 * (storage event).
 */
export function invalidateNotificationCount() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INVALIDATE_EVENT));
  broadcastCrossTabInvalidate();
}

export default function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(0);
  const [items, setItems] = React.useState<Notif[] | null>(null);

  // Guard against state updates after unmount + against overlapping
  // fetches racing each other's setState (focus + interval + custom
  // event can all fire within the same ms during a tab-return).
  const mountedRef = React.useRef(true);
  const inflightRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const pollUnread = React.useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const r = await fetch("/api/notifications/unread-count", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (!mountedRef.current) return;
      setUnread(typeof d.count === "number" ? d.count : 0);
    } catch {
      // best-effort — silent; we'll try again on the next tick.
    } finally {
      inflightRef.current = false;
    }
  }, []);

  // Initial fetch + periodic polling.
  React.useEffect(() => {
    pollUnread();
    const t = setInterval(pollUnread, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [pollUnread]);

  // Live signals — refetch immediately when:
  //   • the tab regains focus (operator returned from another window)
  //   • the page becomes visible (operator returned from another tab)
  //   • another component dispatches the invalidate event (mutation hook)
  //   • another tab in the same browser writes the storage signal
  //     (cross-tab sync — keeps both bells in step when an op is
  //     juggling two windows)
  // Each handler is dead-cheap; pollUnread itself is in-flight-guarded
  // so even if all four fire in the same tick, we only hit the API once.
  React.useEffect(() => {
    const onFocus = () => pollUnread();
    const onVisibility = () => {
      if (document.visibilityState === "visible") pollUnread();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === INVALIDATE_EVENT) pollUnread();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(INVALIDATE_EVENT, pollUnread);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(INVALIDATE_EVENT, pollUnread);
      window.removeEventListener("storage", onStorage);
    };
  }, [pollUnread]);

  // Load list when opening.
  React.useEffect(() => {
    if (!open) return;
    fetch("/api/notifications?limit=20", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]));
  }, [open]);

  async function markAllRead() {
    setUnread(0);
    setItems((cur) => cur?.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })) ?? null);
    try {
      await fetch("/api/notifications", { method: "PATCH" });
      // Sync other tabs' bells (this tab already has the optimistic 0).
      broadcastCrossTabInvalidate();
    } catch {
      // PATCH lost — recover the true count rather than leaving the
      // optimistic 0 lying around.
      pollUnread();
    }
  }

  async function markOne(id: string) {
    setItems((cur) =>
      cur?.map((i) => (i.id === id ? { ...i, readAt: i.readAt ?? new Date().toISOString() } : i)) ?? null
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      await fetch(`/api/notifications/${id}`, { method: "PATCH" });
      broadcastCrossTabInvalidate();
    } catch {
      pollUnread();
    }
  }

  return (
    <div className="relative">
      <Tooltip label={unread > 0 ? `${unread} unread` : "Notifications"}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Notifications"
          aria-expanded={open}
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.73 21a2 2 0 0 1-3.46 0" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </Tooltip>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-md"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="text-sm font-semibold text-ink">Notifications</div>
              <button
                onClick={markAllRead}
                disabled={unread === 0}
                className="text-xs text-ink-muted hover:text-ink disabled:opacity-50"
              >
                Mark all read
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {items === null ? (
                <div className="p-6 text-center text-xs text-ink-subtle">Loading…</div>
              ) : items.length === 0 ? (
                <div className="p-8 text-center text-xs text-ink-subtle">You&rsquo;re all caught up.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((n) => {
                    const inner = (
                      <div className="flex gap-2.5 px-3 py-3">
                        <span
                          className={
                            "mt-1.5 h-2 w-2 shrink-0 rounded-full " +
                            (n.readAt ? "bg-transparent" : "bg-brand-accent")
                          }
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-ink">{n.title}</div>
                          {n.body && <div className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{n.body}</div>}
                          <div className="mt-1 text-[10px] text-ink-subtle">
                            {new Date(n.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    );
                    return (
                      <li key={n.id}>
                        {n.link ? (
                          <Link href={n.link} onClick={() => { markOne(n.id); setOpen(false); }} className="block hover:bg-surface-inset/60">
                            {inner}
                          </Link>
                        ) : (
                          <button onClick={() => markOne(n.id)} className="block w-full text-left hover:bg-surface-inset/60">
                            {inner}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <Link
              href="/dashboard/notifications"
              onClick={() => setOpen(false)}
              className="block border-t border-border px-3 py-2 text-center text-xs text-brand-accent hover:bg-surface-inset"
            >
              View all
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
