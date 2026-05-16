"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Avatar, Badge, Button, Card, EmptyState, Drawer, Skeleton, toast } from "@/components/ui/primitives";

type Task = {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "done";
  dueAt: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  relatedCustomerId: string | null;
  customerName: string | null;
  relatedBookingId: string | null;
  createdAt: string;
  completedAt: string | null;
};

const FILTERS = ["all", "open", "done", "mine"] as const;
type Filter = (typeof FILTERS)[number];

export default function TasksClient({
  allStaff,
  allCustomers,
  myUserId,
}: {
  allStaff: { id: string; name: string }[];
  allCustomers: { id: string; name: string }[];
  myUserId: string;
}) {
  const sp = useSearchParams();
  const [filter, setFilter] = React.useState<Filter>("open");
  const [rows, setRows] = React.useState<Task[] | null>(null);
  const [openNew, setOpenNew] = React.useState(sp.get("new") === "1");

  const reload = React.useCallback(async () => {
    const url = new URL("/api/tasks", window.location.origin);
    if (filter === "open" || filter === "done") url.searchParams.set("status", filter);
    if (filter === "mine") url.searchParams.set("mine", "1");
    try {
      const r = await fetch(url, { cache: "no-store" });
      const d = await r.json();
      setRows(Array.isArray(d) ? (d as Task[]) : []);
    } catch {
      setRows([]);
    }
  }, [filter]);
  React.useEffect(() => { reload(); }, [reload]);

  async function toggleStatus(t: Task) {
    const next: Task["status"] = t.status === "open" ? "done" : "open";
    setRows((cur) => cur?.map((x) => (x.id === t.id ? { ...x, status: next } : x)) ?? null);
    try {
      const r = await fetch(`/api/tasks/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!r.ok) throw new Error("Failed");
      toast(next === "done" ? "Task completed" : "Task reopened", "success");
    } catch {
      toast("Failed to update task", "error");
      reload();
    }
  }

  async function removeTask(t: Task) {
    if (!window.confirm("Delete this task?")) return;
    setRows((cur) => cur?.filter((x) => x.id !== t.id) ?? null);
    try {
      const r = await fetch(`/api/tasks/${t.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Failed");
      toast("Task deleted", "success");
    } catch {
      toast("Failed to delete task", "error");
      reload();
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={
                  "rounded-md px-3 py-1 text-xs font-medium transition capitalize " +
                  (active ? "bg-brand-accent text-white" : "border border-border bg-surface text-ink-muted hover:bg-surface-inset hover:text-ink")
                }
              >
                {f}
              </button>
            );
          })}
        </div>
        <Button onClick={() => setOpenNew(true)}>Add task</Button>
      </div>

      {rows === null ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No tasks here"
          body="Create a task to track a follow-up, confirm a booking, or chase a payment."
          action={<Button onClick={() => setOpenNew(true)}>Add task</Button>}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => (
            <li key={t.id}>
              <Card className={"flex items-start gap-3 " + (t.status === "done" ? "opacity-60" : "")}>
                <input
                  type="checkbox"
                  checked={t.status === "done"}
                  onChange={() => toggleStatus(t)}
                  className="mt-1 h-4 w-4 accent-brand-accent"
                  aria-label="Mark complete"
                />
                <div className="min-w-0 flex-1">
                  <div className={"text-sm " + (t.status === "done" ? "text-ink-muted line-through" : "text-ink font-medium")}>
                    {t.title}
                  </div>
                  {t.description && <div className="mt-0.5 text-xs text-ink-muted">{t.description}</div>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                    {t.assignedName && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-ink-muted">
                        <Avatar name={t.assignedName} size="sm" className="!h-4 !w-4 text-[8px]" />
                        {t.assignedName}
                      </span>
                    )}
                    {t.customerName && <Badge tone="violet">{t.customerName}</Badge>}
                    {t.dueAt && (
                      <Badge tone={new Date(t.dueAt) < new Date() && t.status === "open" ? "red" : "neutral"}>
                        Due {new Date(t.dueAt).toLocaleDateString()}
                      </Badge>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => removeTask(t)}
                  aria-label="Delete"
                  className="rounded p-1 text-ink-subtle hover:bg-surface-inset hover:text-red-600"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <NewTaskDrawer
        open={openNew}
        onClose={() => setOpenNew(false)}
        allStaff={allStaff}
        allCustomers={allCustomers}
        defaultAssigneeId={myUserId}
        onCreated={() => { setOpenNew(false); reload(); }}
      />
    </div>
  );
}

function NewTaskDrawer({
  open, onClose, allStaff, allCustomers, defaultAssigneeId, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  allStaff: { id: string; name: string }[];
  allCustomers: { id: string; name: string }[];
  defaultAssigneeId: string;
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [assignedUserId, setAssignedUserId] = React.useState(defaultAssigneeId);
  const [relatedCustomerId, setRelatedCustomerId] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTitle(""); setDescription(""); setDueAt("");
      setAssignedUserId(defaultAssigneeId);
      setRelatedCustomerId("");
    }
  }, [open, defaultAssigneeId]);

  async function save() {
    if (!title.trim()) { toast("Title is required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || null,
          dueAt: dueAt ? new Date(dueAt + "T00:00:00").toISOString() : null,
          assignedUserId: assignedUserId || null,
          relatedCustomerId: relatedCustomerId || null,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? "Failed");
      }
      toast("Task created", "success");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="New task">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <h2 className="text-lg font-semibold text-ink">New task</h2>
          <button onClick={onClose} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink">×</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5 text-sm">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2" />
          </Field>
          <Field label="Description (optional)">
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2" />
          </Field>
          <Field label="Due date (optional)">
            <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2" />
          </Field>
          <Field label="Assign to">
            <select value={assignedUserId} onChange={(e) => setAssignedUserId(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2">
              {allStaff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="Related customer (optional)">
            <select value={relatedCustomerId} onChange={(e) => setRelatedCustomerId(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2">
              <option value="">— None —</option>
              {allCustomers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="flex justify-end border-t border-border p-4">
          <Button onClick={save} disabled={busy || !title.trim()}>{busy ? "Saving…" : "Create task"}</Button>
        </div>
      </div>
    </Drawer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink-muted">{label}</div>
      {children}
    </div>
  );
}
