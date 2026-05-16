"use client";

import * as React from "react";
import { Card, Button, EmptyState, toast } from "@/components/ui/primitives";

type Loc = {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
};

export default function LocationsManager({
  initial,
  isAdmin,
  defaultTimezone,
}: {
  initial: Loc[];
  isAdmin: boolean;
  defaultTimezone: string;
}) {
  const [rows, setRows] = React.useState(initial);
  const [showForm, setShowForm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const [name, setName] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [tz, setTz] = React.useState(defaultTimezone);
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          address: address || null,
          timezone: tz || null,
          phone: phone || null,
          email: email || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      setRows((cur) => [...cur, {
        id: data.id, name: data.name,
        address: data.address ?? null, timezone: data.timezone ?? null,
        phone: data.phone ?? null, email: data.email ?? null,
        isActive: data.isActive,
      }].sort((a, b) => a.name.localeCompare(b.name)));
      setShowForm(false);
      setName(""); setAddress(""); setPhone(""); setEmail("");
      toast("Location added", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add location"}</Button>
        </div>
      )}

      {showForm && (
        <Card>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Downtown clinic" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </Field>
            <Field label="Timezone">
              <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/Los_Angeles" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Suite 4" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </Field>
            <Field label="Phone">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </Field>
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button disabled={busy || !name.trim()} onClick={create}>{busy ? "Saving…" : "Save location"}</Button>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No locations yet" body="Add a location to associate it with services and staff." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((l) => (
            <Card key={l.id}>
              <div className="text-base font-medium text-ink">{l.name}</div>
              {l.address && <div className="mt-0.5 text-sm text-ink-muted">{l.address}</div>}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-ink-subtle">
                {l.timezone && <div><span className="text-ink-subtle">TZ:</span> <span className="text-ink-muted">{l.timezone}</span></div>}
                {l.phone && <div><span className="text-ink-subtle">Phone:</span> <span className="text-ink-muted">{l.phone}</span></div>}
                {l.email && <div className="col-span-2"><span className="text-ink-subtle">Email:</span> <a className="text-brand-accent hover:underline" href={`mailto:${l.email}`}>{l.email}</a></div>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1 text-xs font-medium text-ink-muted">{label}</div>
      {children}
    </div>
  );
}
