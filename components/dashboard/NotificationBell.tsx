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

const POLL_INTERVAL_MS = 30_000;

export default function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(0);
  const [items, setItems] = React.useState<Notif[] | null>(null);

  const pollUnread = React.useCallback(async () => {
    try {
      const r = await fetch("/api/notifications/unread-count", { cache: "no-store" });
      const d = await r.json();
      setUnread(typeof d.count === "number" ? d.count : 0);
    } catch {
      // best-effort
    }
  }, []);

  // Initial + interval polling.
  React.useEffect(() => {
    pollUnread();
    const t = setInterval(pollUnread, POLL_INTERVAL_MS);
    return () => clearInterval(t);
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
    } catch {
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
