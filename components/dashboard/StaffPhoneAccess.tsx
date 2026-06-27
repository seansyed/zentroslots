"use client";

/**
 * Staff Phone Access (P1.2.2) — operator-only admin section inside the Phone
 * module. Lists the tenant's STAFF users with their Business Phone access state
 * and lets an admin/manager grant/revoke access, allow/disallow placing calls,
 * and set/clear a staff member's bridge number.
 *
 * Privacy: staff bridge numbers are shown MASKED only — the full personal number
 * is never returned by the API and never rendered here. All writes go through the
 * entitlement-gated /api/tenant/phone/users route (server is the source of
 * truth; it returns 402/403 if called without permission).
 */

import * as React from "react";
import { Users, Loader2, Pencil, X, Check, ShieldCheck } from "lucide-react";

import { Card, CardHeader, Button, Badge, Skeleton, toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import {
  staffPhoneNumberLabel,
  staffAccessStatusLabel,
  STAFF_PHONE_PRIVACY_NOTE,
} from "@/lib/business-phone-ui";

type StaffRow = {
  userId: string;
  name: string;
  email: string;
  role: string;
  enabled: boolean;
  canPlaceCalls: boolean;
  canReceiveCalls: boolean;
  bridgePhoneNumberConfigured: boolean;
  bridgePhoneNumberMasked: string | null;
  updatedAt: string | null;
};

export default function StaffPhoneAccess() {
  const [rows, setRows] = React.useState<StaffRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/tenant/phone/users", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as { users: StaffRow[] };
      setRows(data.users);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function patch(userId: string, body: Record<string, unknown>) {
    setBusyId(userId);
    try {
      const res = await fetch("/api/tenant/phone/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, ...body }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d?.error ?? "Couldn't update access.");
      toast("Staff access updated.", "success");
      await load(); // refresh masked number + Last updated
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(row: StaffRow) {
    setEditingId(row.userId);
    setEditValue(""); // never prefill — the full number is never known to the client
  }
  async function saveNumber(userId: string) {
    await patch(userId, { bridgePhoneNumber: editValue.trim() });
    setEditingId(null);
    setEditValue("");
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardHeader title="Staff phone access" subtitle="Control which staff can use Business Phone." />
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
          <Users className="h-5 w-5" strokeWidth={1.75} />
        </span>
      </div>

      <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-border bg-surface-inset/40 p-3 text-xs text-ink-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
        <p>{STAFF_PHONE_PRIVACY_NOTE}</p>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <div className="mt-4 rounded-lg border border-border p-4 text-sm text-ink-muted">
          Couldn&apos;t load staff access.{" "}
          <button type="button" onClick={() => void load()} className="font-medium text-brand-accent hover:underline">
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-ink-muted">
          No staff users yet. Invite staff, then grant them Business Phone access here.
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-inset/50 text-left text-[11px] uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="px-3 py-2 font-semibold">Staff</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Access</th>
                <th className="px-3 py-2 font-semibold">Can place calls</th>
                <th className="px-3 py-2 font-semibold">Calling number</th>
                <th className="px-3 py-2 text-right font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const busy = busyId === r.userId;
                const status = staffAccessStatusLabel({ enabled: r.enabled, canPlaceCalls: r.canPlaceCalls });
                return (
                  <tr key={r.userId} className={cn(busy && "opacity-60")}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{r.name}</div>
                      <div className="text-xs text-ink-muted">{r.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={r.enabled ? (r.canPlaceCalls ? "green" : "amber") : "neutral"}>{status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Switch
                        checked={r.enabled}
                        disabled={busy}
                        onChange={() => void patch(r.userId, { enabled: !r.enabled })}
                        label="Phone access"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Switch
                        checked={r.canPlaceCalls}
                        disabled={busy}
                        onChange={() => void patch(r.userId, { canPlaceCalls: !r.canPlaceCalls })}
                        label="Can place calls"
                      />
                    </td>
                    <td className="px-3 py-2">
                      {editingId === r.userId ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="tel"
                            inputMode="tel"
                            placeholder="+1 (555) 123-4567"
                            value={editValue}
                            disabled={busy}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="h-8 w-40 rounded-lg border border-border bg-surface px-2 text-sm text-ink outline-none focus:border-brand-accent"
                          />
                          <button
                            type="button"
                            onClick={() => void saveNumber(r.userId)}
                            disabled={busy || editValue.trim() === ""}
                            aria-label="Save number"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                          >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null);
                              setEditValue("");
                            }}
                            aria-label="Cancel"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle hover:bg-surface-inset"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className={cn("text-ink", !r.bridgePhoneNumberConfigured && "text-ink-muted")}>
                            {staffPhoneNumberLabel({
                              configured: r.bridgePhoneNumberConfigured,
                              masked: r.bridgePhoneNumberMasked,
                            })}
                          </span>
                          <button
                            type="button"
                            onClick={() => startEdit(r)}
                            disabled={busy}
                            aria-label="Edit number"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-inset hover:text-ink disabled:opacity-40"
                          >
                            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </button>
                          {r.bridgePhoneNumberConfigured && (
                            <button
                              type="button"
                              onClick={() => void patch(r.userId, { bridgePhoneNumber: null })}
                              disabled={busy}
                              className="text-xs font-medium text-ink-subtle transition-colors hover:text-red-600 disabled:opacity-40"
                            >
                              Clear
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-ink-muted">{formatTime(r.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-brand-accent" : "bg-surface-inset",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
