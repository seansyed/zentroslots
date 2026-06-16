"use client";

/**
 * Wave I — customer-facing intake step.
 *
 * Rendered between "pick time" and "confirm" in BookingFlow.tsx when
 * a service has an active intake form linked. Handles client-side
 * validation; the booking POST always re-validates server-side.
 *
 * Responses are draft-saved to a 15-minute cookie so an accidental
 * refresh doesn't lose work. Cleared on successful submit upstream.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

export type PublicField = {
  key: string;
  label: string;
  type:
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
  required: boolean;
  helpText?: string;
  placeholder?: string;
  options?: string[];
  min?: number;
  max?: number;
  consentText?: string;
  consentLinkUrl?: string;
  consentLinkLabel?: string;
  defaultValue?: unknown;
};

export type PublicForm = {
  id: string;
  name: string;
  description: string | null;
  fields: PublicField[];
};

const COOKIE_NAME = "zm_intake_draft";
const COOKIE_TTL_MS = 15 * 60 * 1000;

function readDraft(formId: string): Record<string, unknown> | null {
  if (typeof document === "undefined") return null;
  try {
    const m = document.cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (!m) return null;
    const decoded = decodeURIComponent(m[1]);
    const parsed = JSON.parse(decoded);
    if (parsed.formId !== formId) return null;
    if (typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > COOKIE_TTL_MS) return null;
    return (parsed.values as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

function writeDraft(formId: string, values: Record<string, unknown>) {
  if (typeof document === "undefined") return;
  try {
    const payload = JSON.stringify({ formId, savedAt: Date.now(), values });
    const ttlSeconds = Math.floor(COOKIE_TTL_MS / 1000);
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(payload)}; path=/; max-age=${ttlSeconds}; samesite=lax`;
  } catch {
    /* ignore */
  }
}

export function clearIntakeDraft() {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
}

/** Public helper: same client-side validation, used both by the
 *  standalone IntakeStep and by BookingFlow when it submits the
 *  combined confirm-step form. Exported so the caller can run it
 *  inline against its existing submit handler. */
export function validateIntakeResponsesClient(
  fields: PublicField[],
  values: Record<string, unknown>,
): Record<string, string> {
  return validateClientSide(fields, values);
}

function validateClientSide(
  fields: PublicField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    const isEmpty =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && v.length === 0) ||
      (f.type === "consent" && v !== true);

    if (f.required && isEmpty) {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (isEmpty) continue;

    switch (f.type) {
      case "email":
        if (typeof v === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
          errors[f.key] = "Enter a valid email";
        }
        break;
      case "url":
        if (typeof v === "string") {
          try {
            new URL(v.trim());
          } catch {
            errors[f.key] = "Enter a valid URL";
          }
        }
        break;
      case "number": {
        const n = typeof v === "number" ? v : Number(String(v));
        if (!Number.isFinite(n)) errors[f.key] = "Must be a number";
        else if (typeof f.min === "number" && n < f.min) errors[f.key] = `Minimum ${f.min}`;
        else if (typeof f.max === "number" && n > f.max) errors[f.key] = `Maximum ${f.max}`;
        break;
      }
    }
  }
  return errors;
}

