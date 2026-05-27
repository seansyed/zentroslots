"use client";

import * as React from "react";
import { Badge, Button, Card, Skeleton, toast, confirmAction } from "@/components/ui/primitives";
import { hasWarnings, lintHtmlTemplate, type LintFinding } from "@/lib/communications/html-lint";

// Kept in sync with lib/communications/template-types.ts. The API
// returns one row per type in TEMPLATE_TYPES — if this union ever
// drifts, the `labelFor()` helper below renders the unknown type
// gracefully instead of crashing on `undefined.title`.
type TemplateType =
  | "booking_confirmation"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "reminder_24h"
  | "reminder_1h"
  | "appointment_completed"
  | "appointment_no_show"
  | "review_request"
  | "followup"
  | "waitlist_slot_available";

const TEMPLATE_LABELS: Record<TemplateType, { title: string; subtitle: string }> = {
  booking_confirmation:    { title: "Booking confirmation",    subtitle: "Sent immediately when a customer books" },
  booking_cancelled:       { title: "Booking cancellation",    subtitle: "Sent when a booking is cancelled" },
  booking_rescheduled:     { title: "Booking rescheduled",     subtitle: "Sent when a booking moves to a new time" },
  reminder_24h:            { title: "Reminder — 24 hours",     subtitle: "Sent ~24 hours before the appointment" },
  reminder_1h:             { title: "Reminder — 1 hour",       subtitle: "Sent ~1 hour before the appointment" },
  appointment_completed:   { title: "Completion follow-up",    subtitle: "Sent after an appointment is marked completed" },
  appointment_no_show:     { title: "Missed booking",          subtitle: "Sent when a customer no-shows" },
  review_request:          { title: "Review request",          subtitle: "Sent post-completion to invite a review" },
  followup:                { title: "Follow-up",               subtitle: "Custom follow-up triggered by your automations" },
  waitlist_slot_available: { title: "Waitlist slot available", subtitle: "Sent when a waitlist spot opens for a customer" },
};

// Defensive lookup — never returns undefined. If the API ever ships a
// type ahead of this client (e.g. a Phase-N addition before a redeploy),
// the row still renders with a humanized label instead of crashing the
// whole page.
function labelFor(type: string): { title: string; subtitle: string } {
  const known = (TEMPLATE_LABELS as Record<string, { title: string; subtitle: string }>)[type];
  if (known) return known;
  // Convert "review_request" → "Review request"
  const pretty = type
    .split(/[_.]/)
    .filter(Boolean)
    .map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
  return { title: pretty || type, subtitle: "Custom template" };
}

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

type TemplateSource = "service" | "tenant" | "system";

type Row = {
  templateType: TemplateType;
  // 'business' when scope picker is on Business default; 'service' when
  // viewing a specific service. Echoed from the API.
  scope?: "business" | "service";
  // Where the rendered content actually came from in the hierarchy.
  source?: TemplateSource;
  isCustomized: boolean;
  subject: string;
  htmlContent: string;
  textContent: string;
  enabled: boolean;
  updatedAt: string | null;
  /** How many services have an override for THIS template type. Only
   *  returned in business scope. Drives the "Used by N services" badge. */
  overridingServiceCount?: number;
};

type ServiceOption = {
  id: string;
  name: string;
  slug: string;
  overrideCount: number;
};

