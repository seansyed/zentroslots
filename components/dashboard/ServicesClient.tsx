"use client";

import * as React from "react";
import { AvatarGroup, Badge, Button, Card, Drawer, EmptyState, Skeleton, toast } from "@/components/ui/primitives";
import { serviceColor } from "@/lib/status-colors";

type Svc = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  price: number;
  bufferBefore: number;
  bufferAfter: number;
  color: string | null;
  isActive: number;
  videoProvider?: string | null;
  staff: { userId: string; name: string }[];
};

const DEFAULT_COLORS = ["#2563eb", "#7c3aed", "#0d9488", "#ea580c", "#db2777", "#65a30d", "#0891b2", "#c026d3"];

const PROVIDERS = [
  { id: "google_meet", label: "Google Meet",     note: "Auto-creates a Meet link" },
  { id: "zoom",        label: "Zoom",            note: "Manual link · OAuth in a future release" },
  { id: "teams",       label: "Microsoft Teams", note: "Manual link · OAuth in a future release" },
  { id: "none",        label: "No video",        note: "In-person or phone" },
] as const;

export default function ServicesClient({
  isAdmin,
  allStaff,
}: {
  isAdmin: boolean;
  allStaff: { id: string; name: string }[];
}) {
  const [rows, setRows] = React.useState<Svc[] | null>(null);
  const [openId, setOpenId] = React.useState<string | "new" | null>(null);

  async function reload() {
    const data = await fetch("/api/services").then((r) => r.json());
    setRows(Array.isArray(data) ? data : []);
  }
  React.useEffect(() => { reload(); }, []);

  return (
    <div className="mt-6 space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => setOpenId("new")}>Add service</Button>
        </div>
      )}

      {rows === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No services yet"
          body="Create a service to start accepting bookings."
          action={isAdmin ? <Button onClick={() => setOpenId("new")}>Add service</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((s) => (
            <button
              key={s.id}
              onClick={() => setOpenId(s.id)}
              className="text-left"
            >
              <Card className="cursor-pointer transition hover:shadow-md">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: serviceColor(s.id, s.color) }}
                    aria-hidden
                  />
                  <div className="text-base font-medium text-ink">{s.name}</div>
                  {s.isActive === 0 && <Badge tone="neutral">Inactive</Badge>}
                </div>
                {s.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{s.description}</p>
                )}
                <div className="mt-3 flex items-center justify-between text-xs text-ink-subtle">
                  <span>{s.durationMinutes} min{s.price > 0 && ` · $${(s.price / 100).toFixed(0)}`}</span>
                  <AvatarGroup
                    members={s.staff.map((u) => ({ name: u.name }))}
                    max={3}
                  />
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}

      <ServiceDrawer
        openId={openId}
        onClose={() => setOpenId(null)}
        onSaved={() => { setOpenId(null); reload(); }}
        allStaff={allStaff}
        isAdmin={isAdmin}
        existing={rows ?? []}
      />
    </div>
  );
}

