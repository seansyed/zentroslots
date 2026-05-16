"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Tooltip } from "@/components/ui/primitives";

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Create" | "Find";
  perform: () => void;
};

export function useCommandPalette() {
  const [isOpen, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}

export function CommandPaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip label="Search & commands (⌘K)">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open command palette"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-xs text-ink-muted hover:text-ink"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-border bg-surface-subtle px-1 py-0.5 font-mono text-[10px] sm:inline">⌘K</kbd>
      </button>
    </Tooltip>
  );
}

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus on next tick after the DOM mounts.
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const commands: Cmd[] = React.useMemo(() => {
    const go = (path: string) => () => { router.push(path); onClose(); };
    return [
      { id: "go-dashboard",    label: "Go to dashboard",    group: "Navigate", perform: go("/dashboard") },
      { id: "go-calendar",     label: "Open calendar",      group: "Navigate", perform: go("/dashboard/calendar") },
      { id: "go-appointments", label: "Open appointments",  group: "Navigate", perform: go("/dashboard/appointments") },
      { id: "go-customers",    label: "Find customers",     group: "Find",     perform: go("/dashboard/customers") },
      { id: "go-staff",        label: "Find staff",         group: "Find",     perform: go("/dashboard/staff") },
      { id: "go-services",     label: "Find services",      group: "Find",     perform: go("/dashboard/services") },
      { id: "go-locations",    label: "Find locations",     group: "Find",     perform: go("/dashboard/locations") },
      { id: "go-departments",  label: "Find departments",   group: "Find",     perform: go("/dashboard/departments") },
      { id: "go-notifications",label: "Open notifications", group: "Navigate", perform: go("/dashboard/notifications") },
      { id: "go-tasks",        label: "Open tasks",         group: "Navigate", perform: go("/dashboard/tasks") },
      { id: "go-billing",      label: "Open billing",       group: "Navigate", perform: go("/dashboard/billing") },
      { id: "go-emails",       label: "Email log",          group: "Navigate", perform: go("/dashboard/emails") },
      { id: "go-analytics",    label: "Open analytics",     group: "Navigate", perform: go("/dashboard/analytics") },
      { id: "create-task",     label: "Create a task",      group: "Create",   perform: go("/dashboard/tasks?new=1") },
      { id: "create-service",  label: "Create a service",   group: "Create",   perform: go("/dashboard/services?new=1") },
      { id: "create-location", label: "Add a location",     group: "Create",   perform: go("/dashboard/locations") },
      { id: "create-dept",     label: "Add a department",   group: "Create",   perform: go("/dashboard/departments") },
    ];
  }, [router, onClose]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  React.useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered, active]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[active]?.perform();
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  if (!open) return null;

  // Group items.
  const groups: Record<string, Cmd[]> = {};
  for (const c of filtered) {
    (groups[c.group] = groups[c.group] ?? []).push(c);
  }

  let flatIndex = 0;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-ink-subtle" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search commands…"
            className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
          />
          <kbd className="rounded border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle">esc</kbd>
        </div>

        <div className="max-h-96 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-xs text-ink-subtle">No matches.</div>
          ) : (
            Object.entries(groups).map(([groupName, items]) => (
              <div key={groupName}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{groupName}</div>
                {items.map((c) => {
                  const idx = flatIndex++;
                  const isActive = idx === active;
                  return (
                    <button
                      key={c.id}
                      onMouseEnter={() => setActive(idx)}
                      onClick={c.perform}
                      className={
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition " +
                        (isActive ? "bg-brand-subtle text-brand-accent" : "text-ink hover:bg-surface-inset")
                      }
                    >
                      <span>{c.label}</span>
                      {c.hint && <span className="text-xs text-ink-subtle">{c.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border bg-surface-subtle px-3 py-1.5 text-[10px] text-ink-subtle">
          <kbd className="rounded border border-border bg-surface px-1 font-mono">↑↓</kbd> navigate
          {" · "}
          <kbd className="rounded border border-border bg-surface px-1 font-mono">↵</kbd> select
          {" · "}
          <kbd className="rounded border border-border bg-surface px-1 font-mono">esc</kbd> close
        </div>
      </div>
    </div>
  );
}
