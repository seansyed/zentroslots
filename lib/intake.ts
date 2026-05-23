/**
 * Wave I — canonical intake-form field schema + response validator.
 *
 * The form definition is stored as a JSON array on intake_forms.fields.
 * Responses are persisted to TWO surfaces (dual-write, see persistResponses.ts):
 *   • bookings.intake_responses jsonb — legacy mirror, backward compat
 *   • intake_field_responses table — normalized, queryable, CRM-ready
 *
 * 12 canonical field types + 3 legacy aliases (text/textarea/checkbox)
 * are accepted on read so pre-Wave-I form rows keep working.
 */

import { z } from "zod";

// ─── Field types ──────────────────────────────────────────────────────

/** Canonical Wave I types. */
export const FIELD_TYPES_CANONICAL = [
  "short_text",
  "long_text",
  "email",
  "phone",
  "number",
  "url",
  "select",
  "multi_select",
  "radio",
  "date",
  "boolean",
  "consent",
] as const;

/** Pre-Wave-I aliases — accepted on read, normalized on save. */
export const FIELD_TYPES_LEGACY = [
  "text", // → short_text
  "textarea", // → long_text
  "checkbox", // → multi_select (current "checkbox" was a group)
] as const;

export const FIELD_TYPES = [...FIELD_TYPES_CANONICAL, ...FIELD_TYPES_LEGACY] as const;

export type FieldType = (typeof FIELD_TYPES_CANONICAL)[number];
export type LegacyFieldType = (typeof FIELD_TYPES_LEGACY)[number];

/** Maps legacy → canonical. Idempotent on canonical inputs. */
export function canonicalType(t: string): FieldType {
  if (t === "text") return "short_text";
  if (t === "textarea") return "long_text";
  if (t === "checkbox") return "multi_select";
  return t as FieldType;
}

/** Field types the Free plan is allowed to use. Other tiers: unrestricted. */
export const FREE_TIER_TYPE_WHITELIST: FieldType[] = [
  "short_text",
  "email",
  "phone",
  "boolean",
];

// ─── Per-field schema ─────────────────────────────────────────────────

export const intakeFieldSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,40}$/i, "lowercase alphanumeric / underscore"),
    label: z.string().min(1).max(200),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    /** Multi-line description shown below the label (was `help` pre-Wave-I).
     *  Both keys are accepted on read to keep legacy forms loading. */
    helpText: z.string().max(500).optional(),
    help: z.string().max(500).optional(), // legacy alias
    /** Placeholder text inside the input. Where applicable. */
    placeholder: z.string().max(200).optional(),
    /** select / multi_select / radio options. */
    options: z.array(z.string().min(1).max(120)).optional(),
    /** number type — optional bounds. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** Explicit ordering. When absent, fall back to array index. */
    order: z.number().int().optional(),
    /** consent type — the legal-flavored text shown next to the checkbox. */
    consentText: z.string().max(2000).optional(),
    /** consent type — optional link target ("Terms of Service"). */
    consentLinkUrl: z.string().url().max(500).optional(),
    consentLinkLabel: z.string().max(120).optional(),
    /** Optional default. Type-appropriate. */
    defaultValue: z
      .union([z.string(), z.array(z.string()), z.number(), z.boolean()])
      .optional(),
  })
  .superRefine((data, ctx) => {
    const t = canonicalType(data.type);
    // Type-specific validation.
    if ((t === "select" || t === "multi_select" || t === "radio") && (!data.options || data.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${t} requires at least one option`,
        path: ["options"],
      });
    }
    if (t === "consent" && (!data.consentText || data.consentText.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "consent field requires consentText",
        path: ["consentText"],
      });
    }
    if (
      typeof data.min === "number" &&
      typeof data.max === "number" &&
      data.min > data.max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "min cannot be greater than max",
        path: ["min"],
      });
    }
  });

export const intakeFormSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  fields: z.array(intakeFieldSchema).max(60),
  isActive: z.boolean().default(true),
});

export type IntakeField = z.infer<typeof intakeFieldSchema>;
export type IntakeFormPayload = z.infer<typeof intakeFormSchema>;

// ─── Plan-aware definition validator ──────────────────────────────────

export type PlanIntakeLimits = {
  maxIntakeFields: number; // -1 = unlimited
  typeWhitelist: FieldType[] | null; // null = all types allowed
};

/** Validates a form payload against the tenant's plan limits.
 *  Throws Error with a user-friendly message on violation. */
export function assertFormFitsPlan(
  form: IntakeFormPayload,
  limits: PlanIntakeLimits,
): void {
  if (limits.maxIntakeFields >= 0 && form.fields.length > limits.maxIntakeFields) {
    throw new Error(
      `Your plan allows up to ${limits.maxIntakeFields} field${limits.maxIntakeFields === 1 ? "" : "s"} per form. Remove ${form.fields.length - limits.maxIntakeFields} to save, or upgrade.`,
    );
  }
  if (limits.typeWhitelist) {
    const allowed = new Set(limits.typeWhitelist.map(String));
    for (const f of form.fields) {
      const t = canonicalType(f.type);
      if (!allowed.has(t)) {
        throw new Error(
          `Your plan doesn't include the "${t}" field type. Remove it or upgrade.`,
        );
      }
    }
  }
}

