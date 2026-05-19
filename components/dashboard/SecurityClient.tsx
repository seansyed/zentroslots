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

export default function SecurityClient(props: {
  canManage: boolean;
  permissions: Record<string, boolean>;
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