function ServiceDrawer({
  openId, onClose, onSaved, allStaff, isAdmin, existing,
}: {
  openId: string | "new" | null;
  onClose: () => void;
  onSaved: () => void;
  allStaff: { id: string; name: string }[];
  isAdmin: boolean;
  existing: Svc[];
}) {
  const isNew = openId === "new";
  const svc = openId && openId !== "new" ? existing.find((s) => s.id === openId) : null;

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [durationMinutes, setDurationMinutes] = React.useState(30);
  const [price, setPrice] = React.useState(0);
  const [bufferBefore, setBufferBefore] = React.useState(0);
  const [bufferAfter, setBufferAfter] = React.useState(0);
  const [color, setColor] = React.useState<string>(DEFAULT_COLORS[0]);
  const [isActive, setIsActive] = React.useState(true);
  const [videoProvider, setVideoProvider] = React.useState<string>("google_meet");
  const [selectedStaff, setSelectedStaff] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (svc) {
      setName(svc.name); setDescription(svc.description ?? "");
      setDurationMinutes(svc.durationMinutes); setPrice(svc.price);
      setBufferBefore(svc.bufferBefore); setBufferAfter(svc.bufferAfter);
      setColor(svc.color ?? DEFAULT_COLORS[0]);
      setIsActive(svc.isActive === 1);
      setVideoProvider(svc.videoProvider ?? "google_meet");
      setSelectedStaff(new Set(svc.staff.map((s) => s.userId)));
    } else if (isNew) {
      setName(""); setDescription(""); setDurationMinutes(30);
      setPrice(0); setBufferBefore(0); setBufferAfter(0);
      setColor(DEFAULT_COLORS[0]); setIsActive(true);
      setVideoProvider("google_meet");
      setSelectedStaff(new Set());
    }
  }, [openId, svc, isNew]);

  function toggleStaff(id: string) {
    setSelectedStaff((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) { toast("Name is required", "error"); return; }
    setBusy(true);
    try {
      const payload = {
        name, description: description || null,
        durationMinutes, price, bufferBefore, bufferAfter, color,
        isActive,
        videoProvider,
        staffUserIds: Array.from(selectedStaff),
      };
      const url = isNew ? "/api/services" : `/api/services/${svc!.id}`;
      const method = isNew ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast(isNew ? "Service created" : "Service updated", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!svc) return;
    if (!window.confirm("Delete this service? Past bookings keep it; future visibility ends.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${svc.id}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast(d.deleted ? "Service deleted" : "Service archived", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  const open = Boolean(openId);

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="Service editor">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 className="text-lg font-semibold text-ink">{isNew ? "New service" : svc?.name ?? ""}</h2>
            <p className="mt-0.5 text-xs text-ink-muted">{isNew ? "Set basics, then assign staff." : "Edit details and assignments."}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink">×</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          <Field label="Name">
            <input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
          </Field>
          <Field label="Description">
            <textarea rows={3} value={description} disabled={!isAdmin} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration (min)">
              <input type="number" min={5} step={5} value={durationMinutes} disabled={!isAdmin} onChange={(e) => setDurationMinutes(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
            <Field label="Price (cents)">
              <input type="number" min={0} step={50} value={price} disabled={!isAdmin} onChange={(e) => setPrice(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
            <Field label="Buffer before">
              <input type="number" min={0} max={240} value={bufferBefore} disabled={!isAdmin} onChange={(e) => setBufferBefore(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
            <Field label="Buffer after">
              <input type="number" min={0} max={240} value={bufferAfter} disabled={!isAdmin} onChange={(e) => setBufferAfter(Number(e.target.value))} className="w-full rounded-md border border-border bg-surface px-3 py-2 disabled:bg-surface-inset" />
            </Field>
          </div>

          <Field label="Color">
            <div className="flex flex-wrap gap-1.5">
              {DEFAULT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => isAdmin && setColor(c)}
                  disabled={!isAdmin}
                  aria-label={`Color ${c}`}
                  className={"h-7 w-7 rounded-md border " + (color === c ? "ring-2 ring-offset-2 ring-brand-accent" : "border-border")}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </Field>

          <Field label="Video provider">
            <div className="space-y-1.5">
              {PROVIDERS.map((p) => {
                const on = videoProvider === p.id;
                return (
                  <label key={p.id} className={"flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm " + (on ? "ring-1 ring-brand-accent/30" : "")}>
                    <input
                      type="radio"
                      name="videoProvider"
                      value={p.id}
                      checked={on}
                      disabled={!isAdmin}
                      onChange={() => setVideoProvider(p.id)}
                      className="mt-0.5 h-4 w-4 accent-brand-accent"
                    />
                    <span className="flex-1">
                      <span className="block text-ink">{p.label}</span>
                      <span className="block text-[11px] text-ink-subtle">{p.note}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>

          <Field label="Status">
            <label className="inline-flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={isActive} disabled={!isAdmin} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 accent-brand-accent" />
              Active and bookable
            </label>
          </Field>

          <Field label="Staff who deliver this service">
            <div className="space-y-1.5">
              {allStaff.length === 0 && (
                <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-ink-subtle">
                  No staff in workspace yet.
                </div>
              )}
              {allStaff.map((u) => {
                const on = selectedStaff.has(u.id);
                return (
                  <label key={u.id} className={"flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm " + (on ? "ring-1 ring-brand-accent/30" : "")}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!isAdmin}
                      onChange={() => toggleStaff(u.id)}
                      className="h-4 w-4 accent-brand-accent"
                    />
                    <span className="flex-1 text-ink">{u.name}</span>
                  </label>
                );
              })}
            </div>
          </Field>
        </div>

        {isAdmin && (
          <div className="flex items-center justify-between border-t border-border p-4">
            {!isNew ? (
              <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                {busy ? "…" : "Delete"}
              </Button>
            ) : <span />}
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create service" : "Save changes"}
            </Button>
          </div>
        )}
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
