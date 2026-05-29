/**
 * Border-radius tokens. iOS-native feel skews toward larger radii on
 * cards (16-20px) and pills (full).
 */

export const radius = {
  none: 0,
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  "2xl": 22,
  "3xl": 28,
  full: 9999,
} as const;

export type Radius = typeof radius;
export type RadiusKey = keyof Radius;
