/**
 * Skeleton — shimmering placeholder block.
 *
 * Built on Reanimated so the animation runs on the UI thread. Single
 * looping opacity oscillation, restrained (0.55 → 0.95) so it reads as
 * "loading" without distracting.
 *
 * Usage:
 *   <Skeleton width="60%" height={16} />
 *   <Skeleton.Card />     // pre-shaped card placeholder
 *   <Skeleton.Avatar size={40} />
 */

import * as React from "react";
import { StyleSheet, View, type DimensionValue, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";

import { colors, radius, spacing } from "@/theme";

type SkeletonProps = {
  width?: DimensionValue;
  height?: DimensionValue;
  /** Border radius. Defaults to 8. */
  borderRadius?: number;
  style?: ViewStyle;
};

function SkeletonBase({ width = "100%", height = 16, borderRadius = 8, style }: SkeletonProps) {
  const opacity = useSharedValue(0.55);
  React.useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.95, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        styles.base,
        { width, height, borderRadius },
        animatedStyle,
        style,
      ]}
    />
  );
}

function SkeletonCard({ style }: { style?: ViewStyle }) {
  return (
    <View style={[styles.card, style]}>
      <SkeletonBase width={120} height={12} />
      <SkeletonBase width="70%" height={20} style={{ marginTop: spacing.sm }} />
      <SkeletonBase width="50%" height={14} style={{ marginTop: spacing.xs }} />
    </View>
  );
}

function SkeletonAvatar({ size = 40 }: { size?: number }) {
  return <SkeletonBase width={size} height={size} borderRadius={size / 2} />;
}

function SkeletonRow({ style }: { style?: ViewStyle }) {
  return (
    <View style={[styles.row, style]}>
      <SkeletonAvatar size={40} />
      <View style={{ flex: 1, marginLeft: spacing.md, gap: spacing.xs }}>
        <SkeletonBase width="60%" height={14} />
        <SkeletonBase width="40%" height={12} />
      </View>
    </View>
  );
}

export const Skeleton = Object.assign(SkeletonBase, {
  Card: SkeletonCard,
  Avatar: SkeletonAvatar,
  Row: SkeletonRow,
});

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surfaceInset,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
  },
});
