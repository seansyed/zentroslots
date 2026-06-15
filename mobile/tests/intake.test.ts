import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildIntakePayload,
  canonicalType,
  formatIntakeValue,
  normalizeFormFields,
  seedIntakeDefaults,
  validateIntakeResponses,
  type IntakeField,
} from "../src/lib/intake";

/**
 * Service-template intake fields in mobile New Booking. These pin the client
 * mirror of the server contract (lib/intake.ts). The server re-validates
 * authoritatively; these guard the mobile layer that previously didn't exist
 * (root cause: mobile never collected/sent intakeResponses, so a required
 * "Filing Status" 400'd the booking).
 */

const f = (over: Partial<IntakeField> & Pick<IntakeField, "key" | "label" | "type">): IntakeField => ({
  required: false,
  ...over,
});

// A realistic Individual Tax Return form (mirrors lib/templates.ts tax intake).
const TAX_FORM: IntakeField[] = [
  f({ key: "filing_status", label: "Filing status", type: "select", required: true,
      options: ["Single", "Married Filing Jointly", "Head of Household"] }),
  f({ key: "tax_year", label: "Tax year", type: "number", required: false, min: 2010, max: 2026 }),
  f({ key: "has_dependents", label: "Dependents?", type: "radio", required: true, options: ["Yes", "No"] }),
];

test("service with no fields → no errors, empty payload", () => {
  assert.deepEqual(validateIntakeResponses([], {}), {});
  assert.deepEqual(buildIntakePayload([], {}), {});
});

test("REGRESSION: required Filing Status blocks until selected, then booking payload carries it", () => {
  // Empty → the exact failure the user hit, now caught client-side and mapped
  // to the field (not a generic banner).
  const empty = validateIntakeResponses(TAX_FORM, {});
  assert.equal(empty.filing_status, "Filing status is required");
  assert.equal(empty.has_dependents, "Dependents? is required");

  // User selects a value → no errors → payload keyed by field.key.
  const values = { filing_status: "Married Filing Jointly", has_dependents: "No" };
  assert.deepEqual(validateIntakeResponses(TAX_FORM, values), {});
  assert.deepEqual(buildIntakePayload(TAX_FORM, values), {
    filing_status: "Married Filing Jointly",
    has_dependents: "No",
  });
});

test("optional number (Tax Year): empty ok; non-number, min, max enforced", () => {
  assert.equal(validateIntakeResponses(TAX_FORM, { filing_status: "Single", has_dependents: "No" }).tax_year, undefined);
  assert.equal(
    validateIntakeResponses(TAX_FORM, { filing_status: "Single", has_dependents: "No", tax_year: "abc" }).tax_year,
    "Must be a number",
  );
  assert.equal(
    validateIntakeResponses(TAX_FORM, { filing_status: "Single", has_dependents: "No", tax_year: 2009 }).tax_year,
    "Minimum 2010",
  );
  assert.equal(
    validateIntakeResponses(TAX_FORM, { filing_status: "Single", has_dependents: "No", tax_year: 2027 }).tax_year,
    "Maximum 2026",
  );
  // A valid numeric string passes and is preserved in the payload.
  const ok = { filing_status: "Single", has_dependents: "No", tax_year: "2025" };
  assert.deepEqual(validateIntakeResponses(TAX_FORM, ok), {});
  assert.equal(buildIntakePayload(TAX_FORM, ok).tax_year, "2025");
});

test("text + email + url + date field validation", () => {
  const fields: IntakeField[] = [
    f({ key: "name", label: "Name", type: "short_text", required: true }),
    f({ key: "email", label: "Email", type: "email", required: false }),
    f({ key: "site", label: "Website", type: "url", required: false }),
    f({ key: "start", label: "Start date", type: "date", required: false }),
  ];
  assert.equal(validateIntakeResponses(fields, {}).name, "Name is required");
  assert.equal(validateIntakeResponses(fields, { name: "A", email: "nope" }).email, "Enter a valid email");
  assert.equal(validateIntakeResponses(fields, { name: "A", site: "not a url" }).site, "Enter a valid URL");
  // Hermes-safe: a scheme-less host must be rejected by the regex. (RN's
  // built-in URL doesn't throw, so the old new-URL() check passed this on
  // device while the server 400'd it.)
  assert.equal(validateIntakeResponses(fields, { name: "A", site: "example.com" }).site, "Enter a valid URL");
  assert.equal(validateIntakeResponses(fields, { name: "A", start: "07/01/2026" }).start, "Use format YYYY-MM-DD");
  // All valid → clean, and strings are trimmed in the payload.
  const ok = { name: "  Jane  ", email: "jane@example.com", site: "https://x.io", start: "2026-07-01" };
  assert.deepEqual(validateIntakeResponses(fields, ok), {});
  assert.equal(buildIntakePayload(fields, ok).name, "Jane");
});

