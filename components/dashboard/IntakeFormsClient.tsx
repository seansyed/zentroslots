"use client";

/**
 * Wave I — admin intake form builder.
 *
 * Two-pane layout (locked): form list on the left, editor on the right.
 * Native HTML5 drag-and-drop for field reordering. Plan-aware field
 * counter + type whitelist enforcement. Live "Preview as buyer" mode.
 *
 * Security: never displays raw user-submitted PII. Edits the form
 * DEFINITION only.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Eye,
  GripVertical,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

import IntakeStep, {
  type PublicField,
  type PublicForm,
} from "@/components/booking/IntakeStep";

type FieldType =
  | "short_text"
  | "long_text"
  | "email"
  | "phone"
  | "number"
  | "url"
  | "select"
  | "multi_select"
  | "radio"
  | "date"
  | "boolean"
  | "consent";

interface AdminField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  helpText?: string;
  placeholder?: string;
  options?: string[];
  min?: number;
  max?: number;
  order?: number;
  consentText?: string;
  consentLinkUrl?: string;
  consentLinkLabel?: string;
}

interface AdminForm {
  id: string;
  name: string;
  description: string | null;
  fields: AdminField[];
  isActive: boolean;
  submissionCount: number;
  usedByServicesCount: number;
  createdAt: string;
  updatedAt: string;
}

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  email: "Email",
  phone: "Phone",
  number: "Number",
  url: "URL",
  select: "Single-select",
  multi_select: "Multi-select",
  radio: "Radio",
  date: "Date",
  boolean: "Checkbox",
  consent: "Consent",
};

const ALL_FIELD_TYPES: FieldType[] = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

function slugifyKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "field";
}

interface Props {
  planId: string;
  planName: string;
  maxFields: number;
  typeWhitelist: FieldType[] | null;
}

export default function IntakeFormsClient({
  planId,
  planName,
  maxFields,
  typeWhitelist,
}: Props) {
  const [forms, setForms] = useState<AdminForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdminForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tenant/intake-forms", { cache: "no-store" });
      if (!res.ok) throw new Error("Load failed");
      const data = await res.json();
      setForms((data.forms ?? []) as AdminForm[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Auto-clear toasts.
  useEffect(() => {
    if (!error && !success) return;
    const t = setTimeout(() => {
      setError(null);
      setSuccess(null);
    }, 5000);
    return () => clearTimeout(t);
  }, [error, success]);

  // When selection changes, hydrate the draft from the source row.
  useEffect(() => {
    if (!selectedId) {
      setDraft(null);
      setDirty(false);
      return;
    }
    const src = forms.find((f) => f.id === selectedId);
    if (src) {
      setDraft({ ...src, fields: [...src.fields] });
      setDirty(false);
      setPreviewMode(false);
    }
  }, [selectedId, forms]);

  const fieldCount = draft?.fields.length ?? 0;
  const atLimit = maxFields >= 0 && fieldCount >= maxFields;
  const overLimit = maxFields >= 0 && fieldCount > maxFields;

  const allowedTypes = useMemo<FieldType[]>(() => {
    if (!typeWhitelist) return ALL_FIELD_TYPES;
    return typeWhitelist;
  }, [typeWhitelist]);

  async function createNew() {
    setError(null);
    try {
      const res = await fetch("/api/tenant/intake-forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Untitled form",
          description: "",
          fields: [],
          isActive: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Create failed");
        return;
      }
      await loadAll();
      setSelectedId(data.form.id);
      setSuccess("Form created. Add your first field.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenant/intake-forms/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description ?? "",
          fields: draft.fields,
          isActive: draft.isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Save failed");
        return;
      }
      setSuccess("Saved.");
      setDirty(false);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function duplicateForm(id: string) {
    try {
      const res = await fetch(`/api/tenant/intake-forms/${id}/duplicate`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Duplicate failed");
        return;
      }
      await loadAll();
      setSelectedId(data.form.id);
      setSuccess("Form duplicated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Duplicate failed");
    }
  }

  async function deleteForm(id: string) {
    if (!confirm("Delete this form? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/tenant/intake-forms/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Delete failed");
        return;
      }
      setSuccess("Deleted.");
      setSelectedId(null);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function addField() {
    if (!draft) return;
    if (atLimit) {
      setError(
        `Your ${planName} plan allows up to ${maxFields} field${maxFields === 1 ? "" : "s"}. Upgrade for more.`,
      );
      return;
    }
    const baseType: FieldType = allowedTypes[0] ?? "short_text";
    const newField: AdminField = {
      key: `field_${draft.fields.length + 1}`,
      label: "New field",
      type: baseType,
      required: false,
      order: draft.fields.length,
    };
    setDraft({ ...draft, fields: [...draft.fields, newField] });
    setDirty(true);
  }

  function updateField(idx: number, patch: Partial<AdminField>) {
    if (!draft) return;
    const next = [...draft.fields];
    next[idx] = { ...next[idx], ...patch };
    setDraft({ ...draft, fields: next });
    setDirty(true);
  }

  function removeField(idx: number) {
    if (!draft) return;
    const next = draft.fields.filter((_, i) => i !== idx);
    // Re-index `order`.
    next.forEach((f, i) => (f.order = i));
    setDraft({ ...draft, fields: next });
    setDirty(true);
  }

  function moveField(from: number, to: number) {
    if (!draft) return;
    if (to < 0 || to >= draft.fields.length) return;
    const next = [...draft.fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    next.forEach((f, i) => (f.order = i));
    setDraft({ ...draft, fields: next });
    setDirty(true);
  }

  // Render-ready PublicForm for preview mode.
  const previewForm = useMemo<PublicForm | null>(() => {
    if (!draft) return null;
    return {
      id: draft.id,
      name: draft.name,
      description: draft.description,
      fields: draft.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        helpText: f.helpText,
        placeholder: f.placeholder,
        options: f.options,
        min: f.min,
        max: f.max,
        consentText: f.consentText,
        consentLinkUrl: f.consentLinkUrl,
        consentLinkLabel: f.consentLinkLabel,
      })) as PublicField[],
    };
  }, [draft]);

  return (
    <div className="space-y-4">
      {/* Plan strip */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Intake forms</h2>
          <p className="text-sm text-slate-600">
            Reusable forms attachable to any service. Customers fill them during booking;
            responses persist on the appointment.
          </p>
        </div>
        <div className="text-xs text-slate-600 text-right">
          <div>Plan: <span className="font-medium text-slate-900">{planName}</span></div>
          <div>
            Field cap: {maxFields < 0 ? "Unlimited" : `${maxFields} per form`}
          </div>
          {typeWhitelist && (
            <div className="mt-1 text-amber-700">
              Limited field types on this plan
            </div>
          )}
        </div>
      </div>

      {/* Toasts */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="h-4 w-4 text-red-600" /></button>
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-start gap-2">
          <Check className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess(null)}><X className="h-4 w-4 text-emerald-600" /></button>
        </div>
      )}

      {/* Two-pane */}
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        {/* Left pane — form list */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-3">
            <button
              type="button"
              onClick={createNew}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" /> New form
            </button>
          </div>
          <div className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-slate-500 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : forms.length === 0 ? (
              <div className="p-6 text-sm text-slate-500 italic text-center">
                No forms yet.
              </div>
            ) : (
              forms.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedId(f.id)}
                  className={`w-full text-left p-3 hover:bg-slate-50 transition-colors ${
                    selectedId === f.id ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="font-medium text-slate-900 truncate">{f.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                    <span>{f.fields.length} field{f.fields.length === 1 ? "" : "s"}</span>
                    {!f.isActive && (
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">
                        disabled
                      </span>
                    )}
                    {f.usedByServicesCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] border border-blue-200">
                        used by {f.usedByServicesCount}
                      </span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right pane — editor */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm min-h-[60vh]">
          {!draft ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {forms.length === 0
                ? "Click \"New form\" to get started."
                : "Pick a form from the list to edit."}
            </div>
          ) : previewMode && previewForm ? (
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div className="text-sm text-slate-600">
                  <Eye className="inline h-3.5 w-3.5 mr-1" /> Preview as buyer
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewMode(false)}
                  className="text-xs text-slate-600 hover:text-slate-900"
                >
                  Back to edit
                </button>
              </div>
              <div className="max-w-xl mx-auto">
                <IntakeStep
                  form={previewForm}
                  onBack={() => setPreviewMode(false)}
                  onContinue={() => setPreviewMode(false)}
                />
              </div>
            </div>
          ) : (
            <div className="p-5 space-y-5">
              {/* Header */}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => {
                      setDraft({ ...draft, name: e.target.value });
                      setDirty(true);
                    }}
                    placeholder="Form name"
                    className="w-full text-lg font-semibold text-slate-900 border-0 border-b border-transparent hover:border-slate-300 focus:border-slate-900 focus:outline-none px-0 py-1 bg-transparent"
                  />
                  <input
                    type="text"
                    value={draft.description ?? ""}
                    onChange={(e) => {
                      setDraft({ ...draft, description: e.target.value });
                      setDirty(true);
                    }}
                    placeholder="Description (optional, shown to customers)"
                    className="w-full text-sm text-slate-600 border-0 border-b border-transparent hover:border-slate-200 focus:border-slate-700 focus:outline-none px-0 py-1 bg-transparent mt-1"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-600 cursor-pointer flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={draft.isActive}
                      onChange={(e) => {
                        setDraft({ ...draft, isActive: e.target.checked });
                        setDirty(true);
                      }}
                      className="h-3.5 w-3.5"
                    />
                    Active
                  </label>
                  <button
                    type="button"
                    onClick={() => duplicateForm(draft.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    title="Duplicate"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteForm(draft.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Field count + actions */}
              <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
                <div className="text-slate-600">
                  Fields:{" "}
                  <span className={overLimit ? "text-red-700 font-medium" : "text-slate-900 font-medium"}>
                    {fieldCount}{maxFields >= 0 ? ` / ${maxFields}` : ""}
                  </span>
                  {atLimit && !overLimit && (
                    <span className="ml-2 text-amber-700">at plan limit</span>
                  )}
                  {overLimit && (
                    <span className="ml-2 text-red-700">over plan limit — remove some to save</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewMode(true)}
                    disabled={fieldCount === 0}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Eye className="h-3.5 w-3.5" /> Preview
                  </button>
                  <button
                    type="button"
                    onClick={saveDraft}
                    disabled={!dirty || saving || overLimit}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save
                  </button>
                </div>
              </div>

              {/* Field list */}
              <div className="space-y-2">
                {draft.fields.map((f, idx) => (
                  <FieldCard
                    key={f.key + idx}
                    field={f}
                    index={idx}
                    total={draft.fields.length}
                    allowedTypes={allowedTypes}
                    onChange={(patch) => updateField(idx, patch)}
                    onRemove={() => removeField(idx)}
                    onMove={(dir) => moveField(idx, idx + dir)}
                    onReorder={(toIdx) => moveField(idx, toIdx)}
                  />
                ))}
              </div>

              <button
                type="button"
                onClick={addField}
                disabled={atLimit}
                className="inline-flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed w-full justify-center"
              >
                <Plus className="h-4 w-4" />
                {atLimit ? "Plan limit reached" : "Add field"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Field card ───────────────────────────────────────────────────────

function FieldCard({
  field,
  index,
  total,
  allowedTypes,
  onChange,
  onRemove,
  onMove,
  onReorder,
}: {
  field: AdminField;
  index: number;
  total: number;
  allowedTypes: FieldType[];
  onChange: (patch: Partial<AdminField>) => void;
  onRemove: () => void;
  onMove: (direction: 1 | -1) => void;
  onReorder: (toIdx: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);

  const needsOptions =
    field.type === "select" || field.type === "multi_select" || field.type === "radio";

  return (
    <div
      className={`rounded-lg border bg-white transition-colors ${
        dragging ? "border-blue-400 bg-blue-50/50" : "border-slate-200"
      }`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(index));
        e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (Number.isFinite(from) && from !== index) onReorder(index);
      }}
    >
      {/* Compact header row */}
      <div className="flex items-center gap-2 p-2">
        <GripVertical className="h-4 w-4 text-slate-400 cursor-grab flex-shrink-0" />
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
          <span className="font-medium text-slate-900 text-sm truncate">
            {field.label || "Untitled field"}
            {field.required && <span className="text-red-600 ml-0.5">*</span>}
          </span>
          <span className="text-xs text-slate-500 flex-shrink-0">
            {FIELD_TYPE_LABELS[field.type]}
          </span>
        </button>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            title="Move up"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            title="Move down"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-red-400 hover:text-red-700"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded editor */}
      {expanded && (
        <div className="border-t border-slate-200 p-3 space-y-3 bg-slate-50/40">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Label</label>
              <input
                type="text"
                value={field.label}
                onChange={(e) => {
                  const label = e.target.value;
                  // Auto-update key if user hasn't customized it.
                  const newPatch: Partial<AdminField> = { label };
                  if (field.key.startsWith("field_") || field.key === slugifyKey(field.label)) {
                    newPatch.key = slugifyKey(label);
                  }
                  onChange(newPatch);
                }}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Type</label>
              <select
                value={field.type}
                onChange={(e) => onChange({ type: e.target.value as FieldType })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm bg-white"
              >
                {allowedTypes.map((t) => (
                  <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Help text (optional)
            </label>
            <input
              type="text"
              value={field.helpText ?? ""}
              onChange={(e) => onChange({ helpText: e.target.value || undefined })}
              placeholder="Shown below the input"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>

          {field.type !== "boolean" && field.type !== "consent" && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Placeholder (optional)
              </label>
              <input
                type="text"
                value={field.placeholder ?? ""}
                onChange={(e) => onChange({ placeholder: e.target.value || undefined })}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
          )}

          {needsOptions && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Options (one per line)
              </label>
              <textarea
                value={(field.options ?? []).join("\n")}
                onChange={(e) =>
                  onChange({
                    options: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                rows={4}
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono"
              />
            </div>
          )}

          {field.type === "number" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Min</label>
                <input
                  type="number"
                  value={field.min ?? ""}
                  onChange={(e) =>
                    onChange({ min: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Max</label>
                <input
                  type="number"
                  value={field.max ?? ""}
                  onChange={(e) =>
                    onChange({ max: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </div>
            </div>
          )}

          {field.type === "consent" && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Consent text <span className="text-red-600">*</span>
                </label>
                <textarea
                  value={field.consentText ?? ""}
                  onChange={(e) => onChange({ consentText: e.target.value })}
                  placeholder="e.g. I agree to the cancellation policy."
                  rows={2}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Link URL (optional)</label>
                  <input
                    type="url"
                    value={field.consentLinkUrl ?? ""}
                    onChange={(e) => onChange({ consentLinkUrl: e.target.value || undefined })}
                    placeholder="https://"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Link label</label>
                  <input
                    type="text"
                    value={field.consentLinkLabel ?? ""}
                    onChange={(e) => onChange({ consentLinkLabel: e.target.value || undefined })}
                    placeholder="Terms of Service"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
            </>
          )}

          <div className="flex items-center gap-4 pt-1">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(e) => onChange({ required: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              Required
            </label>
            <div className="text-[11px] text-slate-500">
              key: <code className="text-slate-700">{field.key}</code>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
