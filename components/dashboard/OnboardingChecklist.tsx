"use client";

import * as React from "react";
import Link from "next/link";
import { Card, Badge } from "@/components/ui/primitives";

export type ChecklistItem = {
  id: string;
  label: string;
  href: string;
  done: boolean;
};

export default function OnboardingChecklist({ items }: { items: ChecklistItem[] }) {
  const [dismissed, setDismissed] = React.useState(false);
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Hide entirely once everything is checked off (one-shot persistence).
  React.useEffect(() => {
    if (done === total) {
      const key = "checklist_complete_dismissed";
      if (typeof window !== "undefined" && window.localStorage.getItem(key) === "1") {
        setDismissed(true);
      }
    }
  }, [done, total]);

  if (done === total) {
    if (dismissed) return null;
    return (
      <Card className="mb-6 bg-green-50 ring-1 ring-green-200">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-white">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-green-900">Setup complete</div>
              <p className="mt-0.5 text-xs text-green-800/80">Everything&rsquo;s wired up. Time to take bookings.</p>
            </div>
          </div>
          <button
            onClick={() => {
              if (typeof window !== "undefined") window.localStorage.setItem("checklist_complete_dismissed", "1");
              setDismissed(true);
            }}
            className="text-xs text-green-900/70 hover:text-green-900"
          >
            Dismiss
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-6">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-sm font-semibold text-ink">Get the most out of your workspace</div>
          <p className="mt-0.5 text-xs text-ink-muted">{done} of {total} steps complete · {pct}%</p>
        </div>
        <Badge tone="blue">{pct}%</Badge>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-inset">
        <div className="h-full bg-brand-accent transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-4 space-y-1">
        {items.map((it) => (
          <li key={it.id}>
            <Link
              href={it.href}
              className={
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition " +
                (it.done ? "text-ink-muted hover:bg-surface-inset" : "text-ink hover:bg-surface-inset")
              }
            >
              <span
                className={
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " +
                  (it.done ? "border-brand-accent bg-brand-accent text-white" : "border-border-strong")
                }
                aria-hidden
              >
                {it.done && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-2.5 w-2.5">
                    <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className={it.done ? "line-through decoration-ink-subtle" : ""}>{it.label}</span>
              {!it.done && (
                <span className="ml-auto text-[10px] text-brand-accent">Set up →</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
