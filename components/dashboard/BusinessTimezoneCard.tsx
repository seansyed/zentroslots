"use client";

/**
 * BusinessTimezoneCard — set the workspace's canonical BUSINESS timezone.
 *
 * This is the single source of truth used to interpret operator-entered
 * booking times AND display booking times across web + mobile. It is a CORE
 * scheduling setting (available on every plan), so it lives here as its own
 * always-enabled card rather than inside the plan-gated branding form.
 *
 * Saves via PATCH /api/tenant { timezone }. The server validates the IANA
 * zone and drops its cache so the change takes effect immediately.
 */

import { useMemo, useState } from "react";

import { friendlyMessage, friendlyThrown } from "@/lib/clientErrors";

function allTimezones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    const list = fn ? fn("timeZone") : undefined;
    if (list && list.length) return list;
  } catch {
    /* fall through to the curated list */
  }
  return [
    "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "UTC",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Kolkata",
    "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
  ];
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function BusinessTimezoneCard({ initialTimezone }: { initialTimezone: string }) {
  const [tz, setTz] = useState(initialTimezone || "UTC");
  const [savedTz, setSavedTz] = useState(initialTimezone || "UTC");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const browserTz = useMemo(browserTimezone, []);
  const zones = useMemo(() => {
    const list = allTimezones();
    return list.includes(tz) ? list : [tz, ...list];
  }, [tz]);

  const dirty = tz !== savedTz;

  async function save() {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(friendlyMessage(res.status, data, {
          genericMessage: "We couldn't update the business timezone. Please try again.",
        }));
        return;
      }
      setSavedTz(tz);
      setOk(true);
    } catch {
      setError(friendlyThrown().message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Business timezone</h3>
          <p className="mt-1 max-w-prose text-sm text-slate-500">
            The timezone your business operates in. Appointment times you enter are
            interpreted in this zone, and bookings display in it across the web and mobile
            apps. Stored times are always UTC under the hood.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
            Timezone
          </span>
          <select
            value={tz}
            onChange={(e) => {
              setTz(e.target.value);
              setOk(false);
              setError(null);
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="h-[38px] rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {browserTz && browserTz !== tz ? (
        <button
          type="button"
          onClick={() => {
            setTz(browserTz);
            setOk(false);
            setError(null);
          }}
          className="mt-2 text-xs font-medium text-slate-500 underline-offset-2 hover:underline"
        >
          Use this device&rsquo;s timezone ({browserTz.replace(/_/g, " ")})
        </button>
      ) : null}

      {ok ? (
        <p className="mt-3 text-xs font-medium text-emerald-600">
          Saved. Bookings now display in {savedTz.replace(/_/g, " ")}.
        </p>
      ) : null}
      {error ? <p className="mt-3 text-xs font-medium text-red-600">{error}</p> : null}
    </div>
  );
}
