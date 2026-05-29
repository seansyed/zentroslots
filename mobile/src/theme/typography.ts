/**
 * Typography tokens — Public Sans family.
 *
 * Font loading itself happens in app/_layout.tsx via expo-font. This
 * module just exposes the family + size/weight/lineHeight scale that
 * every Text component reads from.
 *
 * Until the fonts finish loading, the system font renders. That's
 * intentional — premium UI feels worse with FOIT (flash of invisible
 * text) than with one frame of system font.
 */

import { Platform } from "react-native";

export const fontFamily = {
  // Set in _layout.tsx via expo-font. Until then, fall back to system.
  regular: Platform.select({
    ios: "PublicSans_400Regular",
    android: "PublicSans_400Regular",
    default: "PublicSans_400Regular",
  })!,
  medium: Platform.select({
    ios: "PublicSans_500Medium",
    android: "PublicSans_500Medium",
    default: "PublicSans_500Medium",
  })!,
  semibold: Platform.select({
    ios: "PublicSans_600SemiBold",
    android: "PublicSans_600SemiBold",
    default: "PublicSans_600SemiBold",
  })!,
  bold: Platform.select({
    ios: "PublicSans_700Bold",
    android: "PublicSans_700Bold",
    default: "PublicSans_700Bold",
  })!,
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  })!,
};

/**
 * Type-scale. Each entry is a complete style: size + lineHeight +
 * letterSpacing + weight. Use directly as a Text style.
 */
export const typography = {
  // Display — used sparingly (hero/empty-state titles).
  displayLg: { fontSize: 32, lineHeight: 38, letterSpacing: -0.4, fontFamily: fontFamily.semibold },
  displayMd: { fontSize: 28, lineHeight: 34, letterSpacing: -0.3, fontFamily: fontFamily.semibold },

  // Headings
  h1: { fontSize: 24, lineHeight: 30, letterSpacing: -0.2, fontFamily: fontFamily.semibold },
  h2: { fontSize: 20, lineHeight: 26, letterSpacing: -0.15, fontFamily: fontFamily.semibold },
  h3: { fontSize: 17, lineHeight: 23, letterSpacing: -0.1, fontFamily: fontFamily.semibold },
  h4: { fontSize: 15, lineHeight: 20, letterSpacing: -0.05, fontFamily: fontFamily.semibold },

  // Body
  bodyLg: { fontSize: 16, lineHeight: 24, fontFamily: fontFamily.regular },
  body: { fontSize: 14, lineHeight: 20, fontFamily: fontFamily.regular },
  bodyStrong: { fontSize: 14, lineHeight: 20, fontFamily: fontFamily.medium },

  // Compact / supporting
  small: { fontSize: 13, lineHeight: 18, fontFamily: fontFamily.regular },
  smallStrong: { fontSize: 13, lineHeight: 18, fontFamily: fontFamily.medium },
  caption: { fontSize: 12, lineHeight: 16, fontFamily: fontFamily.regular },
  micro: { fontSize: 11, lineHeight: 14, fontFamily: fontFamily.medium },

  // Labels — uppercase eyebrows / chip labels
  eyebrow: {
    fontSize: 10.5,
    lineHeight: 14,
    letterSpacing: 1.2,
    fontFamily: fontFamily.semibold,
    textTransform: "uppercase" as const,
  },

  // Numerics — tabular alignment for KPIs / counters
  kpi: {
    fontSize: 28,
    lineHeight: 32,
    letterSpacing: -0.4,
    fontFamily: fontFamily.semibold,
    fontVariant: ["tabular-nums" as const],
  },
  kpiSmall: {
    fontSize: 22,
    lineHeight: 26,
    letterSpacing: -0.3,
    fontFamily: fontFamily.semibold,
    fontVariant: ["tabular-nums" as const],
  },
};

export type Typography = typeof typography;
export type TypographyKey = keyof Typography;
