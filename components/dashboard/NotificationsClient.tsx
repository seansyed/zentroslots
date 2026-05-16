"use client";

import * as React from "react";
import Link from "next/link";
import { EmptyState, Button, toast } from "@/components/ui/primitives";

type Notif = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

const TABS = ["all", "unread"] as const;
type Tab = (typeof TABS)[number];

export default function NotificationsClient({ initial }: { initial: Notif[] }) {
  const [rows, setRows] = React.useState(initial);
  const [tab, setTab] = React.useState<Tab>("all");

  const filtered = tab === "unread" ? rows.filter((r) => !r.readAt) : rows;
  const unreadCount = rows.filter((r) => !r.readAt).length;

  async function markAllRead() {
    setRows((cur) => cur.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    try {
      const res = await fetch("/api/notifications", { method: "PATCH" });
      if (!res.ok) throw new Error("Failed");
      toast("All marked read", "success");
    } catch {
      toast("Failed to mark read", "error");
    }
  }

  async function markOne(id: string) {
    setRows((cur) => cur.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
    try { await fetch(`/api/notifications/${id}`, { method: "PATCH" }); } catch { /* swallow */ }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {TABS.map((t) => {
            const active = tab === t;
            const count = t === "unread" ? unreadCount : rows.length;
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition capitalize " +
                  (active
                    ? "bg-brand-accent text-white"
                    : "border border-border bg-surface text-ink-muted hover:bg-surface-inset hover:text-ink")
                }
              >
                {t}
                <span className={"rounded px-1 text-[10px] " + (active ? "bg-white/20" : "bg-surface-inset text-ink-muted")}>{count}</span>
              </button>
            );
          })}
        </div>
        <Button variant="secondary" size="sm" disabled={unreadCount === 0} onClick={markAllRead}>
          Mark all read
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        {filtered.length === 0 ? (
          <EmptyState
            title={tab === "unread" ? "Nothing new" : "No notifications yet"}
            body="When something needs your attention, it'll appear here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((n) => {
              const inner = (
                <div className="flex gap-3 px-4 py-3">
                  <span
                    className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (n.readAt ? "bg-transparent" : "bg-brand-accent")}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className={"text-sm " + (n.readAt ? "text-ink-muted" : "text-ink font-medium")}>{n.title}</div>
                    {n.body && <div className="mt-0.5 text-xs text-ink-muted">{n.body}</div>}
                    <div className="mt-1 text-[10px] text-ink-subtle">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              );
              return (
                <li key={n.id}>
                  {n.link ? (
                    <Link href={n.link} onClick={() => markOne(n.id)} className="block hover:bg-surface-inset/60">{inner}</Link>
                  ) : (
                    <button onClick={() => markOne(n.id)} className="block w-full text-left hover:bg-surface-inset/60">{inner}</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
