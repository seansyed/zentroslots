/**
 * GradientHeroCard — premium hero surface for the Home dashboard.
 *
 * We avoid expo-linear-gradient (extra native dep). Instead we stack
 * 3 absolutely-positioned tinted blobs at low opacity inside a rounded
 * card — gives a soft "ambient" gradient feel that renders identically
 * on iOS, Android, and web with zero new deps.
 *
 * Children render on top of the gradient layer.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { colors, radius, shadows, spacing } from "@/theme";

type Props = {
  children: React.ReactNode;
  style?: ViewStyle;
};

export function GradientHeroCard({ children, style }: Props) {
  return (
    <View style={[styles.wrap, style]}>
      {/* Base brand tint */}
      <View style={styles.baseTint} />
      {/* Ambient blobs */}
      <View style={[styles.blob, styles.blobA]} />
      <View style={[styles.blob, styles.blobB]} />
      <View style={[styles.blob, styles.blobC]} />
      {/* Content */}
      <View style={styles.inner}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderRadius: radius["2xl"],
    ...shadows.md,
  },
  baseTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.brandSubtle,
    opacity: 0.55,
  },
  blob: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
  },
  blobA: {
    backgroundColor: colors.brand,
    opacity: 0.16,
    top: -80,
    right: -60,
  },
  blobB: {
    backgroundColor: "#8b5cf6", // violet accent
    opacity: 0.10,
    bottom: -90,
    left: -50,
  },
  blobC: {
    backgroundColor: colors.success,
    opacity: 0.08,
    top: 40,
    right: 80,
    width: 140,
    height: 140,
    borderRadius: 70,
  },
  inner: {
    padding: spacing.xl,
    position: "relative",
  },
});
