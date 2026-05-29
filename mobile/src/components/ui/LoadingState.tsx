/**
 * LoadingState — single full-bleed spinner for query loading.
 * For inline list-row loading prefer a Skeleton list.
 */

import * as React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { colors, spacing } from "@/theme";

import { AppText } from "./Text";

type Props = {
  label?: string;
};

export function LoadingState({ label = "Loading…" }: Props) {
  return (
    <View style={styles.wrap}>
      <ActivityIndicator size="large" color={colors.brand} />
      <AppText variant="small" color="muted" style={styles.label}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing["4xl"],
  },
  label: { marginTop: spacing.md },
});
