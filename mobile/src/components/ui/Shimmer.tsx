/**
 * Shimmer — animated skeleton primitive.
 *
 * Drop-in replacement for plain <Skeleton> when you want the subtle
 * luxury "loading" pulse. Uses Reanimated (already installed) so the
 * animation runs on the UI thread on native and via requestAnimationFrame
 * on web. Falls back to a static block if reanimated isn't available.
 *
 * Usage:
 *   <Shimmer width={120} height={16} />
 *   <Shimmer.Row />  // 3-line skeleton row (avatar + 2 lines)
 *   <Shimmer.Card /> // full card-sized block
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { colors, radius, spacing } from "@/theme";

type Props = {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
};

export function Shimmer({ width = "100%", height = 12, borderRadius = radius.sm, style }: Props) {
  // Drive a 0→1→0 loop. We blend two surface tints via interpolation —
  // the gentle "breathing" effect feels less aggressive than a hard
  // gradient sweep at this scale and is friendlier on mobile batteries.
  const t = useSharedValue(0);
  React.useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [t]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + 0.45 * t.value,
  }));

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: colors.surfaceInset,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}

Shimmer.Row = function ShimmerRow({ avatar = true }: { avatar?: boolean }) {
  return (
    <View style={styles.row}>
      {avatar ? <Shimmer width={40} height={40} borderRadius={radius.full} /> : null}
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Shimmer width="60%" height={14} />
        <Shimmer width="40%" height={12} />
      </View>
    </View>
  );
};

Shimmer.Card = function ShimmerCard({ height = 92 }: { height?: number }) {
  return <Shimmer width="100%" height={height} borderRadius={radius.xl} />;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
});
