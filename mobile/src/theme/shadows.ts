/**
 * Shadow tokens.
 *
 * iOS uses the shadow* properties (shadowColor + offset + opacity +
 * radius). Android needs `elevation`. Each shadow token exports both
 * so a single style spread does the right thing on both platforms.
 *
 * Keep the scale small. Mobile shadows read heavier than web shadows,
 * so we lean restrained.
 */

import { Platform } from "react-native";

type Shadow = {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
};

function shadow(
  offsetY: number,
  blur: number,
  opacity: number,
  elevation: number,
  color = "#0f172a",
): Shadow {
  return Platform.select({
    ios: {
      shadowColor: color,
      shadowOffset: { width: 0, height: offsetY },
      shadowOpacity: opacity,
      shadowRadius: blur,
      elevation: 0,
    },
    android: {
      shadowColor: color,
      shadowOffset: { width: 0, height: offsetY },
      shadowOpacity: 0,
      shadowRadius: 0,
      elevation,
    },
    default: {
      shadowColor: color,
      shadowOffset: { width: 0, height: offsetY },
      shadowOpacity: opacity,
      shadowRadius: blur,
      elevation,
    },
  })!;
}

export const shadows = {
  none: shadow(0, 0, 0, 0),
  /** Card resting state — barely-there lift. */
  xs: shadow(1, 2, 0.04, 1),
  /** Default card depth. */
  sm: shadow(2, 6, 0.06, 2),
  /** Elevated card / sticky header. */
  md: shadow(4, 12, 0.08, 4),
  /** Floating action buttons / drawers. */
  lg: shadow(8, 20, 0.1, 8),
  /** Modal / popover. */
  xl: shadow(16, 36, 0.14, 16),
  /** Brand-tinted glow for primary CTA. */
  brandGlow: shadow(8, 22, 0.32, 6, "#359df3"),

  /* ─── Phase 2F additions ───────────────────────────────────────── */
  /** Ambient — softest possible lift for resting list rows that still
   *  need to feel "floating" instead of inset. Crucial for the
   *  premium-list aesthetic where every row is its own surface. */
  ambient: shadow(2, 10, 0.05, 1),
  /** Floating — what an individual settings row should feel like. A
   *  noticeable-but-restrained lift that says "this is its own thing." */
  floating: shadow(6, 18, 0.08, 3),
  /** Active — elevated state for the selected segment of a control
   *  (e.g. AvailabilityCard). Slightly stronger than floating so the
   *  active option visually pops without going garish. */
  activeLift: shadow(10, 24, 0.12, 5),
  /** Soft brand wash — a barely-coloured halo used behind the active
   *  state of the availability segmented control. Communicates
   *  "selected" the same way macOS uses NSVisualEffectView accents. */
  brandHalo: shadow(10, 26, 0.18, 4, "#359df3"),
};

export type Shadows = typeof shadows;
export type ShadowKey = keyof Shadows;
