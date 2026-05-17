"use client";

import * as React from "react";
import { formatInTimeZone } from "date-fns-tz";

import { Avatar, Badge, Button, Card, Drawer, EmptyState, Skeleton, toast } from "@/components/ui/primitives";
import ActivityTimeline from "@/components/dashboard/ActivityTimeline";
import { STATUS_BADGE, STATUS_LABEL, type Status } from "@/lib/status-colors";

type Row = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  tags: string[];
  totalBookings: number;
  cancelled: number;
  completed: number;
  lastAppointmentAt: string | null;
};

type CustomerDetail = {
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    notes: string | null;
    status: string;
    tags: string[];
  };
  history: Array<{
    id: string;
    startAt: string;
    endAt: string;
    status: Status;
    serviceName: string;
    staffName: string;
  }>;
};

const TABS = ["overview", "appointments", "notes", "activity"] as const;
type Tab = (typeof TABS)[number];

export default function CustomersClient({ userTimezone, canManage }: { userTimezone: string; canManage: boolean }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [search, setSearch] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const url = new URL("/api/customers", window.location.origin);
    if (search) url.searchParams.set("q", search);
    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((data) => !cancelled && setRows(Array.isArray(data) ? data : []))
      .catch(() => !cancelled && setRows([]));
    return () => { cancelled = true; };
  }, [search]);

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            className="w-full rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm"
          />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-2.5 top-2.5 h-4 w-4 text-ink-subtle" aria-hidden>
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        {rows === null ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No customers yet" body="Customers are created automatically when someone books a service." />
        ) : (
          <table className="hidden w-full text-sm sm:table">
            <thead className="bg-surface-subtle text-left text-xs uppercase text-ink-subtle">
              <tr>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Bookings</th>
                <th className="px-4 py-2.5">Cancelled</th>
                <th className="px-4 py-2.5">Last appointment</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setOpenId(r.id)}
                  className="cursor-pointer border-t border-border align-top transition hover:bg-surface-inset/60"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} size="sm" />
                      <div>
                        <div className="text-ink">{r.name}</div>
                        <div className="text-xs text-ink-subtle">{r.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink">{r.totalBookings}</td>
                  <td className="px-4 py-3 text-ink-muted">{r.cancelled}</td>
                  <td className="px-4 py-3 text-xs text-ink-muted">
                    {r.lastAppointmentAt ? formatInTimeZone(r.lastAppointmentAt, userTimezone, "MMM d, yyyy") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1.5">
                      <Badge tone={r.status === "vip" ? "violet" : r.status === "archived" ? "neutral" : "green"} className="capitalize">{r.status}</Badge>
                      {Array.isArray(r.tags) && r.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-700">
                              {tag}
                            </span>
                          ))}
                          {r.tags.length > 3 && (
                            <span className="text-[10px] text-ink-subtle">+{r.tags.length - 3}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Mobile list */}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-border sm:hidden">
            {rows.map((r) => (
              <li key={r.id} onClick={() => setOpenId(r.id)} className="flex cursor-pointer items-center gap-3 p-4">
                <Avatar name={r.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink">{r.name}</div>
                  <div className="truncate text-xs text-ink-subtle">{r.email}</div>
                  <div className="mt-0.5 text-xs text-ink-muted">{r.totalBookings} bookings</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CustomerDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        userTimezone={userTimezone}
        canManage={canManage}
      />
    </div>
  );
}

function CustomerDrawer({
  id, onClose, userTimezone, canManage,
}: {
  id: string | null;
  onClose: () => void;
  userTimezone: string;
  canManage: boolean;
}) {
  const [data, setData] = React.useState<CustomerDetail | null>(null);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [savingNotes, setSavingNotes] = React.useState(false);
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (!id) { setData(null); return; }
    setData(null);
    setTab("overview");
    fetch(`/api/customers/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setNotes(d?.customer?.notes ?? "");
      })
      .catch(() => toast("Failed to load customer", "error"));
  }, [id]);

  async function saveNotes() {
    if (!id) return;
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast("Notes saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingNotes(false);
    }
  }

  const open = Boolean(id);

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="Customer">
      {!data ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-6 h-20 w-full" />
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-border p-5">
            <div className="flex items-center gap-3">
              <Avatar name={data.customer.name} size="lg" />
              <div>
                <h2 className="text-lg font-semibold text-ink">{data.customer.name}</h2>
                <a className="text-sm text-brand-accent hover:underline" href={`mailto:${data.customer.email}`}>
                  {data.customer.email}
                </a>
                {data.customer.phone && <div className="mt-0.5 text-xs text-ink-muted">{data.customer.phone}</div>}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink"
            >×</button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border px-3">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "border-b-2 px-3 py-2 text-sm capitalize transition " +
                  (t === tab ? "border-brand-accent font-medium text-brand-accent" : "border-transparent text-ink-muted hover:text-ink")
                }
              >
                {t}
              </button>
            ))}
          </div>

          {/* Tab body */}
          <div className="flex-1 overflow-y-auto p-5">
            {tab === "overview" && (
              <div>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Total bookings" value={String(data.history.length)} />
                  <Stat label="Completed" value={String(data.history.filter((h) => h.status === "completed").length)} />
                  <Stat label="Cancelled" value={String(data.history.filter((h) => h.status === "cancelled").length)} />
                  <Stat label="No-shows" value={String(data.history.filter((h) => h.status === "no_show").length)} />
                </div>
                <div className="mt-6">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Tags</div>
                  <TagEditor
                    customerId={data.customer.id}
                    initial={Array.isArray(data.customer.tags) ? data.customer.tags : []}
                    canManage={canManage}
                  />
                </div>
              </div>
            )}

            {tab === "appointments" && (
              <ul className="divide-y divide-border">
                {data.history.length === 0 && (
                  <li className="py-6 text-center text-sm text-ink-subtle">No appointments yet.</li>
                )}
                {data.history.map((h) => (
                  <li key={h.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">{h.serviceName}</div>
                      <div className="text-xs text-ink-muted">with {h.staffName}</div>
                      <div className="mt-1 text-xs text-ink-subtle">
                        {formatInTimeZone(h.startAt, userTimezone, "MMM d, yyyy · h:mm a")}
                      </div>
                    </div>
                    <Badge className={STATUS_BADGE[h.status]}>{STATUS_LABEL[h.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}

            {tab === "notes" && (
              <div>
                <textarea
                  rows={8}
                  value={notes}
                  disabled={!canManage}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Internal notes — visible to your team only."
                  className="w-full rounded-md border border-border bg-surface p-3 text-sm disabled:bg-surface-inset"
                />
                {canManage && (
                  <div className="mt-3 flex justify-end">
                    <Button onClick={saveNotes} disabled={savingNotes}>
                      {savingNotes ? "Saving…" : "Save notes"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {tab === "activity" && (
              <ActivityTimeline limit={50} />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
    </Card>
  );
}

function TagEditor({
  customerId,
  initial,
  canManage,
}: {
  customerId: string;
  initial: string[];
  canManage: boolean;
}) {
  const [tags, setTags] = React.useState<string[]>(initial);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function persist(next: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/customers/${customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      // Trust the server's normalization (lowercase + dedup).
      if (Array.isArray(d.tags)) setTags(d.tags as string[]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to save tags", "error");
      // Roll back on failure.
      setTags(initial);
    } finally {
      setSaving(false);
    }
  }

  function addTag() {
    const t = draft.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setDraft("");
      return;
    }
    const next = [...tags, t];
    setTags(next);
    setDraft("");
    persist(next);
  }

  function removeTag(t: string) {
    const next = tags.filter((x) => x !== t);
    setTags(next);
    persist(next);
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 && (
          <span className="text-xs text-ink-subtle">No tags yet.</span>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
          >
            {t}
            {canManage && (
              <button
                onClick={() => removeTag(t)}
                aria-label={`Remove tag ${t}`}
                disabled={saving}
                className="text-slate-500 hover:text-red-600 disabled:opacity-50"
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {canManage && (
        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder="Add a tag (e.g. vip, new, repeat)…"
            className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
            maxLength={40}
          />
          <Button onClick={addTag} disabled={saving || !draft.trim()}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