export default function IntakeStep({
  form,
  onContinue,
  onBack,
  accent = "#2563EB",
}: {
  form: PublicForm;
  onContinue: (values: Record<string, unknown>) => void;
  onBack: () => void;
  accent?: string;
}) {
  // Hydrate from draft on mount (or use defaultValue from field def).
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const draft = readDraft(form.id);
    if (draft) return draft;
    const seed: Record<string, unknown> = {};
    for (const f of form.fields) {
      if (f.defaultValue !== undefined) seed[f.key] = f.defaultValue;
    }
    return seed;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Save draft on every value change.
  useEffect(() => {
    writeDraft(form.id, values);
  }, [form.id, values]);

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const markTouched = useCallback((key: string) => {
    setTouched((prev) => ({ ...prev, [key]: true }));
  }, []);

  const errorList = useMemo(
    () => Object.entries(errors).filter(([k]) => touched[k]),
    [errors, touched],
  );

  function handleContinue() {
    const allTouched: Record<string, boolean> = {};
    for (const f of form.fields) allTouched[f.key] = true;
    setTouched(allTouched);
    const errs = validateClientSide(form.fields, values);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      // Scroll to top of step so the error summary is visible.
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    onContinue(values);
  }

  return (
    <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.06)] sm:p-6">
      <h2 className="text-lg font-semibold text-slate-900">{form.name}</h2>
      {form.description && (
        <p className="mt-1 text-sm text-slate-600">{form.description}</p>
      )}

      {/* Error summary */}
      {errorList.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-medium mb-1">Please fix the following:</div>
          <ul className="list-disc list-inside text-xs space-y-0.5">
            {errorList.map(([k, msg]) => (
              <li key={k}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 space-y-4">
        {form.fields.map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={values[f.key]}
            error={touched[f.key] ? errors[f.key] : undefined}
            onChange={(v) => setValue(f.key, v)}
            onBlur={() => markTouched(f.key)}
            accent={accent}
          />
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={handleContinue}
          className="rounded-lg px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors"
          style={{ backgroundColor: accent }}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

// ─── Field row ────────────────────────────────────────────────────────
// Exported so BookingFlow can render the same fields inline alongside
// the standard Name/Email/Notes inputs in the confirm step.

export function IntakeFieldRow(props: {
  field: PublicField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
  onBlur: () => void;
  accent: string;
}) {
  return <FieldRow {...props} />;
}

function FieldRow({
  field,
  value,
  error,
  onChange,
  onBlur,
  accent,
}: {
  field: PublicField;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
  onBlur: () => void;
  accent: string;
}) {
  // Visual match to BookingFlow's FloatingInput. Rounded-xl, slate
  // border, floating uppercase label at the top of the input. Required
  // status is set as an HTML attribute only — no visible asterisk
  // (matches the codebase convention where Name/Email don't show one).
  const floatingInputClass = `peer w-full rounded-xl border ${
    error ? "border-red-300" : "border-slate-300"
  } bg-white px-3.5 pb-2.5 pt-5 text-[13.5px] text-slate-900 outline-none transition-all duration-[180ms] focus:border-slate-400 focus:ring-2`;
  const floatingInputStyle = {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    ["--tw-ring-color" as any]: error ? "#fca5a5" : accent,
  } as React.CSSProperties;
  const floatingLabelClass =
    "pointer-events-none absolute left-3.5 top-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500";
  const t = field.type;
  const isFloatingType =
    t === "short_text" ||
    t === "long_text" ||
    t === "email" ||
    t === "phone" ||
    t === "number" ||
    t === "url" ||
    t === "date";

  return (
    <div>
      {/* Only non-floating field types render their own label outside
          the input. boolean / consent put the label NEXT to the
          checkbox; select / radio / multi_select keep the label above. */}
      {!isFloatingType && t !== "boolean" && t !== "consent" && (
        <label
          htmlFor={field.key}
          className="block text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500 mb-1.5"
        >
          {field.label}
        </label>
      )}

      {(() => {
        switch (field.type) {
          case "short_text":
            return (
              <div className="relative">
                <input
                  id={field.key}
                  type="text"
                  value={(value as string) ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  placeholder={field.placeholder ?? " "}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "long_text":
            return (
              <div className="relative">
                <textarea
                  id={field.key}
                  value={(value as string) ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  placeholder={field.placeholder ?? " "}
                  rows={3}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "email":
            return (
              <div className="relative">
                <input
                  id={field.key}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={(value as string) ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  placeholder={field.placeholder ?? " "}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "phone":
            return (
              <div className="relative">
                <input
                  id={field.key}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={(value as string) ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  placeholder={field.placeholder ?? " "}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "url":
            return (
              <div className="relative">
                <input
                  id={field.key}
                  type="url"
                  inputMode="url"
                  value={(value as string) ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  placeholder={field.placeholder ?? " "}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "number":
            return (
              <div className="relative">
                <input
                  id={field.key}
                  type="number"
                  inputMode="numeric"
                  value={(value as number | string) ?? ""}
                  min={field.min}
                  max={field.max}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  placeholder={field.placeholder ?? " "}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "date":
            return (
              <div className="relative">
                <input
                  id={field.key}
                  type="date"
                  value={(value as string) ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  onBlur={onBlur}
                  required={field.required}
                  className={floatingInputClass}
                  style={floatingInputStyle}
                />
                <label htmlFor={field.key} className={floatingLabelClass}>
                  {field.label}
                </label>
              </div>
            );
          case "select":
            return (
              <select
                id={field.key}
                value={(value as string) ?? ""}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
                required={field.required}
                className={`w-full rounded-xl border ${
                  error ? "border-red-300" : "border-slate-300"
                } bg-white px-3.5 py-2.5 text-[13.5px] text-slate-900 outline-none transition-all focus:border-slate-400 focus:ring-2`}
                style={floatingInputStyle}
              >
                <option value="">— select —</option>
                {(field.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            );
          case "radio":
            return (
              <div className="space-y-1.5">
                {(field.options ?? []).map((opt) => (
                  <label key={opt} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name={field.key}
                      value={opt}
                      checked={value === opt}
                      onChange={() => onChange(opt)}
                      onBlur={onBlur}
                      className="h-4 w-4"
                      style={{ accentColor: accent }}
                    />
                    <span className="text-sm text-slate-700">{opt}</span>
                  </label>
                ))}
              </div>
            );
          case "multi_select": {
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <div className="space-y-1.5">
                {(field.options ?? []).map((opt) => {
                  const checked = selected.includes(opt);
                  return (
                    <label key={opt} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? selected.filter((s) => s !== opt)
                            : [...selected, opt];
                          onChange(next);
                        }}
                        onBlur={onBlur}
                        className="h-4 w-4"
                        style={{ accentColor: accent }}
                      />
                      <span className="text-sm text-slate-700">{opt}</span>
                    </label>
                  );
                })}
              </div>
            );
          }
          case "boolean":
            return (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => onChange(e.target.checked)}
                  onBlur={onBlur}
                  required={field.required}
                  className="h-4 w-4 mt-0.5"
                  style={{ accentColor: accent }}
                />
                <span className="text-[13.5px] text-slate-800">{field.label}</span>
              </label>
            );
          case "consent":
            return (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => onChange(e.target.checked)}
                  onBlur={onBlur}
                  required={field.required}
                  className="h-4 w-4 mt-0.5"
                  style={{ accentColor: accent }}
                />
                <span className="text-[13.5px] text-slate-800">
                  {field.consentText ?? field.label}
                  {field.consentLinkUrl && (
                    <>
                      {" "}
                      <a
                        href={field.consentLinkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline text-blue-600 hover:text-blue-800"
                      >
                        {field.consentLinkLabel ?? "Read more"}
                      </a>
                    </>
                  )}
                </span>
              </label>
            );
        }
      })()}

      {field.helpText && !error && (
        <p className="mt-1 text-xs text-slate-500">{field.helpText}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
