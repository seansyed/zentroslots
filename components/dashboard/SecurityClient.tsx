"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type SessionRow = {
  jti: string;
  loggedInAt: string;
  ipAddress: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  isCurrent: boolean;
  revoked: boolean;
};

type EventRow = {
  id: string;
  eventType: string;
  sessionJti: string | null;
  ipAddress: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ResetRow = {
  id: string;
  requestedIp: string | null;
  createdAt: string;
  consumedAt: string | null;
  consumedIp: string | null;
};

type TenantUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  effective: Record<string, boolean>;
  overrides: Record<string, boolean>;
  isCaller: boolean;
};

export default function SecurityClient(props: {
  canManage: boolean;
  permissions: Record<string, boolean>;
  permissionFlags?: string[];
  tenantUsers?: TenantUserRow[];
  activeSessions: SessionRow[];
  recentLogins: EventRow[];
  failedLogins: EventRow[];
  suspicious: EventRow[];
  resetHistory: ResetRow[];
  events: EventRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  async function revokeOne(jti: string) {
    setError(null);
    try {
      const res = await fetch(
        `/api/auth/sessions/${encodeURIComponent(jti)}/revoke`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not revoke session.");
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke session.");
    }
  }

  async function revokeAll() {
    setError(null);
    try {
      const res = await fetch("/api/auth/sessions/revoke-all", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Could not revoke sessions.");
      setConfirmAll(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke sessions.");
    }
  }

  return (
    <div className="mt-6 space-y-8">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Active sessions ─────────────────────────────────────── */}
      <section>
        <header className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Active sessions</h2>
          {props.canManage && props.activeSessions.length > 1 && (
            <button
              onClick={() => setConfirmAll(true)}
              disabled={pending}
              className="rounded border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Sign out all other sessions
            </button>
          )}
        </header>
        {props.activeSessions.length === 0 ? (
          <Empty>No tracked sessions yet. Your current cookie was issued before security tracking was enabled.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Device</th>
                  <th className="px-3 py-2">IP</th>
                  <th className="px-3 py-2">Signed in</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {props.activeSessions.map((s) => (
                  <tr key={s.jti} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-ink">
                      {s.deviceLabel ?? "Unknown device"}
                      {s.isCurrent && (
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                          this device
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{s.ipAddress ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{fmt(s.loggedInAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {s.revoked ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">revoked</span>
                      ) : (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">active</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {props.canManage && !s.isCurrent && !s.revoked && (
                        <button
                          onClick={() => revokeOne(s.jti)}
                          disabled={pending}
                          className="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Suspicious logins ─────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Suspicious activity</h2>
        {props.suspicious.length === 0 ? (
          <Empty>No suspicious logins in the last 30 days.</Empty>
        ) : (
          <EventList events={props.suspicious} variant="warning" />
        )}
      </section>

      {/* ── Recent logins ─────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Recent logins (30 days)</h2>
        {props.recentLogins.length === 0 ? (
          <Empty>No logins recorded in the last 30 days.</Empty>
        ) : (
          <EventList events={props.recentLogins} />
        )}
      </section>

      {/* ── Failed logins ─────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Failed login attempts (30 days)</h2>
        {props.failedLogins.length === 0 ? (
          <Empty>No failed login attempts in the last 30 days.</Empty>
        ) : (
          <EventList events={props.failedLogins} variant="warning" />
        )}
      </section>

      {/* ── Password reset history ─────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Password reset history</h2>
        {props.resetHistory.length === 0 ? (
          <Empty>No password reset requests on this account.</Empty>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2">From IP</th>
                  <th className="px-3 py-2">Consumed</th>
                  <th className="px-3 py-2">Consumed IP</th>
                </tr>
              </thead>
              <tbody>
                {props.resetHistory.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-xs text-slate-700">{fmt(r.createdAt)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.requestedIp ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.consumedAt ? fmt(r.consumedAt) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.consumedIp ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Audit events (recent) ────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Recent audit events</h2>
        {props.events.length === 0 ? (
          <Empty>No security events recorded yet.</Empty>
        ) : (
          <EventList events={props.events} />
        )}
      </section>

      {/* ── Permissions snapshot ─────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Your effective permissions</h2>
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(props.permissions).map(([flag, allowed]) => (
                <tr key={flag} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{flag}</td>
                  <td className="px-3 py-2 text-right text-xs">
                    {allowed ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">granted</span>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">denied</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Tenant user permissions manager ─────────────────────── */}
      {props.canManage && props.tenantUsers && props.permissionFlags && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink">User permissions</h2>
          <p className="mb-3 text-xs text-ink-muted">
            Per-user overrides for granular permission flags. Each toggle
            grants, revokes, or clears the override (reverting to the role
            default). Cannot modify your own permissions. Cannot grant a flag
            you don&rsquo;t hold.
          </p>
          <TenantUserPermissionsTable
            users={props.tenantUsers}
            flags={props.permissionFlags}
            callerPermissions={props.permissions}
            onChanged={() => startTransition(() => router.refresh())}
            onError={(msg) => setError(msg)}
          />
        </section>
      )}

      {/* Revoke-all confirmation modal */}
      {confirmAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-ink">Sign out all other sessions?</h3>
            <p className="mt-2 text-sm text-slate-600">
              Every active session for your account on every other device will
              be signed out immediately. You will stay signed in here.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmAll(false)}
                className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={revokeAll}
                disabled={pending}
                className="rounded border border-red-300 bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Sign out all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">
      {children}
    </div>
  );
}

function EventList({ events, variant }: { events: EventRow[]; variant?: "warning" }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">Event</th>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">IP</th>
            <th className="px-3 py-2">Device</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-t border-slate-100">
              <td className="px-3 py-2 text-xs">
                <span
                  className={
                    "rounded px-1.5 py-0.5 font-medium " +
                    (variant === "warning"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-slate-100 text-slate-700")
                  }
                >
                  {e.eventType}
                </span>
                {e.metadata?.summary ? (
                  <span className="ml-2 text-slate-500">
                    {String(e.metadata.summary).slice(0, 100)}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-xs text-slate-500">{fmt(e.createdAt)}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{e.ipAddress ?? "—"}</td>
              <td className="px-3 py-2 text-xs text-slate-500">{e.deviceLabel ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function TenantUserPermissionsTable(props: {
  users: TenantUserRow[];
  flags: string[];
  callerPermissions: Record<string, boolean>;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function patchOverride(userId: string, flag: string, value: boolean | null) {
    const key = `${userId}|${flag}`;
    setPendingKey(key);
    props.onError("");
    try {
      const res = await fetch(`/api/tenant/users/${encodeURIComponent(userId)}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag, value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        props.onError(data?.error ?? "Could not update permissions.");
        return;
      }
      props.onChanged();
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "Could not update permissions.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">Role</th>
            {props.flags.map((f) => (
              <th key={f} className="px-3 py-2 text-center font-mono text-[10px] normal-case">
                {f.replace(/^can/, "")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.users.map((u) => (
            <tr key={u.id} className="border-t border-slate-100">
              <td className="px-3 py-2">
                <div className="text-ink">
                  {u.name}
                  {u.isCaller && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                      you
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">{u.email}</div>
              </td>
              <td className="px-3 py-2 text-xs">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{u.role}</span>
              </td>
              {props.flags.map((f) => {
                const effective = u.effective[f];
                const hasOverride = Object.prototype.hasOwnProperty.call(u.overrides, f);
                const callerCan = props.callerPermissions[f] === true;
                const cellKey = `${u.id}|${f}`;
                const busy = pendingKey === cellKey;
                const disabled = u.isCaller || busy;
                return (
                  <td key={f} className="px-3 py-2 text-center">
                    <div className="flex flex-col items-center gap-1">
                      <span
                        className={
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase " +
                          (effective ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")
                        }
                      >
                        {effective ? "✓" : "—"}
                      </span>
                      {hasOverride && (
                        <span className="text-[9px] uppercase tracking-wider text-amber-600">override</span>
                      )}
                      {!u.isCaller && (
                        <div className="flex gap-0.5">
                          <button
                            disabled={disabled || !callerCan}
                            onClick={() => patchOverride(u.id, f, true)}
                            title={callerCan ? "Grant" : "You don't hold this permission"}
                            className="rounded border border-slate-200 px-1 py-0.5 text-[9px] hover:bg-emerald-50 disabled:opacity-30"
                          >
                            grant
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() => patchOverride(u.id, f, false)}
                            className="rounded border border-slate-200 px-1 py-0.5 text-[9px] hover:bg-red-50 disabled:opacity-30"
                          >
                            revoke
                          </button>
                          {hasOverride && (
                            <button
                              disabled={disabled}
                              onClick={() => patchOverride(u.id, f, null)}
                              title="Clear override (use role default)"
                              className="rounded border border-slate-200 px-1 py-0.5 text-[9px] hover:bg-slate-50 disabled:opacity-30"
                            >
                              clear
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
