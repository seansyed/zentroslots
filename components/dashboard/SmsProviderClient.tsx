"use client";

import * as React from "react";
import { Badge, Button, Card, toast } from "@/components/ui/primitives";

type ProviderRow = {
  id: string;
  provider: "twilio" | "telnyx";
  accountId: string | null;
  senderId: string;
  authTokenSet: boolean;
  webhookSecretSet: boolean;
  active: boolean;
  totalSent: number;
  totalFailed: number;
  lastSendAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type LogRow = {
  id: string;
  action: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

const TABS = ["provider", "logs"] as const;
type Tab = (typeof TABS)[number];

export default function SmsProviderClient({ initialLogs }: { initialLogs: LogRow[] }) {
  const [tab, setTab] = React.useState<Tab>("provider");
  const [provider, setProvider] = React.useState<ProviderRow | null | undefined>(undefined);
  const [logs, setLogs] = React.useState<LogRow[]>(initialLogs);

  const refreshProvider = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/sms", { cache: "no-store" });
      if (res.ok) setProvider(await res.json());
    } catch {
      setProvider(null);
    }
  }, []);

  React.useEffect(() => { refreshProvider(); }, [refreshProvider]);

  async function refreshLogs() {
    // Logs refresh lazily — we don't ship a /api endpoint for it, so a
    // hard reload of the page fetches the next batch. Cheap enough.
    window.location.reload();
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "border-b-2 px-3 py-2 text-sm capitalize transition " +
              (t === tab
                ? "border-brand-accent font-medium text-brand-accent"
                : "border-transparent text-ink-muted hover:text-ink")
            }
          >
            {t === "provider" ? "SMS provider" : "Delivery logs"}
          </button>
        ))}
      </div>

      {tab === "provider" && (
        <ProviderForm provider={provider} onChanged={refreshProvider} />
      )}

      {tab === "logs" && (
        <LogsTable logs={logs} onRefresh={refreshLogs} />
      )}
    </div>
  );
}

