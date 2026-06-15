/**
 * Button — tactile, accessible, brand-consistent CTA.
 *
 * Variants:
 *   • primary   — brand-gradient feel, white text, soft glow
 *   • secondary — outlined ghost, ink text
 *   • ghost     — minimal, text-only
 *   • danger    — rose-tinted for destructive actions
 *
 * Sizes: sm | md | lg
 *
 * All variants support `loading` (shows ActivityIndicator), `disabled`,
 * and `leftIcon` / `rightIcon` slots.
 */

import * as React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { colors, radius, shadows, spacing, typography } from "@/theme";

import { AppText } from "./Text";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = Omit<PressableProps, "style"> & {
  label: string;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
  style?: ViewStyle;
};

export function Button({
  label,
  variant = "primary",
  size = "md",
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth = false,
  disabled,
  style,
  ...rest
}: Props) {
  const isDisabled = disabled || loading;
  const sizeStyle = SIZE_STYLES[size];
  const variantStyle = VARIANT_STYLES[variant];

  return (
    <Pressable
      {...rest}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        sizeStyle.container,
        variantStyle.container,
        fullWidth && styles.fullWidth,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variantStyle.spinnerColor} size="small" />
      ) : (
        <View style={styles.inner}>
          {leftIcon ? <View style={styles.icon}>{leftIcon}</View> : null}
          <AppText
            style={[
              sizeStyle.label,
              { color: variantStyle.labelColor, fontFamily: typography.bodyStrong.fontFamily },
            ]}
            numberOfLines={1}
          >
            {label}
          </AppText>
          {rightIcon ? <View style={styles.icon}>{rightIcon}</View> : null}
        </View>
      )}
    </Pressable>
  );
}

const VARIANT_STYLES: Record<
  Variant,
  { container: ViewStyle; labelColor: string; spinnerColor: string }
> = {
  primary: {
    container: {
      backgroundColor: colors.brand,
      ...shadows.brandGlow,
    },
    labelColor: colors.inkOnBrand,
    spinnerColor: colors.inkOnBrand,
  },
  secondary: {
    container: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      ...shadows.xs,
    },
    labelColor: colors.ink,
    spinnerColor: colors.ink,
  },
  ghost: {
    container: {
      backgroundColor: "transparent",
    },
    labelColor: colors.ink,
    spinnerColor: colors.ink,
  },
  danger: {
    container: {
      backgroundColor: colors.danger,
      ...shadows.sm,
    },
    labelColor: colors.inkOnBrand,
    spinnerColor: colors.inkOnBrand,
  },
};

const SIZE_STYLES: Record<Size, { container: ViewStyle; label: TextStyle }> = {
  sm: {
    container: {
      height: 36,
      paddingHorizontal: spacing.md,
      borderRadius: radius.lg,
    },
    label: typography.smallStrong as TextStyle,
  },
  md: {
    container: {
      height: 44,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.lg,
    },
    label: typography.bodyStrong as TextStyle,
  },
  lg: {
    container: {
      height: 52,
      paddingHorizontal: spacing.xl,
      borderRadius: radius.xl,
    },
    label: typography.h4 as TextStyle,
  },
};

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  icon: { alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.5 },
  fullWidth: { width: "100%" },
});
