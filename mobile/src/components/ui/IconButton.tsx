/**
 * IconButton — round 36px tappable icon used for back nav, copy
 * affordances, dropdown toggles. Soft surface, subtle border.
 */

import * as React from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius } from "@/theme";

type Props = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress?: () => void;
  size?: "sm" | "md";
  tone?: "default" | "brand" | "danger";
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

const SIZE: Record<NonNullable<Props["size"]>, { box: number; icon: number }> = {
  sm: { box: 32, icon: 16 },
  md: { box: 36, icon: 18 },
};

const TONE: Record<
  NonNullable<Props["tone"]>,
  { bg: string; border: string; fg: string }
> = {
  default: { bg: colors.surface, border: colors.border, fg: colors.ink },
  brand: { bg: colors.brandSubtle, border: colors.brandSubtle, fg: colors.brand },
  danger: { bg: colors.dangerSubtle, border: colors.dangerSubtle, fg: colors.danger },
};

export function IconButton({
  icon,
  onPress,
  size = "md",
  tone = "default",
  accessibilityLabel,
  style,
}: Props) {
  const s = SIZE[size];
  const t = TONE[tone];
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      style={({ pressed }) => [
        styles.base,
        {
          width: s.box,
          height: s.box,
          borderRadius: radius.lg,
          backgroundColor: t.bg,
          borderColor: t.border,
        },
        pressed && { opacity: 0.7, transform: [{ scale: 0.96 }] },
        style,
      ]}
    >
      <Ionicons name={icon} size={s.icon} color={t.fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
});