export default function TemplatesClient({ currentUserEmail }: { currentUserEmail: string }) {
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [services, setServices] = React.useState<ServiceOption[]>([]);
  // null = "Business default" scope. Otherwise the active service id.
  const [scopeServiceId, setScopeServiceId] = React.useState<string | null>(null);
  const [openType, setOpenType] = React.useState<TemplateType | null>(null);
  const [search, setSearch] = React.useState("");

  const refreshServices = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/communications/services", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ServiceOption[];
      setServices(data);
    } catch { /* no-op — scope picker just won't show services */ }
  }, []);

  const refreshTemplates = React.useCallback(
    async (serviceId: string | null) => {
      setRows(null);
      try {
        const url = serviceId
          ? `/api/tenant/communications/templates?serviceId=${encodeURIComponent(serviceId)}`
          : "/api/tenant/communications/templates";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Row[];
        setRows(data);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Failed to load", "error");
        setRows([]);
      }
    },
    []
  );

  React.useEffect(() => { refreshServices(); }, [refreshServices]);
  React.useEffect(() => { refreshTemplates(scopeServiceId); }, [refreshTemplates, scopeServiceId]);

  const open = openType ? rows?.find((r) => r.templateType === openType) ?? null : null;
  const activeService = services.find((s) => s.id === scopeServiceId) ?? null;

  // Quick restore — calls DELETE without opening the editor. Used from
  // the card "↺ Restore" action. Skipped for non-customized rows (the
  // button is hidden there anyway).
  const quickRestore = React.useCallback(
    async (type: TemplateType) => {
      const params = new URLSearchParams({ type });
      if (scopeServiceId) params.set("serviceId", scopeServiceId);
      const target = labelFor(type).title;
      if (
        !(await confirmAction({
          title: scopeServiceId
            ? `Revert "${target}" to inherit from business default?`
            : `Revert "${target}" to the system default?`,
          body: scopeServiceId
            ? "The service override is deleted. This template now follows the business default."
            : "Your customizations are discarded. The template returns to ZentroMeet's built-in copy.",
          variant: "warning",
          confirmLabel: "Revert template",
        }))
      ) {
        return;
      }
      try {
        const res = await fetch(`/api/tenant/communications/templates?${params.toString()}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast("Reverted", "success");
        refreshTemplates(scopeServiceId);
        refreshServices();
      } catch (e) {
        toast(e instanceof Error ? e.message : "Restore failed", "error");
      }
    },
    [scopeServiceId, refreshServices, refreshTemplates]
  );

  // Filter cards by title/subject substring. Cheap; runs on every
  // keystroke. Returns the unfiltered list when the search is empty.
  const filteredRows = React.useMemo(() => {
    if (!rows) return rows;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const title = labelFor(r.templateType).title.toLowerCase();
      const subject = (r.subject ?? "").toLowerCase();
      return title.includes(q) || subject.includes(q);
    });
  }, [rows, search]);

  return (
    <div className="mt-6">
      {/* Scope picker — Business default vs per-service */}
      <ScopePicker
        services={services}
        activeServiceId={scopeServiceId}
        onChange={setScopeServiceId}
      />

      {scopeServiceId && activeService && (
        <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900">
          Editing templates for <b>{activeService.name}</b>. Service-level overrides take
          precedence over business defaults; everything else inherits from your business templates.
        </div>
      )}

      {/* Search box — client-side filter over the 5 template types. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates by name or subject…"
          aria-label="Search templates"
          className="w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
        />
        {search && rows && filteredRows && filteredRows.length !== rows.length && (
          <span className="text-xs text-ink-subtle">
            {filteredRows.length} of {rows.length} match
          </span>
        )}
      </div>

      <div className="mt-4">
        {rows === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
        ) : filteredRows && filteredRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-ink-muted">
            No templates match &ldquo;{search}&rdquo;.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredRows!.map((r) => (
              <TemplateCard
                key={r.templateType}
                row={r}
                onOpen={() => setOpenType(r.templateType)}
                onQuickRestore={
                  // Only meaningful when this row IS customized; the
                  // card hides the button otherwise.
                  (scopeServiceId && r.source === "service") || (!scopeServiceId && r.isCustomized)
                    ? () => quickRestore(r.templateType)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {open && (
        <TemplateEditor
          initial={open}
          serviceId={scopeServiceId}
          serviceName={activeService?.name ?? null}
          currentUserEmail={currentUserEmail}
          onClose={() => setOpenType(null)}
          onSaved={() => {
            setOpenType(null);
            refreshTemplates(scopeServiceId);
            refreshServices();
          }}
        />
      )}
    </div>
  );
}

function ScopePicker({
  services,
  activeServiceId,
  onChange,
}: {
  services: ServiceOption[];
  activeServiceId: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        Editing scope
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          onClick={() => onChange(null)}
          className={
            "rounded-md border px-3 py-1.5 transition " +
            (activeServiceId === null
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")
          }
        >
          Business default
        </button>
        <span className="mx-1 text-slate-300">|</span>
        <label className="text-xs text-ink-muted">Per service:</label>
        <select
          value={activeServiceId ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="min-w-[200px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
        >
          <option value="">— pick a service —</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.overrideCount > 0 ? ` (${s.overrideCount} override${s.overrideCount === 1 ? "" : "s"})` : ""}
            </option>
          ))}
        </select>
        {services.length === 0 && (
          <span className="text-[11px] text-ink-subtle">
            (no active services yet — create one to enable per-service overrides)
          </span>
        )}
      </div>
    </div>
  );
}

function TemplateCard({
  row,
  onOpen,
  onQuickRestore,
}: {
  row: Row;
  onOpen: () => void;
  /** Present only when this row is restorable in the current scope.
   *  Triggers the DELETE without opening the editor (saves a click for
   *  the "I just want to reset to default" path). */
  onQuickRestore?: () => void;
}) {
  const meta = labelFor(row.templateType);
  // Source labels — only meaningful in service scope. In business scope
  // the "tenant" source effectively means "custom"; "system" means "default".
  const isServiceScope = row.scope === "service";
  const sourceLabel =
    isServiceScope
      ? row.source === "service"
        ? { tone: "violet" as const, text: "Service override" }
        : row.source === "tenant"
          ? { tone: "blue" as const, text: "Inherited from business" }
          : { tone: "neutral" as const, text: "Inherited from system default" }
      : row.isCustomized
        ? { tone: "violet" as const, text: "Custom" }
        : { tone: "neutral" as const, text: "System default" };

  const overridingCount = row.overridingServiceCount ?? 0;

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{meta.title}</div>
          <div className="mt-0.5 text-xs text-ink-muted">{meta.subtitle}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!row.enabled && <Badge tone="red">disabled</Badge>}
          <Badge tone={sourceLabel.tone}>{sourceLabel.text}</Badge>
          {/* Business scope only — how many services override this. */}
          {!isServiceScope && overridingCount > 0 && (
            <Badge tone="blue">
              Used by {overridingCount} service{overridingCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </div>
      <div className="mt-3 truncate text-xs text-ink-subtle">{row.subject || "—"}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onOpen}>
          {isServiceScope && row.source !== "service" ? "Override" : "Edit"}
        </Button>
        {onQuickRestore && (
          <button
            onClick={onQuickRestore}
            className="text-[11px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            title={isServiceScope ? "Revert to inherited" : "Restore system default"}
          >
            ↺ Restore
          </button>
        )}
        {row.updatedAt && (
          <span className="ml-auto text-[11px] text-ink-subtle">
            updated {row.updatedAt.slice(0, 10)}
          </span>
        )}
      </div>
    </Card>
  );
}

function TemplateEditor({
  initial,
  serviceId,
  serviceName,
  onClose,
  onSaved,
  currentUserEmail,
}: {
  initial: Row;
  /** Active scope. null = business default, non-null = service override. */
  serviceId: string | null;
  /** Human name of the active service (for confirm dialogs + heading). */
  serviceName: string | null;
  onClose: () => void;
  onSaved: () => void;
  currentUserEmail: string;
}) {
  const meta = labelFor(initial.templateType);
  const initialDraft = React.useMemo(
    () => ({
      subject: initial.subject,
      htmlContent: initial.htmlContent,
      textContent: initial.textContent,
      enabled: initial.enabled,
    }),
    [initial]
  );
  const [draft, setDraft] = React.useState(initialDraft);
  const [view, setView] = React.useState<"edit" | "preview">("edit");
  const [previewViewport, setPreviewViewport] = React.useState<"desktop" | "mobile">("desktop");
  const [saving, setSaving] = React.useState(false);
  const [testTo, setTestTo] = React.useState(currentUserEmail);
  const [testing, setTesting] = React.useState(false);
  const [previewHtml, setPreviewHtml] = React.useState("");
  const [previewSubject, setPreviewSubject] = React.useState("");

  // Dirty state — drives the unsaved-changes warning. Compares draft
  // to the snapshot taken at editor open; flips to clean again after
  // a successful save (via onSaved).
  const dirty = React.useMemo(
    () =>
      draft.subject !== initialDraft.subject ||
      draft.htmlContent !== initialDraft.htmlContent ||
      draft.textContent !== initialDraft.textContent ||
      draft.enabled !== initialDraft.enabled,
    [draft, initialDraft]
  );

  // Browser-level guard: tab close / refresh while dirty.
  React.useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the returnValue string but require it set.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // HTML lint findings — recomputed on every keystroke. Cheap (regex
  // over a small body); no debounce needed.
  const lintFindings: LintFinding[] = React.useMemo(
    () => lintHtmlTemplate(draft.htmlContent),
    [draft.htmlContent]
  );
  const hasLintWarnings = hasWarnings(lintFindings);

  // Wrap onClose with the dirty-state confirmation prompt.
  const confirmClose = React.useCallback(async () => {
    if (dirty) {
      const ok = await confirmAction({
        title: "Discard unsaved changes?",
        body: "You have edits to this template that haven't been saved.",
        variant: "warning",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
      });
      if (!ok) return;
    }
    onClose();
  }, [dirty, onClose]);

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
    // Optimistic-rollback contract: snapshot the draft BEFORE the
    // network call, and restore it on failure. The visible state never
    // diverges from what the server believes — even if the user kept
    // typing during the in-flight request, we abort by overwriting
    // back to the last-known-bad snapshot (consistent with toast).
    const snapshot = draft;
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/communications/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateType: initial.templateType,
          // serviceId echoed back: present = service-scoped override,
          // null/omitted = business-wide. API enforces tenant ownership.
          serviceId,
          subject: snapshot.subject || null,
          htmlContent: snapshot.htmlContent || null,
          textContent: snapshot.textContent || null,
          enabled: snapshot.enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast(serviceId ? "Service override saved" : "Template saved", "success");
      onSaved();
    } catch (e) {
      // Roll back to the snapshot so dirty-state recalculates correctly
      // and the user sees exactly what wasn't saved.
      setDraft(snapshot);
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function restoreDefaults() {
    if (
      !(await confirmAction({
        title: serviceId
          ? `Restore "${meta.title}" for ${serviceName ?? "this service"}?`
          : `Restore "${meta.title}" to the system default?`,
        body: serviceId
          ? "The service override is deleted. This service inherits the business default going forward."
          : "Your customizations are discarded. The template returns to ZentroMeet's built-in copy.",
        variant: "warning",
        confirmLabel: "Restore default",
      }))
    ) {
      return;
    }
    try {
      const params = new URLSearchParams({ type: initial.templateType });
      if (serviceId) params.set("serviceId", serviceId);
      const res = await fetch(`/api/tenant/communications/templates?${params.toString()}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(serviceId ? "Reverted to inherited" : "Restored default", "success");
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
      onClick={(e) => { if (e.target === e.currentTarget) confirmClose(); }}
    >
      <div className="flex h-full w-full max-w-4xl flex-col bg-white shadow-xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              {serviceId ? (
                <>Service template · <span className="text-ink">{serviceName ?? "Service"}</span></>
              ) : (
                <>Email template · Business default</>
              )}
            </div>
            <h2 className="text-base font-semibold text-ink">{meta.title}</h2>
            <p className="mt-0.5 text-xs text-ink-muted">{meta.subtitle}</p>
            {serviceId && initial.source !== "service" && (
              <p className="mt-1 text-[11px] text-blue-700">
                Currently inheriting from {initial.source === "tenant" ? "business default" : "system default"}.
              </p>
            )}
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
              onClick={confirmClose}
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
                  {/* Non-blocking lint panel — flags HTML patterns that
                      email clients strip. Save still proceeds; this is
                      informational. */}
                  {lintFindings.length > 0 && (
                    <div
                      className={
                        "mt-2 rounded-md border p-2.5 text-[11px] " +
                        (hasLintWarnings
                          ? "border-amber-200 bg-amber-50 text-amber-900"
                          : "border-slate-200 bg-slate-50 text-ink-muted")
                      }
                    >
                      <div className="mb-1 font-semibold">
                        {hasLintWarnings ? "HTML may not render in some email clients" : "Notes"}
                      </div>
                      <ul className="ml-4 list-disc space-y-1">
                        {lintFindings.map((f, i) => (
                          <li key={`${f.code}-${i}`}>{f.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
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
                {/* Viewport toggle — same preview HTML, narrower iframe
                    container for the mobile view. Email clients vary
                    so this is approximate, but catches the most common
                    "looks fine on desktop, broken on phone" issues. */}
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-ink-subtle">Viewport:</span>
                  {(["desktop", "mobile"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setPreviewViewport(v)}
                      className={
                        "rounded-md border px-2 py-1 capitalize " +
                        (v === previewViewport
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")
                      }
                    >
                      {v === "desktop" ? "🖥 Desktop" : "📱 Mobile"}
                    </button>
                  ))}
                </div>
                <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-200 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                    HTML preview · sample data
                  </div>
                  <div className="flex justify-center bg-slate-100 p-3">
                    <iframe
                      title="Template preview"
                      srcDoc={previewHtml}
                      className="block h-[480px] border border-slate-200 bg-white shadow-sm"
                      style={{ width: previewViewport === "mobile" ? "360px" : "100%", maxWidth: "100%" }}
                      sandbox=""
                    />
                  </div>
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

              {/* Copy-from picker. Pulls other tenant templates (business
                  + service-scoped) so the admin can clone an existing
                  one into this draft. Selection only mutates local
                  state — admin still has to click Save. */}
              <DuplicateFromPicker
                templateType={initial.templateType}
                serviceId={serviceId}
                onPicked={(values) => {
                  // Copy into draft. Empty fields don't overwrite the
                  // current draft, so picking "subject only" templates
                  // doesn't wipe HTML body.
                  setDraft((cur) => ({
                    ...cur,
                    subject: values.subject || cur.subject,
                    htmlContent: values.htmlContent || cur.htmlContent,
                    textContent: values.textContent || cur.textContent,
                  }));
                  toast("Copied into draft — review and save", "info");
                }}
              />

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
          {serviceId ? (
            initial.source === "service" ? (
              <button
                onClick={restoreDefaults}
                className="text-xs text-ink-muted hover:text-ink"
              >
                ↺ Restore inherited (delete service override)
              </button>
            ) : (
              <span className="text-xs text-ink-subtle">
                Currently inherited — saving will create a service-specific override
              </span>
            )
          ) : (
            <button
              onClick={restoreDefaults}
              disabled={!initial.isCustomized}
              className="text-xs text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {initial.isCustomized ? "↺ Restore default" : "Using system default"}
            </button>
          )}
          <div className="flex items-center gap-2">
            {dirty && !saving && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                Unsaved changes
              </span>
            )}
            <Button variant="secondary" onClick={confirmClose}>Cancel</Button>
            <Button onClick={save} disabled={saving || !dirty}>
              {saving
                ? "Saving…"
                : serviceId && initial.source !== "service"
                  ? "Create override"
                  : "Save changes"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * "Copy from..." picker shown in the editor sidebar. Lists every other
 * row available to this tenant for the SAME template type — business
 * default + any other service overrides — so admins can clone one
 * template's content as a starting point. Cross-tenant impossible:
 * the underlying templates GET only ever returns the caller's tenant.
 *
 * Does NOT save — copies content into the editor's draft so the admin
 * can review and click Save. This preserves the unsaved-changes flow
 * and the optimistic-rollback contract.
 */
function DuplicateFromPicker({
  templateType,
  serviceId,
  onPicked,
}: {
  templateType: TemplateType;
  /** Current editor scope (null = business). Excludes the active row
   *  from the candidate list — duplicating from yourself is a no-op. */
  serviceId: string | null;
  onPicked: (values: { subject: string; htmlContent: string; textContent: string }) => void;
}) {
  type Candidate = {
    label: string;
    serviceId: string | null;
    /** Resolved values from the candidate's GET response. */
    subject: string;
    htmlContent: string;
    textContent: string;
  };
  const [candidates, setCandidates] = React.useState<Candidate[] | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string>("");
  const [loading, setLoading] = React.useState(false);

  // Lazy load on first expand — saves a network call for admins who
  // never use this feature.
  const load = React.useCallback(async () => {
    if (candidates !== null) return; // cached
    setLoading(true);
    try {
      // Step 1: business-default row for this type (always available).
      const businessRes = await fetch("/api/tenant/communications/templates", {
        cache: "no-store",
      });
      const businessRows = (await businessRes.json()) as Row[];
      const businessRow = businessRows.find((r) => r.templateType === templateType);

      // Step 2: per-service rows for this type — only services that
      // ACTUALLY override (overrideCount > 0). Avoids N pointless
      // requests for services that all inherit.
      const servicesRes = await fetch("/api/tenant/communications/services", {
        cache: "no-store",
      });
      const allServices = (await servicesRes.json()) as ServiceOption[];
      const candidateServices = allServices.filter((s) => s.overrideCount > 0);

      const serviceRows = await Promise.all(
        candidateServices.map(async (s) => {
          try {
            const res = await fetch(
              `/api/tenant/communications/templates?serviceId=${encodeURIComponent(s.id)}`,
              { cache: "no-store" }
            );
            if (!res.ok) return null;
            const rows = (await res.json()) as Row[];
            const row = rows.find((r) => r.templateType === templateType);
            // Only include services where THIS template type is actually
            // overridden (otherwise the API returns the inherited
            // tenant/system row — already covered by businessRow).
            if (!row || row.source !== "service") return null;
            return { service: s, row };
          } catch {
            return null;
          }
        })
      );

      const list: Candidate[] = [];
      // Include business default unless we're currently editing it.
      if (businessRow && serviceId !== null) {
        list.push({
          label: "Business default",
          serviceId: null,
          subject: businessRow.subject,
          htmlContent: businessRow.htmlContent,
          textContent: businessRow.textContent,
        });
      }
      for (const r of serviceRows) {
        if (!r) continue;
        // Skip the row we're currently editing.
        if (r.service.id === serviceId) continue;
        list.push({
          label: `Service · ${r.service.name}`,
          serviceId: r.service.id,
          subject: r.row.subject,
          htmlContent: r.row.htmlContent,
          textContent: r.row.textContent,
        });
      }
      setCandidates(list);
    } catch {
      setCandidates([]); // failed — show empty list rather than spin forever
    } finally {
      setLoading(false);
    }
  }, [candidates, serviceId, templateType]);

  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        Copy from another template
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">
        Use an existing template&apos;s body as the starting point. Saves manual copy-paste.
      </p>
      <select
        onClick={load}
        value={selectedKey}
        onChange={(e) => {
          setSelectedKey(e.target.value);
          if (!candidates) return;
          const c = candidates[Number(e.target.value)];
          if (c) onPicked({ subject: c.subject, htmlContent: c.htmlContent, textContent: c.textContent });
          // Reset selection so picking the same one again re-applies.
          setSelectedKey("");
        }}
        className={INPUT + " mt-2 text-xs"}
      >
        <option value="">
          {loading
            ? "Loading…"
            : candidates === null
              ? "— click to load —"
              : candidates.length === 0
                ? "(no other templates of this type)"
                : "— pick a source —"}
        </option>
        {(candidates ?? []).map((c, i) => (
          <option key={`${c.serviceId ?? "biz"}-${i}`} value={i}>
            {c.label}
          </option>
        ))}
      </select>
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