// ─── Response validator ───────────────────────────────────────────────

/** Validates submitted intake responses against a form definition. Returns
 *  a normalised record keyed by field.key. Throws Error on missing/invalid.
 *  Canonical type names (post-Wave-I) and legacy types both validate. */
export function validateResponses(
  fields: IntakeField[],
  raw: unknown,
): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Intake responses must be an object");
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const f of fields) {
    const val = input[f.key];
    const t = canonicalType(f.type);
    const isEmpty =
      val === undefined ||
      val === null ||
      (typeof val === "string" && val.trim() === "") ||
      (Array.isArray(val) && val.length === 0) ||
      (typeof val === "boolean" && t === "consent" && val === false);

    if (f.required && isEmpty) {
      throw new Error(`Missing required field: ${f.label}`);
    }
    if (isEmpty) continue;

    switch (t) {
      case "short_text":
      case "long_text":
      case "phone":
      case "date":
        if (typeof val !== "string") throw new Error(`${f.label} must be text`);
        out[f.key] = val.trim();
        break;

      case "email": {
        if (typeof val !== "string") throw new Error(`${f.label} must be text`);
        const s = val.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
          throw new Error(`${f.label} is not a valid email`);
        }
        out[f.key] = s;
        break;
      }

      case "url": {
        if (typeof val !== "string") throw new Error(`${f.label} must be text`);
        const s = val.trim();
        try {
          // eslint-disable-next-line no-new
          new URL(s);
        } catch {
          throw new Error(`${f.label} is not a valid URL`);
        }
        out[f.key] = s;
        break;
      }

      case "number": {
        const n =
          typeof val === "number"
            ? val
            : typeof val === "string"
            ? Number(val.trim())
            : NaN;
        if (!Number.isFinite(n)) throw new Error(`${f.label} must be a number`);
        if (typeof f.min === "number" && n < f.min) {
          throw new Error(`${f.label} must be at least ${f.min}`);
        }
        if (typeof f.max === "number" && n > f.max) {
          throw new Error(`${f.label} must be at most ${f.max}`);
        }
        out[f.key] = n;
        break;
      }

      case "select":
      case "radio":
        if (typeof val !== "string") throw new Error(`${f.label} must be a string`);
        if (f.options && !f.options.includes(val)) {
          throw new Error(`Invalid value for ${f.label}`);
        }
        out[f.key] = val;
        break;

      case "multi_select": {
        const arr = Array.isArray(val) ? val : [val];
        for (const v of arr) {
          if (typeof v !== "string") throw new Error(`${f.label} must be a string list`);
          if (f.options && !f.options.includes(v)) {
            throw new Error(`Invalid value for ${f.label}`);
          }
        }
        out[f.key] = arr;
        break;
      }

      case "boolean":
        if (typeof val !== "boolean") {
          // Accept "true"/"false" strings for form-encoded bodies.
          if (val === "true") out[f.key] = true;
          else if (val === "false") out[f.key] = false;
          else throw new Error(`${f.label} must be true or false`);
        } else {
          out[f.key] = val;
        }
        break;

      case "consent":
        if (val !== true && val !== "true") {
          // Required-check would have caught false-on-required; but a
          // required consent that wasn't ticked surfaces here too.
          if (f.required) {
            throw new Error(`You must agree to: ${f.label}`);
          }
        } else {
          out[f.key] = true;
        }
        break;
    }
  }
  return out;
}
