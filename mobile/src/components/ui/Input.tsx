/**
 * Input — labeled text field with focus state + error state.
 *
 * Single component covers both regular inputs and password fields
 * (pass `secureTextEntry`). For multi-line, pass `multiline`.
 */

import * as React from "react";
import {
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { colors, radius, spacing, typography } from "@/theme";

import { AppText } from "./Text";

type Props = TextInputProps & {
  label?: string;
  error?: string | null;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  containerStyle?: ViewStyle;
};

export function Input({
  label,
  error,
  hint,
  leftIcon,
  rightSlot,
  containerStyle,
  style,
  multiline,
  onFocus,
  onBlur,
  ...rest
}: Props) {
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={[styles.wrap, containerStyle]}>
      {label ? (
        <AppText variant="smallStrong" color="muted" style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <View
        style={[
          styles.field,
          multiline && styles.fieldMultiline,
          focused && styles.fieldFocused,
          error && styles.fieldError,
        ]}
      >
        {leftIcon ? <View style={styles.icon}>{leftIcon}</View> : null}
        <TextInput
          placeholderTextColor={colors.inkSubtle}
          {...rest}
          multiline={multiline}
          style={[
            styles.input,
            multiline && styles.inputMultiline,
            style,
          ]}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
        />
        {rightSlot ? <View style={styles.icon}>{rightSlot}</View> : null}
      </View>
      {error ? (
        <AppText variant="caption" color="danger" style={styles.bottomMsg}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" color="subtle" style={styles.bottomMsg}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
  },
  label: {
    marginBottom: spacing.xs,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  fieldMultiline: {
    height: undefined,
    minHeight: 96,
    paddingVertical: spacing.sm,
    alignItems: "flex-start",
  },
  fieldFocused: {
    borderColor: colors.brand,
    // Approximate "ring" via inner shadow on iOS, no-op on Android
    shadowColor: colors.brand,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
  },
  fieldError: {
    borderColor: colors.danger,
  },
  input: {
    flex: 1,
    color: colors.ink,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
    fontFamily: typography.body.fontFamily,
    padding: 0,
  },
  inputMultiline: {
    textAlignVertical: "top",
    minHeight: 80,
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
  bottomMsg: {
    marginTop: spacing.xs,
  },
});
