/**
 * Spacing scale — multiples of 4 (8-point grid).
 *
 * Use named tokens, not raw numbers, anywhere padding/margin/gap appears.
 * Keep additions deliberate — the scale should stay small enough to
 * remember.
 */

export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 32,
  "4xl": 40,
  "5xl": 48,
  "6xl": 64,
  "7xl": 80,
} as const;

export type Spacing = typeof spacing;
export type SpacingKey = keyof Spacing;

/**
 * Convenience: total horizontal gutter inside a ScreenContainer.
 * Pulled out so individual screens don't drift from each other.
 */
export const layout = {
  screenPaddingX: spacing.lg,
  screenPaddingY: spacing.lg,
  sectionGap: spacing["2xl"],
  cardPadding: spacing.lg,
  rowGap: spacing.md,
  tabBarHeight: 64,

  /* ─── Phase 2F: premium rhythm tokens ───────────────────────────
   * The shared vertical rhythm between floating rows + groups. The
   * design brief asked for 10-14px — we pick 12 for rows (`rowGap`
   * above already maps to spacing.md = 12) and a slightly looser 14
   * for inter-group spacing so the eye registers the section break. */
  rowFloatGap: 12,
  groupGap: 14,
  /** Padding inside an individual floating settings row. */
  rowInsetX: spacing.lg,
  rowInsetY: spacing.md + 2, // 14 — slightly taller than rowGap to feel grounded
};
