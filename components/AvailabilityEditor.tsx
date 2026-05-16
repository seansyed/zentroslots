"use client";

import { useState } from "react";

type Rule = { dayOfWeek: number; startTime: string; endTime: string };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function AvailabilityEditor({ initial }: { initial: Rule[] }) {
  // Map day → rule (one rule per day for MVP simplicity)
  const initMap = new Map<number, Rule>();
  for (const r of initial) initMap.set(r.dayOfWeek, r);

  const [rules, setRules] = useState<Map<number, Rule>>(initMap);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function toggleDay(day: number, on: boolean) {
    const next = new Map(rules);
    if (on) next.set(day, { dayOfWeek: day, startTime: "09:00", endTime: "17:00" });
    else next.delete(day);
    setRules(next);
  }

  function updateTime(day: number, field: "startTime" | "endTime", value: string) {
    const next = new Map(rules);
    const cur = next.get(day);
    if (!cur) return;
    next.set(day, { ...cur, [field]: value });
    setRules(next);
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const payload = {
        rules: Array.from(rules.values()).map((r) => ({
          dayOfWeek: r.dayOfWeek,
          startTime: `${r.startTime}:00`,
          endTime: `${r.endTime}:00`,
        })),
      };
      const res = await fetch("/api/availability", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      setStatus("Saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border bg-white p-6 shadow-sm">
      <div className="space-y-3">
        {DAY_LABELS.map((label, day) => {
          const rule = rules.get(day);
          const on = Boolean(rule);
          return (
            <div key={day} className="flex items-center gap-3">
              <label className="flex w-24 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggleDay(day, e.target.checked)}
                />
                {label}
              </label>
              {on && rule && (
                <>
                  <input
                    type="time"
                    value={rule.startTime}
                    onChange={(e) => updateTime(day, "startTime", e.target.value)}
                    className="rounded-md border px-2 py-1 text-sm"
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    type="time"
                    value={rule.endTime}
                    onChange={(e) => updateTime(day, "endTime", e.target.value)}
                    className="rounded-md border px-2 py-1 text-sm"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
        {status && <span className="text-sm text-slate-600">{status}</span>}
      </div>
    </div>
  );
}
