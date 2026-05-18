"use client";

import * as React from "react";
import { Badge, Button, Card, Skeleton, toast } from "@/components/ui/primitives";

type TemplateType =
  | "booking_confirmation"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "reminder_24h"
  | "reminder_1h";

const TEMPLATE_LABELS: Record<TemplateType, { title: string; subtitle: string }> = {
  booking_confirmation: { title: "Booking confirmation", subtitle: "Sent immediately when a customer books" },
  booking_cancelled:    { title: "Booking cancellation", subtitle: "Sent when a booking is cancelled" },
  booking_rescheduled:  { title: "Booking rescheduled",  subtitle: "Sent when a booking moves to a new time" },
  reminder_24h:         { title: "Reminder — 24 hours",  subtitle: "Sent ~24 hours before the appointment" },
  reminder_1h:          { title: "Reminder — 1 hour",    subtitle: "Sent ~1 hour before the appointment" },
};

// Sample context shown in preview + test-send. Real sends use the
// booking's actual values; these are only for the editor.
const SAMPLE_CONTEXT: Record<string, string> = {
  customer_name: "Alex Morgan",
  customer_first_name: "Alex",
  business_name: "Your Business",
  service_name: "60-minute consultation",
  staff_name: "Sam Lee",
  appointment_date: "Tuesday, May 27, 2026",
  appointment_time: "2:00 PM",
  appointment_end_time: "3:00 PM",
  location_name: "",
  meeting_link: "https://meet.example.com/abc-xyz",
  booking_link: "https://book.example.com/your-business",
  cancel_link: "https://example.com/cancel/...",
  reschedule_link: "https://example.com/reschedule/...",
  business_phone: "",
  business_email: "hello@example.com",
  notes: "",
};

const SUPPORTED_VARIABLES = [
  "customer_name", "customer_first_name", "business_name", "service_name",
  "staff_name", "appointment_date", "appointment_time", "appointment_end_time",
  "meeting_link", "booking_link", "cancel_link", "reschedule_link",
  "business_email", "notes",
] as const;

type Row = {
  templateType: TemplateType;
  isCustomized: boolean;
  subject: string;
  htmlContent: string;
  textContent: string;
  enabled: boolean;
  updatedAt: string | null;
};

export default function TemplatesClient({ currentUserEmail }: { currentUserEmail: string }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [openType, setOpenType] = React.useState<TemplateType | null>(null);

  const refresh = React.useCallback(async () => {
    setRows(null);
    try {
      const res = await fetch("/api/tenant/communications/templates", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Row[];
      setRows(data);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
      setRows([]);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const open = openType ? rows?.find((r) => r.templateType === openType) ?? null : null;

  return (
    <div className="mt-6">
      {rows === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <TemplateCard
              key={r.templateType}
              row={r}
              onOpen={() => setOpenType(r.templateType)}
            />
          ))}
        </div>
      )}

      {open && (
        <TemplateEditor
          initial={open}
          currentUserEmail={currentUserEmail}
          onClose={() => setOpenType(null)}
          onSaved={() => { setOpenType(null); refresh(); }}
        />
      )}
    </div>
  );
}

function TemplateCard({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const meta = TEMPLATE_LABELS[row.templateType];
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{meta.title}</div>
          <div className="mt-0.5 text-xs text-ink-muted">{meta.subtitle}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!row.enabled && <Badge tone="red">disabled</Badge>}
          {row.isCustomized
            ? <Badge tone="violet">custom</Badge>
            : <Badge tone="neutral">default</Badge>}
        </div>
      </div>
      <div className="mt-3 truncate text-xs text-ink-subtle">{row.subject || "—"}</div>
      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={onOpen}>Edit</Button>
        {row.updatedAt && (
          <span className="text-[11px] text-ink-subtle">
            updated {row.updatedAt.slice(0, 10)}
          </span>
        )}
      </div>
    </Card>
  );
}

