"use client";

import * as React from "react";
import { Card, Button, EmptyState, toast } from "@/components/ui/primitives";

type Dept = { id: string; name: string; color: string | null; description: string | null };

const DEFAULT_COLORS = ["#2563eb", "#7c3aed", "#0d9488", "#ea580c", "#db2777", "#65a30d", "#0891b2", "#c026d3"];

export default function DepartmentsManager({
  initial,
  isAdmin,
}: {
  initial: Dept[];
  isAdmin: boolean;
}) {
  const [rows, setRows] = React.useState(initial);
  const [showForm, setShowForm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState(DEFAULT_COLORS[0]);
  const [description, setDescription] = React.useState("");

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color, description: description || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      setRows((cur) => [...cur, {
        id: data.id, name: data.name,
        color: data.color ?? null, description: data.description ?? null,
      }].sort((a, b) => a.name.localeCompare(b.name)));
      setShowForm(false);
      setName(""); setDescription(""); setColor(DEFAULT_COLORS[0]);
      toast("Department added", "success");
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
          <Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add department"}</Button>
        </div>
      )}

      {showForm && (
        <Card>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">Name</div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Consultation" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">Color</div>
              <div className="flex flex-wrap gap-1.5">
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    aria-label={`Color ${c}`}
                    className={"h-7 w-7 rounded-md border " + (color === c ? "ring-2 ring-offset-2 ring-brand-accent" : "border-border")}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-ink-muted">Description (optional)</div>
              <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button disabled={busy || !name.trim()} onClick={create}>{busy ? "Saving…" : "Save department"}</Button>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No departments yet" body="Create a department to group services and staff." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((d) => (
            <Card key={d.id}>
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: d.color ?? "#94a3b8" }}
                  aria-hidden
                />
                <div className="text-base font-medium text-ink">{d.name}</div>
              </div>
              {d.description && <p className="mt-2 text-sm text-ink-muted">{d.description}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
