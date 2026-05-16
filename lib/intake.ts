import { z } from "zod";

/**
 * Canonical intake-form field schema. Stored as JSON on intake_forms.fields
 * and validated server-side both at form-save time and at booking-submit time.
 */

export const FIELD_TYPES = ["text", "textarea", "select", "checkbox", "radio", "date", "phone"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const intakeFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/i, "lowercase alphanumeric / underscore"),
  label: z.string().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  help: z.string().max(500).optional(),
  options: z.array(z.string().min(1).max(120)).optional(), // for select / radio / checkbox
});

export const intakeFormSchema = z.object({
  name: z.string().min(1).max(120),
  fields: z.array(intakeFieldSchema).max(40),
  isActive: z.boolean().default(true),
});

export type IntakeField = z.infer<typeof intakeFieldSchema>;
export type IntakeFormPayload = z.infer<typeof intakeFormSchema>;

/**
 * Validate a booking's submitted intake responses against a form definition.
 * Returns a normalised record keyed by field.key, or throws.
 */
export function validateResponses(
  fields: IntakeField[],
  raw: unknown
): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Intake responses must be an object");
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const val = input[f.key];
    const isEmpty =
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "") ||
      (Array.isArray(val) && val.length === 0);
    if (f.required && isEmpty) {
      throw new Error(`Missing required field: ${f.label}`);
    }
    if (isEmpty) continue;

    switch (f.type) {
      case "text":
      case "textarea":
      case "phone":
      case "date":
        if (typeof val !== "string") throw new Error(`${f.label} must be a string`);
        out[f.key] = val;
        break;
      case "select":
      case "radio":
        if (typeof val !== "string") throw new Error(`${f.label} must be a string`);
        if (f.options && !f.options.includes(val)) throw new Error(`Invalid value for ${f.label}`);
        out[f.key] = val;
        break;
      case "checkbox": {
        // checkbox group → array of strings, must all be in options
        const arr = Array.isArray(val) ? val : [val];
        for (const v of arr) {
          if (typeof v !== "string") throw new Error(`${f.label} must be a string list`);
          if (f.options && !f.options.includes(v)) throw new Error(`Invalid value for ${f.label}`);
        }
        out[f.key] = arr;
        break;
      }
    }
  }
  return out;
}
