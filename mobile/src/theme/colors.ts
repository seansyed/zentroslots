/**
 * ZentroMeet color tokens.
 *
 * Mirrors the web `scheduling-saas` palette so brand identity stays
 * consistent across platforms. Every color in the app should be sourced
 * from this file — never hardcoded hexes inside components.
 *
 * Primary brand is #359df3 (per Brand Studio).
 *
 * NOTE: this is the LIGHT palette. We keep darkMode entries here so
 * future dark-mode work has a contract to land into. Light is the
 * default for v1.
 */

export const palette = {
  // Brand
  brand: "#359df3",
  brandHover: "#2789e0",
  brandPressed: "#1d7bd1",
  brandSubtle: "#ebf5ff",
  brandAccent: "#359df3",

  // Ink (text)
  ink: "#0f172a",
  inkMuted: "#475569",
  inkSubtle: "#94a3b8",
  inkDisabled: "#cbd5e1",
  inkOnBrand: "#ffffff",

  // Surface (backgrounds)
  surface: "#ffffff",
  surfaceSubtle: "#f8fafc",
  surfaceInset: "#f1f5f9",
  surfaceOverlay: "rgba(15, 23, 42, 0.45)",

  // Borders / dividers
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  borderSubtle: "#eef2f7",

  // Status
  success: "#10b981",
  successSubtle: "#ecfdf5",
  successInk: "#047857",

  warning: "#f59e0b",
  warningSubtle: "#fffbeb",
  warningInk: "#b45309",

  danger: "#ef4444",
  dangerSubtle: "#fef2f2",
  dangerInk: "#b91c1c",

  info: "#359df3",
  infoSubtle: "#ebf5ff",
  infoInk: "#1d7bd1",

  // Accents for category chips / event blocks
  violet: "#8b5cf6",
  violetSubtle: "#f5f3ff",
  emerald: "#10b981",
  emeraldSubtle: "#ecfdf5",
  amber: "#f59e0b",
  amberSubtle: "#fffbeb",
  sky: "#0ea5e9",
  skySubtle: "#e0f2fe",
  rose: "#f43f5e",
  roseSubtle: "#fff1f2",
  slate: "#64748b",
  slateSubtle: "#f1f5f9",
};

export type Palette = typeof palette;
export type PaletteKey = keyof Palette;

export const colors = palette;
