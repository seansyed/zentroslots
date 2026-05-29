/**
 * Card — premium surface primitive.
 *
 * Three variants:
 *   • plain    — white surface, soft shadow, standard padding
 *   • elevated — slightly stronger shadow, used for hero/featured
 *   • outline  — flat with border, no shadow (for dense lists / inline)
 *
 * Cards are *not* pressable by default. If you need tappability wrap
 * with TouchableScale (below) so the press feedback is consistent.
 */

import * as React from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type ViewProps,
} from "react-native";

import { colors, layout, radius, shadows } from "@/theme";

type Variant = "plain" | "elevated" | "outline";

type CardProps = ViewProps & {
  variant?: Variant;
  /** Override default p-4. */
  padding?: number | "none";
};

export function Card({
  variant = "plain",
  padding,
  style,
  children,
  ...rest
}: CardProps) {
  const pad = padding === "none" ? 0 : padding ?? layout.cardPadding;
  return (
    <View
      style={[
        styles.base,
        variant === "elevated" && styles.elevated,
        variant === "outline" && styles.outline,
        variant === "plain" && styles.plain,
        { padding: pad },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

type PressableCardProps = PressableProps & {
  variant?: Variant;
  padding?: number | "none";
  /** Optional preset feedback intensity. */
  pressedScale?: number;
};

/**
 * PressableCard — Card surface that responds to touch with a calm
 * press feedback. Use for clickable list rows / KPI tiles.
 */
export function PressableCard({
  variant = "plain",
  padding,
  pressedScale = 0.985,
  style,
  children,
  ...rest
}: PressableCardProps) {
  const pad = padding === "none" ? 0 : padding ?? layout.cardPadding;
  return (
    <Pressable
      {...rest}
      style={({ pressed }) => [
        styles.base,
        variant === "elevated" && styles.elevated,
        variant === "outline" && styles.outline,
        variant === "plain" && styles.plain,
        { padding: pad },
        pressed && {
          transform: [{ scale: pressedScale }],
          opacity: 0.92,
        },
        typeof style === "function" ? style({ pressed }) : style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
  },
  plain: {
    ...shadows.sm,
  },
  elevated: {
    ...shadows.md,
  },
  outline: {
    borderWidth: 1,
    borderColor: colors.border,
  },
});
