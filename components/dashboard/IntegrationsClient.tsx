"use client";

import * as React from "react";
import { Badge, Button, Card, toast } from "@/components/ui/primitives";

type Init = {
  googleConnected: boolean;
  notificationWebhookUrl: string;
  hidePoweredBy: boolean;
};

export default function IntegrationsClient({
  initial,
  plan,
}: {
  initial: Init;
  plan: { id: string; name: string; canHideBadge: boolean };
}) {
  const [webhook, setWebhook] = React.useState(initial.notificationWebhookUrl);
  const [hideBadge, setHideBadge] = React.useState(initial.hidePoweredBy);
  const [savingWebhook, setSavingWebhook] = React.useState(false);
  const [savingBadge, setSavingBadge] = React.useState(false);

  async function saveWebhook() {
    setSavingWebhook(true);
    try {
      const r = await fetch("/api/tenant/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationWebhookUrl: webhook || null }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      toast("Webhook saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingWebhook(false);
    }
  }

  async function toggleBadge() {
    if (!plan.canHideBadge) {
      toast("Upgrade to Pro to hide the Powered-by badge.", "info");
      return;
    }
    const next = !hideBadge;
    setHideBadge(next);
    setSavingBadge(true);
    try {
      const r = await fetch("/api/tenant/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidePoweredBy: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      toast(next ? "Badge hidden" : "Badge restored", "success");
    } catch (e) {
      setHideBadge(!next);
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingBadge(false);
    }
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink">Google Calendar</div>
            <p className="mt-0.5 text-xs text-ink-muted">Auto-create Google Meet events on confirmed bookings.</p>
          </div>
          {initial.googleConnected ? <Badge tone="green">Connected</Badge> : <Badge tone="neutral">Not connected</Badge>}
        </div>
        {!initial.googleConnected && (
          <a
            href="/api/google/connect"
            className="mt-3 inline-flex rounded-md bg-brand-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            Connect Google
          </a>
        )}
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink">Microsoft 365 / Outlook</div>
            <p className="mt-0.5 text-xs text-ink-muted">Outlook calendar sync + Teams meeting links.</p>
          </div>
          <Badge tone="neutral">Coming soon</Badge>
        </div>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink">Zoom</div>
            <p className="mt-0.5 text-xs text-ink-muted">Auto-create Zoom meetings (OAuth in a future release).</p>
          </div>
          <Badge tone="neutral">Coming soon</Badge>
        </div>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink">Slack / Webhook</div>
            <p className="mt-0.5 text-xs text-ink-muted">
              POST a JSON payload to any URL on booking events. Slack&rsquo;s incoming-webhook URLs work out of the box.
            </p>
          </div>
          {webhook ? <Badge tone="green">Active</Badge> : <Badge tone="neutral">Off</Badge>}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="url"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
          <Button size="sm" onClick={saveWebhook} disabled={savingWebhook}>
            {savingWebhook ? "…" : "Save"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-subtle">
          Payload: <code className="rounded bg-surface-inset px-1 py-0.5 font-mono">{`{ text, event, bookingId, … }`}</code>
        </p>
      </Card>

      <Card className="lg:col-span-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-ink">Hide &ldquo;Powered by Scheduling SaaS&rdquo;</div>
              {!plan.canHideBadge && <Badge tone="amber">Pro plan</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">
              On Pro and Team, remove the platform footer from your public booking page and embed widget.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={hideBadge}
            onClick={toggleBadge}
            disabled={savingBadge}
            className={
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors " +
              (hideBadge ? "bg-brand-accent" : "bg-surface-inset")
            }
          >
            <span
              className={
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition " +
                (hideBadge ? "translate-x-5" : "translate-x-0")
              }
            />
          </button>
        </div>
      </Card>
    </div>
  );
}