function ProviderForm({
  provider,
  onChanged,
}: {
  provider: ProviderRow | null | undefined;
  onChanged: () => void;
}) {
  const [kind, setKind] = React.useState<"twilio" | "telnyx">(provider?.provider ?? "twilio");
  const [accountId, setAccountId] = React.useState(provider?.accountId ?? "");
  const [senderId, setSenderId] = React.useState(provider?.senderId ?? "");
  const [authToken, setAuthToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [testTo, setTestTo] = React.useState("");
  const [testing, setTesting] = React.useState(false);

  // Re-sync local form state when the server fetch settles, but only on
  // initial load — typing in the form shouldn't be clobbered by a
  // background refresh.
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current || provider === undefined) return;
    if (provider) {
      setKind(provider.provider);
      setAccountId(provider.accountId ?? "");
      setSenderId(provider.senderId);
    }
    seededRef.current = true;
  }, [provider]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        provider: kind,
        senderId,
        accountId: accountId.trim() || null,
      };
      if (authToken.trim()) body.authToken = authToken.trim();
      const res = await fetch("/api/tenant/sms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast("SMS provider saved", "success");
      setAuthToken("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect SMS provider? Outgoing SMS will stop until you reconnect.")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tenant/sms", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to disconnect");
      toast("Provider disconnected", "success");
      setAuthToken("");
      setAccountId("");
      setSenderId("");
      seededRef.current = false;
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!testTo.trim()) {
      toast("Enter a recipient phone (E.164 like +15551234567)", "error");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/tenant/sms/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast(`Test sent via ${data.provider} (id: ${data.providerMessageId ?? "—"})`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setTesting(false);
    }
  }

  const connected = Boolean(provider?.authTokenSet);
  const loading = provider === undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr,1fr]">
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            Provider
          </div>
          {connected && (
            <Badge tone={provider!.active ? "green" : "neutral"}>
              {provider!.active ? "connected" : "paused"}
            </Badge>
          )}
        </div>

        <div className="mb-3 text-xs text-ink-muted">
          Bring your own Twilio or Telnyx account. We never share credentials between tenants.
        </div>

        <Field label="Provider">
          <div className="flex overflow-hidden rounded-md border border-border">
            {(["twilio", "telnyx"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setKind(p)}
                disabled={busy}
                className={
                  "flex-1 px-3 py-1.5 text-sm capitalize transition " +
                  (p === kind
                    ? "bg-brand-accent text-white"
                    : "bg-surface text-ink-muted hover:bg-surface-inset")
                }
              >
                {p}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label={
            kind === "twilio"
              ? "Account SID (Twilio)"
              : "Messaging profile ID (Telnyx, optional)"
          }
        >
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder={kind === "twilio" ? "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" : "Leave blank to use the from number"}
            className={INPUT}
            maxLength={120}
            disabled={busy}
          />
        </Field>

        <Field label={kind === "twilio" ? "Auth Token" : "API Key"}>
          <input
            type="password"
            autoComplete="new-password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={
              connected ? "•••••••• (token on file — leave blank to keep)" : "Enter to connect"
            }
            className={INPUT}
            maxLength={500}
            disabled={busy}
          />
        </Field>

        <Field label={kind === "twilio" ? "From number / Messaging service SID" : "From number"}>
          <input
            value={senderId}
            onChange={(e) => setSenderId(e.target.value)}
            placeholder="+15551234567"
            className={INPUT}
            maxLength={40}
            disabled={busy}
          />
        </Field>

        {err && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {err}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            onClick={save}
            disabled={busy || loading || !senderId || (!connected && !authToken)}
          >
            {busy ? "Saving…" : connected ? "Update" : "Connect"}
          </Button>
          {connected && (
            <Button variant="secondary" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          )}
        </div>

        {connected && (
          <div className="mt-5 border-t border-border pt-4 text-xs text-ink-muted">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>Sent: <b className="text-ink">{provider!.totalSent}</b></span>
              <span>Failed: <b className="text-ink">{provider!.totalFailed}</b></span>
              {provider!.lastSendAt && (
                <span>Last send: {provider!.lastSendAt.slice(0, 19).replace("T", " ")}</span>
              )}
            </div>
            {provider!.lastError && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
                <div className="font-medium">Last error</div>
                <div className="mt-0.5">{provider!.lastError}</div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Send a test
        </div>
        <div className="mb-3 text-xs text-ink-muted">
          Confirm credentials end-to-end. Rate-limited to 10 per 10 minutes.
        </div>
        <Field label="Recipient (E.164)">
          <input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="+15551234567"
            className={INPUT}
            maxLength={20}
            disabled={testing || !connected}
          />
        </Field>
        <Button onClick={sendTest} disabled={testing || !connected}>
          {testing ? "Sending…" : "Send test SMS"}
        </Button>
        {!connected && (
          <div className="mt-3 text-xs text-ink-subtle">
            Connect a provider above first.
          </div>
        )}
      </Card>
    </div>
  );
}

function LogsTable({ logs, onRefresh }: { logs: LogRow[]; onRefresh: () => void }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          Last 50 SMS events
        </div>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {logs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-ink-subtle">
          No SMS attempts yet. Send a test to populate this log.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-left text-xs uppercase text-ink-subtle">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => {
                const md = l.metadata ?? {};
                const status = l.action === "sms.sent" ? "sent" : "failed";
                return (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{l.createdAt.slice(0, 19).replace("T", " ")}</td>
                    <td className="px-3 py-2">
                      <Badge tone={status === "sent" ? "green" : "red"}>{status}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{String((md as { to?: string }).to ?? "—")}</td>
                    <td className="px-3 py-2 text-xs text-ink-muted">{String((md as { kind?: string }).kind ?? "—")}</td>
                    <td className="px-3 py-2 text-xs text-ink-muted">
                      {status === "failed"
                        ? String((md as { error?: string }).error ?? "—")
                        : String((md as { messageId?: string }).messageId ?? (md as { provider?: string }).provider ?? "—")}
                    </td>
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

const INPUT = "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand-accent disabled:bg-surface-inset";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-medium text-ink-muted">{label}</div>
      {children}
    </div>
  );
}
