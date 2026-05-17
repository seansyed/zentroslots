"use client";

import * as React from "react";
import { Card, Button, toast } from "@/components/ui/primitives";

type Service = { id: string; name: string; slug: string; hasStaff: boolean };

export default function EmbedSnippetsClient({
  baseUrl,
  tenantSlug,
  services,
}: {
  baseUrl: string;
  tenantSlug: string;
  services: Service[];
}) {
  const [serviceSlug, setServiceSlug] = React.useState<string>(services[0]?.slug ?? "");
  const [height, setHeight] = React.useState(720);
  const [mode, setMode] = React.useState<"inline" | "popup">("inline");

  const selectedService = services.find((s) => s.slug === serviceSlug) ?? null;
  const selectedHasStaff = selectedService?.hasStaff ?? false;

  const embedUrl = `${baseUrl}/embed/${tenantSlug}/${serviceSlug || "—"}`;

  const iframeSnippet = `<iframe
  src="${embedUrl}"
  style="width:100%;max-width:560px;height:${height}px;border:0;border-radius:12px;"
  loading="lazy"
></iframe>`;

  const scriptSnippet = `<!-- Booking button: opens ${tenantSlug}/${serviceSlug || "service"} in a popup -->
<button id="ss-book-${serviceSlug}" style="background:#2563eb;color:#fff;padding:10px 16px;border:0;border-radius:8px;font:600 14px system-ui;cursor:pointer">
  Book a meeting
</button>
<script>
  (function(){
    var b = document.getElementById("ss-book-${serviceSlug}");
    if (!b) return;
    b.addEventListener("click", function(){
      var w = 560, h = ${height};
      var l = Math.max(0, (screen.width - w) / 2);
      var t = Math.max(0, (screen.height - h) / 2);
      window.open(
        "${embedUrl}",
        "scheduling-saas",
        "width=" + w + ",height=" + h + ",left=" + l + ",top=" + t + ",scrollbars=yes"
      );
    });
  })();
</script>`;

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast("Copied to clipboard", "success"),
      () => toast("Copy failed", "error")
    );
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1fr,1fr]">
      <Card>
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Configure</div>

        <Field label="Service">
          <select
            value={serviceSlug}
            onChange={(e) => setServiceSlug(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            {services.length === 0 && <option value="">No services</option>}
            {services.map((s) => (
              <option key={s.id} value={s.slug}>
                {s.name}{s.hasStaff ? "" : " — no staff assigned"}
              </option>
            ))}
          </select>
          {selectedService && !selectedHasStaff && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="font-medium">This service can&rsquo;t take bookings yet.</div>
              <div className="mt-1">
                No staff member is assigned to deliver <b>{selectedService.name}</b>. The widget below will
                show a &ldquo;not bookable&rdquo; message until you assign someone on the{" "}
                <a href="/dashboard/services" className="underline">Services page</a>.
              </div>
            </div>
          )}
        </Field>

        <Field label="Widget style">
          <div className="flex overflow-hidden rounded-md border border-border">
            {(["inline", "popup"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  "flex-1 px-3 py-1.5 text-sm capitalize transition " +
                  (m === mode ? "bg-brand-accent text-white" : "bg-surface text-ink-muted hover:bg-surface-inset hover:text-ink")
                }
              >
                {m === "inline" ? "Inline embed" : "Popup button"}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Height (px)">
          <input
            type="number" min={300} max={1200} step={20}
            value={height} onChange={(e) => setHeight(Number(e.target.value))}
            className="w-32 rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Direct embed URL">
          <div className="flex gap-2">
            <input
              readOnly
              value={embedUrl}
              className="flex-1 rounded-md border border-border bg-surface-inset px-3 py-2 font-mono text-xs"
            />
            <Button variant="secondary" size="sm" onClick={() => copy(embedUrl)}>Copy</Button>
          </div>
          <p className="mt-1 text-[11px] text-ink-subtle">
            Open this URL in a new tab to preview exactly what visitors see.
          </p>
        </Field>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            {mode === "inline" ? "Inline iframe snippet" : "Popup button snippet"}
          </div>
          <Button variant="secondary" size="sm" onClick={() => copy(mode === "inline" ? iframeSnippet : scriptSnippet)}>
            Copy code
          </Button>
        </div>
        <pre className="max-h-[420px] overflow-auto rounded-md bg-surface-inset p-3 font-mono text-[11px] leading-snug text-ink">
{mode === "inline" ? iframeSnippet : scriptSnippet}
        </pre>
        <p className="mt-2 text-[11px] text-ink-subtle">
          Paste this anywhere a customer would book. The booking is processed by your workspace and the customer is added to your CRM automatically.
        </p>
      </Card>

      <Card className="lg:col-span-2">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Live preview</div>
        <iframe
          src={embedUrl}
          title="Embed preview"
          style={{ width: "100%", maxWidth: 560, height, border: 0, borderRadius: 12 }}
          loading="lazy"
        />
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-medium text-ink-muted">{label}</div>
      {children}
    </div>
  );
}
