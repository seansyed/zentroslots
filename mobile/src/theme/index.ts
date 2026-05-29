/**
 * Theme barrel. Import any token cluster as `import { colors, spacing,
 * typography, shadows, radius } from "@/theme"` so component files
 * stay short.
 *
 * The full `theme` object is also exported for components that want
 * to receive a typed theme reference (useful as we add dark-mode
 * support later — single switch flips this object).
 */

export { colors, palette } from "./colors";
export type { Palette, PaletteKey } from "./colors";

export { spacing, layout } from "./spacing";
export type { Spacing, SpacingKey } from "./spacing";

export { typography, fontFamily } from "./typography";
export type { Typography, TypographyKey } from "./typography";

export { shadows } from "./shadows";
export type { Shadows, ShadowKey } from "./shadows";

export { radius } from "./radius";
export type { Radius, RadiusKey } from "./radius";

import { colors } from "./colors";
import { spacing, layout } from "./spacing";
import { typography, fontFamily } from "./typography";
import { shadows } from "./shadows";
import { radius } from "./radius";

export const theme = {
  colors,
  spacing,
  layout,
  typography,
  fontFamily,
  shadows,
  radius,
} as const;

export type Theme = typeof theme;
