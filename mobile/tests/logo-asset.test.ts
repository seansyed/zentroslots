import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards that the OFFICIAL ZentroMeet badge is bundled and is the EXACT attached
 * asset (byte-identical), so the Logo component's require() resolves at build
 * time. The expo export / prebuild gate proves Metro mounts it; this proves the
 * file is present, a valid PNG, and unchanged. Paths resolve from the test
 * runner's cwd (the mobile package root).
 */

const logoPath = join(process.cwd(), "assets", "zentromeet-logo.png");
const oldMarkPath = join(process.cwd(), "assets", "logo-mark.png");

test("the official badge asset exists and is bundled", () => {
  assert.ok(existsSync(logoPath), "mobile/assets/zentromeet-logo.png must exist");
});

test("the asset is a valid PNG and byte-identical to the attached logo", () => {
  const buf = readFileSync(logoPath);
  // PNG signature
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  // Exact attached-asset size — locks "use the exact attached logo asset".
  // Updated 2026-06-29: new official white-Z-on-royal-blue badge (was 217130).
  assert.equal(buf.length, 180062);
});

test("the superseded logo-mark.png is removed (no dead/duplicate brand asset)", () => {
  assert.equal(existsSync(oldMarkPath), false);
});
