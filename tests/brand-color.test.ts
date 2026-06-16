import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Brand migration guard (web): the platform primary brand is #2563EB via the
 * central CSS token, tenant overrides remain authoritative (DB default already
 * #2563eb; BookingFlow falls back to the same), and no old #359df3 / rgb(53,157,
 * 243) remains in the central token files. Paths resolve from the repo root
 * (the backend test runner cwd).
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("central web token --color-accent is #2563EB (light) / #3B82F6 (dark)", () => {
  const css = read("app/globals.css");
  // light :root
  assert.match(css, /--color-accent:\s*#2563EB;/i);
  assert.match(css, /--color-accent-hover:\s*#1D4ED8;/i);
  // dark adaptation
  assert.match(css, /--color-accent:\s*#3B82F6;/i);
});

test("no old #359df3 / rgb(53,157,243) in the central token files", () => {
  const css = read("app/globals.css");
  const tw = read("tailwind.config.ts");
  for (const src of [css, tw]) {
    assert.doesNotMatch(src, /#359df3/i);
    assert.doesNotMatch(src, /53,\s*157,\s*243/);
  }
});

test("tailwind brand routes through the CSS var (not a hardcoded hex)", () => {
  const tw = read("tailwind.config.ts");
  assert.match(tw, /var\(--color-accent/);
});

test("tenant override stays authoritative: DB default is #2563eb; booking falls back to it", () => {
  const schema = read("db/schema.ts");
  assert.match(schema, /primaryColor[\s\S]{0,80}#2563eb/i); // tenant default, overridable
  const booking = read("components/BookingFlow.tsx");
  assert.match(booking, /#2563eb/i); // DEFAULT_ACCENT fallback (tenant color wins when set)
});