function TemplateEditor({
  initial,
  onClose,
  onSaved,
  currentUserEmail,
}: {
  initial: Row;
  onClose: () => void;
  onSaved: () => void;
  currentUserEmail: string;
}) {
  const meta = TEMPLATE_LABELS[initial.templateType];
  const [draft, setDraft] = React.useState({
    subject: initial.subject,
    htmlContent: initial.htmlContent,
    textContent: initial.textContent,
    enabled: initial.enabled,
  });
  const [view, setView] = React.useState<"edit" | "preview">("edit");
  const [saving, setSaving] = React.useState(false);
  const [testTo, setTestTo] = React.useState(currentUserEmail);
  const [testing, setTesting] = React.useState(false);
  const [previewHtml, setPreviewHtml] = React.useState("");
  const [previewSubject, setPreviewSubject] = React.useState("");

  // Live preview — re-render with sample context whenever switching to
  // preview view, debounced cheaply by tab switch.
  React.useEffect(() => {
    if (view !== "preview") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tenant/communications/templates/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: draft.subject,
            htmlContent: draft.htmlContent,
            textContent: draft.textContent,
            context: SAMPLE_CONTEXT,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data?.error ?? "preview failed");
        setPreviewHtml(data.htmlContent);
        setPreviewSubject(data.subject);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Preview failed", "error");
      }
    })();
    return () => { cancelled = true; };
  }, [view, draft.subject, draft.htmlContent, draft.textContent]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/communications/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateType: initial.templateType,
          subject: draft.subject || null,
          htmlContent: draft.htmlContent || null,
          textContent: draft.textContent || null,
          enabled: draft.enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast("Template saved", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function restoreDefaults() {
    if (!confirm(`Restore "${meta.title}" to the system default? Your customizations will be discarded.`)) return;
    try {
      const res = await fetch(`/api/tenant/communications/templates?type=${initial.templateType}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Restored default", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Restore failed", "error");
    }
  }

  async function sendTest() {
    if (!testTo.includes("@")) {
      toast("Enter a valid email", "error");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/tenant/communications/templates/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: testTo,
          subject: draft.subject,
          htmlContent: draft.htmlContent,
          textContent: draft.textContent,
          context: SAMPLE_CONTEXT,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Send failed");
      toast(`Test sent via ${data.provider}`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Send failed", "error");
    } finally {
      setTesting(false);
    }
  }

  function insertVar(key: string) {
    // Focused textarea gets the token; if neither focused, append to html.
    const tag = `{{${key}}}`;
    const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const next = active.value.slice(0, start) + tag + active.value.slice(end);
      // Routes through React state for whichever field is focused.
      if (active.id === "tpl-subject") setDraft({ ...draft, subject: next });
      else if (active.id === "tpl-html") setDraft({ ...draft, htmlContent: next });
      else if (active.id === "tpl-text") setDraft({ ...draft, textContent: next });
      // Restore selection on next tick.
      requestAnimationFrame(() => {
        try {
          active.focus();
          active.setSelectionRange(start + tag.length, start + tag.length);
        } catch { /* ignore */ }
      });
      return;
    }
    setDraft({ ...draft, htmlContent: draft.htmlContent + tag });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit template"
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full max-w-4xl flex-col bg-white shadow-xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Email template
            </div>
            <h2 className="text-base font-semibold text-ink">{meta.title}</h2>
            <p className="mt-0.5 text-xs text-ink-muted">{meta.subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-slate-300">
              {(["edit", "preview"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={
                    "px-3 py-1.5 text-xs capitalize " +
                    (v === view
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-700 hover:bg-slate-50")
                  }
                >
                  {v}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset"
            >
              ×
            </button>
          </div>
        </header>

        {/* Body */}
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[1fr,260px] overflow-hidden">
          <div className="overflow-y-auto p-5">
            {view === "edit" ? (
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />
                  <span>
                    Enabled
                    <span className="ml-1.5 text-xs text-ink-muted">
                      (unchecking suppresses this email entirely for your workspace)
                    </span>
                  </span>
                </label>

                <Field label="Subject">
                  <input
                    id="tpl-subject"
                    value={draft.subject}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                    maxLength={500}
                    className={INPUT}
                    placeholder="Confirmed: {{service_name}} on {{appointment_date}}"
                  />
                </Field>

                <Field label="HTML body" hint="Variables like {{customer_name}} substitute at send time.">
                  <textarea
                    id="tpl-html"
                    value={draft.htmlContent}
                    onChange={(e) => setDraft({ ...draft, htmlContent: e.target.value })}
                    maxLength={50_000}
                    rows={16}
                    className={INPUT + " font-mono text-xs"}
                  />
                </Field>

                <Field label="Plain-text fallback" hint="Shown by email clients that don't render HTML.">
                  <textarea
                    id="tpl-text"
                    value={draft.textContent}
                    onChange={(e) => setDraft({ ...draft, textContent: e.target.value })}
                    maxLength={20_000}
                    rows={6}
                    className={INPUT + " font-mono text-xs"}
                  />
                </Field>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                    Subject
                  </div>
                  <div className="mt-1 font-medium text-ink">{previewSubject}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-200 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                    HTML preview · sample data
                  </div>
                  <iframe
                    title="Template preview"
                    srcDoc={previewHtml}
                    className="block h-[480px] w-full"
                    sandbox=""
                  />
                </div>
              </div>
            )}
          </div>

          {/* Sidebar — variable picker + actions */}
          <aside className="hidden border-l border-slate-200 bg-slate-50 lg:block">
            <div className="overflow-y-auto p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                Variables
              </div>
              <p className="mt-1 text-[11px] text-ink-muted">
                Click to insert at your cursor.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {SUPPORTED_VARIABLES.map((v) => (
                  <button
                    key={v}
                    onClick={() => insertVar(v)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-[10px] text-slate-700 transition hover:border-brand-accent hover:text-brand-accent"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>

              <div className="my-5 h-px bg-slate-200" />

              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                Send a test
              </div>
              <p className="mt-1 text-[11px] text-ink-muted">
                Renders this draft with sample data and ships it to the address below. Bypasses
                customer prefs (it&rsquo;s a deliberate admin send).
              </p>
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                className={INPUT + " mt-2 text-xs"}
                placeholder="you@example.com"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={sendTest}
                disabled={testing}
                className="mt-2 w-full"
              >
                {testing ? "Sending…" : "Send test"}
              </Button>
            </div>
          </aside>
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-5 py-3">
          <button
            onClick={restoreDefaults}
            disabled={!initial.isCustomized}
            className="text-xs text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {initial.isCustomized ? "↺ Restore default" : "Using system default"}
          </button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

const INPUT = "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-700">{label}</label>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
