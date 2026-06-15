/**
 * Intake-form types + pure helpers (Wave I parity for mobile).
 *
 * Dependency-free so it is unit-testable under node (tsx) and safe to import
 * anywhere. The canonical intake system is server-owned: a service may link an
 * active `intakeForms` row (services.intakeFormId); its `fields` JSONB defines
 * the questions; answers are validated + dual-written server-side on booking.
 * Mobile mirrors the web (components/booking/IntakeStep.tsx) — it NEVER defines
 * its own field model, and the server re-validates authoritatively
 * (lib/intake.ts validateResponses).
 *
 * Network access lives in src/api/intake.ts (intakeApi.getForm), which imports
 * the shared client; keep it out of this file so tests don't pull RN/expo.
 */

/** The 12 canonical field types (lib/intake.ts FIELD_TYPES_CANONICAL). The
 *  public endpoint already canonicalizes legacy aliases, but we defensively
 *  canonicalize again so a directly-stored legacy type never breaks rendering. */
export type IntakeFieldType =
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

/** One field definition — mirrors components/booking/IntakeStep.tsx PublicField. */
export type IntakeField = {
  key: string;
  label: string;
  type: IntakeFieldType;
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
  defaultValue?: unknown;
};

/** A service's render-ready intake form — mirrors PublicForm. */
export type IntakeForm = {
  id: string;
  name: string;
  description: string | null;
  fields: IntakeField[];
};

/** A submitted answer, read back for appointment detail. */
export type IntakeAnswer = {
  fieldKey: string;
  fieldLabel: string;
  fieldType: string;
  value: unknown;
};

const LEGACY_TO_CANONICAL: Record<string, IntakeFieldType> = {
  text: "short_text",
  textarea: "long_text",
  checkbox: "multi_select",
};

export function canonicalType(t: string): IntakeFieldType {
  return (LEGACY_TO_CANONICAL[t] ?? t) as IntakeFieldType;
}

/** Canonicalize legacy field types + sort by `order` (defensive: the public
 *  endpoint already does both, but a directly-stored legacy form must still
 *  render). Stable for equal `order` values. */
export function normalizeFormFields(fields: IntakeField[]): IntakeField[] {
  return fields
    .map((f) => ({ ...f, type: canonicalType(f.type as unknown as string) }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Seed initial values from each field's defaultValue (matches web IntakeStep).
 *  For option-based fields, only seed a default that is a CURRENT option — a
 *  stale/misconfigured default that isn't in `options` can't be shown selected
 *  and would be rejected by the server ("Invalid value for ..."), so we drop it
 *  rather than silently submitting an un-fixable value. */
export function seedIntakeDefaults(fields: IntakeField[]): Record<string, unknown> {
  const seed: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.defaultValue === undefined) continue;
    if (f.type === "select" || f.type === "radio") {
      if (typeof f.defaultValue === "string" && (f.options ?? []).includes(f.defaultValue)) {
        seed[f.key] = f.defaultValue;
      }
      continue;
    }
    if (f.type === "multi_select") {
      const opts = f.options ?? [];
      const arr = Array.isArray(f.defaultValue)
        ? (f.defaultValue as unknown[]).filter(
            (x): x is string => typeof x === "string" && opts.includes(x),
          )
        : [];
      if (arr.length > 0) seed[f.key] = arr;
      continue;
    }
    seed[f.key] = f.defaultValue;
  }
  return seed;
}

function isEmptyValue(field: IntakeField, v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0) ||
    (field.type === "consent" && v !== true)
  );
}

/**
 * Client-side mirror of the server validator (lib/intake.ts validateResponses
 * + web IntakeStep.validateIntakeResponsesClient). Returns a map of
 * fieldKey → message. The server re-validates authoritatively; this just
 * prevents avoidable round-trips and lets us show the error under the field.
 */
export function validateIntakeResponses(
  fields: IntakeField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isEmptyValue(f, v)) {
      if (f.required) errors[f.key] = `${f.label} is required`;
      continue;
    }
    switch (f.type) {
      case "email":
        if (typeof v === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
          errors[f.key] = "Enter a valid email";
        }
        break;
      case "url":
        // Hermes-safe: RN's built-in `URL` is non-spec and does NOT throw on
        // malformed input, so the web's `new URL()` check is a no-op on device
        // (it would pass garbage the server then rejects). Use a scheme://host
        // regex that behaves identically on Hermes + Node and matches what the
        // server's `new URL()` accepts for the realistic case.
        if (typeof v === "string" && !/^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(v.trim())) {
          errors[f.key] = "Enter a valid URL";
        }
        break;
      case "number": {
        const n = typeof v === "number" ? v : Number(String(v));
        if (!Number.isFinite(n)) errors[f.key] = "Must be a number";
        else if (typeof f.min === "number" && n < f.min) errors[f.key] = `Minimum ${f.min}`;
        else if (typeof f.max === "number" && n > f.max) errors[f.key] = `Maximum ${f.max}`;
        break;
      }
      case "select":
      case "radio":
        // Option-membership parity with the server (lib/intake.ts:249). The
        // renderer only emits valid options, so this is defense-in-depth.
        if (typeof v === "string" && f.options && !f.options.includes(v)) {
          errors[f.key] = `Invalid value for ${f.label}`;
        }
        break;
      case "multi_select":
        if (Array.isArray(v) && f.options) {
          const bad = (v as unknown[]).some(
            (x) => typeof x !== "string" || !f.options!.includes(x),
          );
          if (bad) errors[f.key] = `Invalid value for ${f.label}`;
        }
        break;
      case "date":
        // The server treats date as a plain string; mobile enforces the ISO
        // shape so a free-text entry can't store garbage (Hermes-safe — no
        // Intl/Date parsing).
        if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
          errors[f.key] = "Use format YYYY-MM-DD";
        }
        break;
    }
  }
  return errors;
}

/**
 * Build the wire payload from the in-progress values: include ONLY non-empty
 * answers for fields in THIS form (mirroring the server's isEmpty skip), so we
 * never submit empty, hidden, or stale (other-service) values. Strings are
 * trimmed; booleans/arrays/numbers pass through.
 */
export function buildIntakePayload(
  fields: IntakeField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    // boolean false is a real answer; everything else uses the shared empties.
    const empty =
      f.type === "boolean" ? v !== true && v !== false : isEmptyValue(f, v);
    if (empty) continue;
    out[f.key] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/** Human-readable rendering of a stored answer for appointment detail. */
export function formatIntakeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((x) => String(x)).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "";
  return String(value);
}
