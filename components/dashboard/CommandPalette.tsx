"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Tooltip } from "@/components/ui/primitives";

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Create" | "Find" | "Schedule";
  perform: () => void;
};

type InlineMode = null | "customer" | "task";

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
  const [inline, setInline] = React.useState<InlineMode>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setInline(null);
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
      { id: "go-reports",      label: "Open reports",       group: "Navigate", perform: go("/dashboard/reports") },
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
      // Scheduling — power-user shortcuts into the scheduling workflow.
      // Routes already exist; this just makes them ⌘K-reachable.
      { id: "sched-today",         label: "Jump to today",          group: "Schedule", hint: "⌘ ↩",  perform: go("/dashboard/calendar") },
      { id: "sched-availability",  label: "Manage availability",    group: "Schedule",              perform: go("/dashboard/availability") },
      { id: "sched-focus",         label: "Block focus time",       group: "Schedule",              perform: go("/dashboard/availability/overrides") },
      { id: "sched-rules",         label: "Open booking rules",     group: "Schedule",              perform: go("/dashboard/settings/booking-rules") },
      { id: "sched-recurring",     label: "Open recurring bookings", group: "Schedule",             perform: go("/dashboard/settings/recurring") },
      { id: "sched-routing",       label: "Open staff routing",     group: "Schedule",              perform: go("/dashboard/settings/staff-routing") },
      { id: "sched-waitlists",     label: "Open waitlists",         group: "Schedule",              perform: go("/dashboard/settings/waitlists") },
      { id: "sched-integrations",  label: "Calendar integrations",  group: "Schedule",              perform: go("/dashboard/settings/integrations") },
      // Inline create — opens a tiny form right inside the palette
      // instead of bouncing to another page. Existing /api/customers
      // and /api/tasks POST endpoints back these.
      { id: "create-customer", label: "New customer",       hint: "inline",    group: "Create",   perform: () => setInline("customer") },
      { id: "create-task",     label: "New task",           hint: "inline",    group: "Create",   perform: () => setInline("task") },
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
        {inline === null ? (
          <>
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
          </>
        ) : (
          <InlineCreate
            mode={inline}
            onCancel={() => setInline(null)}
            onCreated={(redirectTo) => {
              if (redirectTo) router.push(redirectTo);
              onClose();
            }}
          />
        )}

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

// Inline create — single component, two shapes. Keeps the file from
// growing two near-identical components.
function InlineCreate({
  mode,
  onCancel,
  onCreated,
}: {
  mode: "customer" | "task";
  onCancel: () => void;
  onCreated: (redirectTo?: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Customer fields
  const [cName, setCName] = React.useState("");
  const [cEmail, setCEmail] = React.useState("");
  const [cPhone, setCPhone] = React.useState("");
  // Task fields
  const [tTitle, setTTitle] = React.useState("");
  const [tDesc, setTDesc] = React.useState("");
  const [tDue, setTDue] = React.useState("");
  const firstRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    firstRef.current?.focus();
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === "customer") {
        const res = await fetch("/api/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cName.trim(),
            email: cEmail.trim(),
            phone: cPhone.trim() || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        onCreated("/dashboard/customers");
      } else {
        const payload: Record<string, unknown> = {
          title: tTitle.trim(),
          description: tDesc.trim() || null,
        };
        if (tDue) payload.dueAt = new Date(tDue).toISOString();
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        onCreated("/dashboard/tasks");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3 p-4 text-sm" onSubmit={submit}>
      <div className="flex items-center justify-between border-b border-border pb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
          {mode === "customer" ? "New customer" : "New task"}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-ink-muted hover:text-ink"
        >
          ← back
        </button>
      </div>

      {mode === "customer" ? (
        <>
          <L label="Name">
            <input
              ref={firstRef}
              required
              maxLength={120}
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              className={INPUT_CLS}
            />
          </L>
          <L label="Email">
            <input
              type="email"
              required
              value={cEmail}
              onChange={(e) => setCEmail(e.target.value)}
              className={INPUT_CLS}
            />
          </L>
          <L label="Phone (optional)">
            <input
              maxLength={40}
              value={cPhone}
              onChange={(e) => setCPhone(e.target.value)}
              className={INPUT_CLS}
            />
          </L>
        </>
      ) : (
        <>
          <L label="Title">
            <input
              ref={firstRef}
              required
              maxLength={200}
              value={tTitle}
              onChange={(e) => setTTitle(e.target.value)}
              className={INPUT_CLS}
            />
          </L>
          <L label="Description (optional)">
            <textarea
              rows={3}
              maxLength={5000}
              value={tDesc}
              onChange={(e) => setTDesc(e.target.value)}
              className={INPUT_CLS}
            />
          </L>
          <L label="Due (optional)">
            <input
              type="datetime-local"
              value={tDue}
              onChange={(e) => setTDue(e.target.value)}
              className={INPUT_CLS}
            />
          </L>
        </>
      )}

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-white px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || (mode === "customer" ? !cName.trim() || !cEmail.trim() : !tTitle.trim())}
          className="rounded-md bg-brand-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Creating…" : mode === "customer" ? "Create customer" : "Create task"}
        </button>
      </div>
    </form>
  );
}

const INPUT_CLS = "w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand-accent";

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase text-ink-subtle">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
