/**
 * Pill / Badge — compact tonal chip.
 *
 *   <Pill tone="success">Confirmed</Pill>
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { colors, radius, spacing, typography } from "@/theme";

import { AppText } from "./Text";

export type PillTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "violet"
  | "amber"
  | "emerald";

const TONE_STYLES: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.surfaceInset, fg: colors.inkMuted },
  brand: { bg: colors.brandSubtle, fg: colors.brand },
  success: { bg: colors.successSubtle, fg: colors.successInk },
  warning: { bg: colors.warningSubtle, fg: colors.warningInk },
  danger: { bg: colors.dangerSubtle, fg: colors.dangerInk },
  info: { bg: colors.infoSubtle, fg: colors.infoInk },
  violet: { bg: colors.violetSubtle, fg: colors.violet },
  amber: { bg: colors.amberSubtle, fg: colors.amber },
  emerald: { bg: colors.emeraldSubtle, fg: colors.emerald },
};

type Props = {
  children: React.ReactNode;
  tone?: PillTone;
  style?: ViewStyle;
};

export function Pill({ children, tone = "neutral", style }: Props) {
  const t = TONE_STYLES[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, style]}>
      <AppText
        style={{
          color: t.fg,
          fontSize: typography.micro.fontSize,
          lineHeight: typography.micro.lineHeight,
          fontFamily: typography.micro.fontFamily,
          letterSpacing: 0.4,
        }}
      >
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
});