test("option-membership parity: an off-options select/multi_select value is rejected client-side", () => {
  const fields: IntakeField[] = [
    f({ key: "fs", label: "Filing status", type: "select", required: true, options: ["Single", "MFJ"] }),
    f({ key: "st", label: "States", type: "multi_select", required: false, options: ["CA", "NY"] }),
  ];
  assert.equal(validateIntakeResponses(fields, { fs: "Bogus" }).fs, "Invalid value for Filing status");
  assert.equal(validateIntakeResponses(fields, { fs: "Single", st: ["CA", "ZZ"] }).st, "Invalid value for States");
  assert.deepEqual(validateIntakeResponses(fields, { fs: "Single", st: ["CA"] }), {});
});

test("multi_select stores + submits an array; boolean false is a real answer", () => {
  const fields: IntakeField[] = [
    f({ key: "states", label: "States", type: "multi_select", required: true, options: ["CA", "NY", "TX"] }),
    f({ key: "efile", label: "E-file?", type: "boolean", required: false }),
  ];
  assert.equal(validateIntakeResponses(fields, { states: [] }).states, "States is required");
  const values = { states: ["CA", "NY"], efile: false };
  assert.deepEqual(validateIntakeResponses(fields, values), {});
  const payload = buildIntakePayload(fields, values);
  assert.deepEqual(payload.states, ["CA", "NY"]);
  assert.equal(payload.efile, false); // boolean false is preserved, not dropped
});

test("required consent must be ticked; payload includes it only when true", () => {
  const fields: IntakeField[] = [
    f({ key: "tos", label: "Agree to terms", type: "consent", required: true, consentText: "I agree" }),
  ];
  assert.equal(validateIntakeResponses(fields, { tos: false }).tos, "Agree to terms is required");
  assert.equal(validateIntakeResponses(fields, {}).tos, "Agree to terms is required");
  assert.deepEqual(validateIntakeResponses(fields, { tos: true }), {});
  assert.equal(buildIntakePayload(fields, { tos: false }).tos, undefined); // not submitted when unticked
  assert.equal(buildIntakePayload(fields, { tos: true }).tos, true);
});

test("changing service: stale answers for other-form keys are never submitted", () => {
  // intakeValues may still hold a previous service's key; buildIntakePayload
  // iterates only the CURRENT form's fields, so the stale key is dropped.
  const businessForm: IntakeField[] = [
    f({ key: "entity_type", label: "Entity type", type: "select", required: true, options: ["LLC", "S Corp"] }),
  ];
  const stale = { filing_status: "Single", entity_type: "LLC" };
  assert.deepEqual(buildIntakePayload(businessForm, stale), { entity_type: "LLC" });
});

test("validation error maps to the correct field key", () => {
  const errs = validateIntakeResponses(TAX_FORM, { filing_status: "Single" });
  assert.ok("has_dependents" in errs);
  assert.ok(!("filing_status" in errs));
});

test("normalizeFormFields canonicalizes legacy types + sorts by order", () => {
  const raw: IntakeField[] = [
    f({ key: "c", label: "C", type: "textarea" as IntakeField["type"], order: 3 }),
    f({ key: "a", label: "A", type: "text" as IntakeField["type"], order: 1 }),
    f({ key: "b", label: "B", type: "checkbox" as IntakeField["type"], order: 2, options: ["x"] }),
  ];
  const out = normalizeFormFields(raw);
  assert.deepEqual(out.map((x) => x.key), ["a", "b", "c"]); // sorted by order
  assert.equal(out[0].type, "short_text"); // text → short_text
  assert.equal(out[1].type, "multi_select"); // checkbox → multi_select
  assert.equal(out[2].type, "long_text"); // textarea → long_text
  assert.equal(canonicalType("select"), "select"); // canonical passthrough
});

test("seedIntakeDefaults seeds only fields that declare a default", () => {
  const fields: IntakeField[] = [
    f({ key: "a", label: "A", type: "short_text", defaultValue: "hi" }),
    f({ key: "b", label: "B", type: "number" }),
  ];
  assert.deepEqual(seedIntakeDefaults(fields), { a: "hi" });
});

test("seedIntakeDefaults drops option-based defaults that aren't current options", () => {
  const fields: IntakeField[] = [
    // default IS a valid option → kept
    f({ key: "good", label: "Good", type: "select", options: ["A", "B"], defaultValue: "A" }),
    // default NOT in options → dropped (would 400 server-side + show nothing selected)
    f({ key: "stale", label: "Stale", type: "radio", options: ["X", "Y"], defaultValue: "Z" }),
    // multi_select default filtered to the valid intersection
    f({ key: "multi", label: "Multi", type: "multi_select", options: ["CA", "NY"], defaultValue: ["CA", "ZZ"] }),
    // multi_select default with no valid options → dropped entirely
    f({ key: "multiBad", label: "MultiBad", type: "multi_select", options: ["CA"], defaultValue: ["ZZ"] }),
  ];
  assert.deepEqual(seedIntakeDefaults(fields), { good: "A", multi: ["CA"] });
});

test("formatIntakeValue renders answers for appointment detail", () => {
  assert.equal(formatIntakeValue("Married Filing Jointly"), "Married Filing Jointly");
  assert.equal(formatIntakeValue(["CA", "NY"]), "CA, NY");
  assert.equal(formatIntakeValue(true), "Yes");
  assert.equal(formatIntakeValue(false), "No");
  assert.equal(formatIntakeValue(2025), "2025");
  assert.equal(formatIntakeValue(null), "");
});
