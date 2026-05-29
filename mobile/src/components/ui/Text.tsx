/**
 * Typed Text wrapper. Picks a variant from the typography scale and
 * applies it. Pass extra style on top to override color/etc.
 *
 *   <AppText variant="h2">Hello</AppText>
 *   <AppText variant="caption" color="muted">2 unread</AppText>
 */

import * as React from "react";
import { Text, type TextProps, type TextStyle } from "react-native";

import { colors, typography, type TypographyKey } from "@/theme";

type ColorTone = "default" | "muted" | "subtle" | "brand" | "danger" | "success" | "warning" | "onBrand";

const TONE_TO_COLOR: Record<ColorTone, string> = {
  default: colors.ink,
  muted: colors.inkMuted,
  subtle: colors.inkSubtle,
  brand: colors.brand,
  danger: colors.danger,
  success: colors.success,
  warning: colors.warning,
  onBrand: colors.inkOnBrand,
};

type Props = TextProps & {
  variant?: TypographyKey;
  color?: ColorTone;
  align?: TextStyle["textAlign"];
};

export function AppText({
  variant = "body",
  color = "default",
  align,
  style,
  ...rest
}: Props) {
  const variantStyle = typography[variant];
  const composed: TextStyle = {
    color: TONE_TO_COLOR[color],
    textAlign: align,
    ...(variantStyle as TextStyle),
  };
  return <Text style={[composed, style]} {...rest} />;
}
