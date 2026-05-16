"use client";

import * as React from "react";
import { Card, Button, EmptyState, Badge, toast } from "@/components/ui/primitives";

type Domain = {
  id: string;
  host: string;
  verificationToken: string;
  verifiedAt: string | null;
  createdAt: string;
};

export default function DomainsClient({ initial }: { initial: Domain[] }) {
  const [rows, setRows] = React.useState(initial);
  const [host, setHost] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function add() {
    setBusy(true);
    try {
      const r = await fetch("/api/tenant/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      setRows((cur) => [...cur.filter((x) => x.id !== d.id), {
        id: d.id, host: d.host,
        verificationToken: d.verificationToken,
        verifiedAt: d.verifiedAt ?? null,
        createdAt: d.createdAt,
      }]);
      setHost("");
      toast("Domain added — follow the DNS instructions to verify", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <div className="mb-1 text-xs font-medium text-ink-muted">New domain</div>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value.toLowerCase())}
              placeholder="book.acme.com"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
          </div>
          <Button disabled={busy || !host} onClick={add}>{busy ? "Saving…" : "Add domain"}</Button>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="No custom domains yet"
          body="Add a hostname to get verification instructions. You'll need to point DNS at our edge once verified."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((d) => (
            <Card key={d.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-sm text-ink">{d.host}</div>
                {d.verifiedAt
                  ? <Badge tone="green">Verified</Badge>
                  : <Badge tone="amber">Awaiting verification</Badge>}
              </div>
              {!d.verifiedAt && (
                <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 text-xs">
                  <div className="font-medium text-ink">DNS verification</div>
                  <p className="mt-1 text-ink-muted">
                    Add a TXT record to your DNS to prove you own this domain:
                  </p>
                  <pre className="mt-2 overflow-auto rounded bg-surface p-2 font-mono text-[11px] text-ink">
{`Type:  TXT
Name:  _scheduling-saas.${d.host}
Value: ${d.verificationToken}`}
                  </pre>
                  <p className="mt-2 text-[11px] text-ink-subtle">
                    Once DNS propagates, your platform operator will flip the verified flag. Automated verification + CNAME provisioning lands in a future release.
                  </p>
                </div>
              )}
              {d.verifiedAt && (
                <p className="mt-2 text-xs text-ink-muted">
                  Verified {new Date(d.verifiedAt).toLocaleDateString()}. Booking widget served at{" "}
                  <a className="text-brand-accent hover:underline" href={`https://${d.host}/`} target="_blank" rel="noreferrer">{`https://${d.host}/`}</a>
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
