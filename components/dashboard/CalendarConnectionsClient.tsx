"use client";

import * as React from "react";

import { Button, Card, toast } from "@/components/ui/primitives";

type Connection = {
  id: string;
  userId: string;
  provider: string;
  status: string;
  accountEmail: string | null;
  calendarId: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
};

type SyncLog = {
  id: string;
  connectionId: string | null;
  userId: string | null;
  bookingId: string | null;
  provider: string;
  kind: string;
  status: string;
  errorClass: string | null;
  errorMessage: string | null;
  externalEventId: string | null;
  latencyMs: number | null;
  createdAt: string;
};

const KIND_LABEL: Record<string, string> = {
  create: "Created event",
  update: "Updated event",
  delete: "Deleted event",
  freebusy: "Read busy time",
  connect: "Connected",
  disconnect: "Disconnected",
};

const STATUS_BADGE: Record<string, string> = {
  ok: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-slate-100 text-slate-600",
};

const CONN_STATUS_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  needs_reconnect: "bg-amber-100 text-amber-800",
  disconnected: "bg-slate-100 text-slate-600",
};

const CONN_STATUS_LABEL: Record<string, string> = {
  active: "Connected",
  needs_reconnect: "Reconnect required",
  disconnected: "Disconnected",
};

export default function CalendarConnectionsClient({
  viewerId,
  viewerRole,
  connections: initialConnections,
  logs: initialLogs,
  flashConnected,
  flashError,
}: {
  viewerId: string;
  viewerRole: string;
  connections: Connection[];
  logs: SyncLog[];
  flashConnected: string | null;
  flashError: string | null;
}) {
  const [connections, setConnections] = React.useState(initialConnections);
  const [logs, setLogs] = React.useState(initialLogs);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Show the OAuth result flash once on mount.
  React.useEffect(() => {
    if (flashConnected) toast(`${prettyProvider(flashConnected)} connected`, "success");
    if (flashError) toast(`Connection failed: ${flashError}`, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      const res = await fetch("/api/tenant/calendar-status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        connections: Connection[];
        logs: SyncLog[];
      };
      setConnections(data.connections);
      setLogs(data.logs);
    } catch {
      /* silent */
    }
  }

  async function disconnect(c: Connection) {
    if (!confirm(`Disconnect ${prettyProvider(c.provider)} for ${c.userName ?? c.userEmail ?? "this user"}?`)) {
      return;
    }
    setBusyId(c.id);
    try {
      const res = await fetch("/api/calendar/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: c.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Disconnect failed");
      toast("Disconnected", "success");
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  // Group connections by user for the viewing pane. Self goes first.
  const groups = React.useMemo(() => {
    const byUser = new Map<string, { userName: string | null; userEmail: string | null; rows: Connection[] }>();
    for (const c of connections) {
      const key = c.userId;
      const g = byUser.get(key);
      if (g) g.rows.push(c);
      else byUser.set(key, { userName: c.userName, userEmail: c.userEmail, rows: [c] });
    }
    const arr = Array.from(byUser.entries()).map(([userId, g]) => ({ userId, ...g }));
    arr.sort((a, b) => {
      if (a.userId === viewerId) return -1;
      if (b.userId === viewerId) return 1;
      return (a.userName ?? "").localeCompare(b.userName ?? "");
    });
    return arr;
  }, [connections, viewerId]);

  // Build empty group for self if viewer has no row.
  const selfHasRow = groups.some((g) => g.userId === viewerId);

  return (
    <div className="mt-6 space-y-8">
      {/* CONNECT TILES — providers section */}
      <section>
        <h2 className="text-sm font-semibold text-ink">Add a calendar</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Each staff member connects their own calendar; admins can disconnect any.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ProviderTile
            name="Google Calendar"
            logo="G"
            color="#4285F4"
            href="/api/calendar/google/connect"
            description="Two-way sync with Google Calendar + Meet auto-links."
            enabled
          />
          <ProviderTile
            name="Outlook"
            logo="O"
            color="#0078D4"
            href="#"
            description="Microsoft Graph integration is in development. Not yet available."
            enabled={false}
          />
          <ProviderTile
            name="Office 365"
            logo="365"
            color="#D24726"
            href="#"
            description="Microsoft Graph integration is in development. Not yet available."
            enabled={false}
          />
        </div>
      </section>

      {/* CONNECTIONS LIST */}
      <section>
        <h2 className="text-sm font-semibold text-ink">
          Your connections{viewerRole === "admin" || viewerRole === "manager" ? " · all staff" : ""}
        </h2>
        <div className="mt-3 space-y-3">
          {/* Self placeholder for viewers without a row yet */}
          {!selfHasRow && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium text-ink">You</div>
                  <div className="text-xs text-ink-muted">No calendar connected yet.</div>
                </div>
                <a
                  href="/api/calendar/google/connect"
                  className="rounded-md bg-brand-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                >
                  Connect Google
                </a>
              </div>
            </Card>
          )}

          {groups.map((g) => (
            <Card key={g.userId} className="p-4">
              <div className="text-sm font-medium text-ink">
                {g.userId === viewerId ? "You" : g.userName ?? g.userEmail ?? "Unknown user"}
                {g.userId !== viewerId && g.userEmail && (
                  <span className="ml-2 text-xs font-normal text-ink-muted">{g.userEmail}</span>
                )}
              </div>
              <ul className="mt-3 space-y-2">
                {g.rows.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                        <span className="font-medium">{prettyProvider(c.provider)}</span>
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-[10px] font-medium " +
                            (CONN_STATUS_BADGE[c.status] ?? "bg-slate-100 text-slate-600")
                          }
                        >
                          {CONN_STATUS_LABEL[c.status] ?? c.status}
                        </span>
                        {c.accountEmail && (
                          <span className="text-xs text-ink-muted">· {c.accountEmail}</span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-ink-subtle">
                        Calendar: <span className="font-mono">{c.calendarId}</span>
                        {c.lastSyncedAt && (
                          <> · Last synced {timeAgo(c.lastSyncedAt)}</>
                        )}
                      </div>
                      {c.lastError && c.status !== "active" && (
                        <div className="mt-1 text-xs text-red-700">{c.lastError}</div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {c.status === "needs_reconnect" && (
                        <a
                          href="/api/calendar/google/connect"
                          className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
                        >
                          Reconnect
                        </a>
                      )}
                      {c.status === "active" && (
                        <a
                          href="/api/calendar/google/connect"
                          className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-inset"
                        >
                          Re-authorize
                        </a>
                      )}
                      {c.status !== "disconnected" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyId === c.id}
                          onClick={() => disconnect(c)}
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      {/* SYNC LOGS */}
      <section>
        <h2 className="text-sm font-semibold text-ink">Recent activity</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Last 50 sync events. Failed entries include the provider error.
        </p>
        <Card className="mt-3 overflow-hidden p-0">
          {logs.length === 0 ? (
            <div className="p-6 text-center text-sm text-ink-muted">No sync activity yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-surface-subtle text-left uppercase text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Latency</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-ink-muted">{timeAgo(l.createdAt)}</td>
                    <td className="px-3 py-2 text-ink">{KIND_LABEL[l.kind] ?? l.kind}</td>
                    <td className="px-3 py-2">
                      <span className={"rounded-full px-2 py-0.5 text-[10px] font-medium " + (STATUS_BADGE[l.status] ?? "bg-slate-100 text-slate-600")}>
                        {l.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{l.latencyMs != null ? `${l.latencyMs} ms` : "—"}</td>
                    <td className="px-3 py-2 text-ink-muted">
                      {l.errorMessage ? (
                        <span className="text-red-700">
                          [{l.errorClass}] {l.errorMessage}
                        </span>
                      ) : l.externalEventId ? (
                        <span className="font-mono text-[10px]">{l.externalEventId.slice(0, 20)}…</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}

function ProviderTile({
  name,
  logo,
  color,
  href,
  description,
  enabled,
}: {
  name: string;
  logo: string;
  color: string;
  href: string;
  description: string;
  enabled: boolean;
}) {
  const inner = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-md text-sm font-bold text-white"
          style={{ backgroundColor: enabled ? color : "#94a3b8" }}
          aria-hidden
        >
          {logo}
        </div>
        <div className="text-sm font-semibold text-ink">{name}</div>
        {!enabled && (
          <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
            Coming soon
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-muted">{description}</p>
    </div>
  );
  if (!enabled) {
    return <Card className="cursor-not-allowed p-4 opacity-60">{inner}</Card>;
  }
  return (
    <a href={href} className="block">
      <Card className="p-4 transition hover:border-slate-300 hover:shadow">{inner}</Card>
    </a>
  );
}

function prettyProvider(p: string): string {
  if (p === "google") return "Google Calendar";
  if (p === "outlook") return "Outlook";
  if (p === "office365") return "Office 365";
  return p;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
