import { test } from "node:test";
import assert from "node:assert/strict";

import { palette } from "../src/theme/colors";

/**
 * Brand migration guard: the mobile platform primary brand is #2563EB, and the
 * semantic/decorative colors are unchanged (we migrated ONLY the brand family).
 */

test("platform brand primary = #2563EB", () => {
  assert.equal(palette.brand, "#2563EB");
  assert.equal(palette.brandAccent, "#2563EB");
  assert.equal(palette.info, "#2563EB"); // info aliases brand
});

test("brand derived shades use the new blue scale", () => {
  assert.equal(palette.brandHover, "#1D4ED8"); // 700
  assert.equal(palette.brandPressed, "#1E40AF"); // 800
  assert.equal(palette.brandSubtle, "#EFF6FF"); // 50
});

test("no old #359df3 brand value remains in the palette", () => {
  for (const [k, v] of Object.entries(palette)) {
    assert.notEqual(String(v).toLowerCase(), "#359df3", `palette.${k} still old brand`);
  }
});

test("semantic + decorative colors are preserved (not recolored)", () => {
  assert.equal(palette.success, "#10b981");
  assert.equal(palette.warning, "#f59e0b");
  assert.equal(palette.danger, "#ef4444");
  // category/decorative accents stay distinct
  assert.equal(palette.violet, "#8b5cf6");
  assert.equal(palette.rose, "#f43f5e");
  assert.equal(palette.sky, "#0ea5e9");
});
