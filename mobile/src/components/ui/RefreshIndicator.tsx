/**
 * RefreshIndicator — subtle "syncing" pulse for live updates.
 *
 * Renders nothing when idle; when `active` is true a compact pill
 * appears with a spinning brand dot and "Refreshing…" label. Used in
 * the Home hero alongside the workspace pill so the operator gets a
 * gentle "we just talked to the server" signal without an obtrusive
 * spinner.
 *
 * Fades in/out via Reanimated — never flashes hard.
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

import { AppText } from "@/components/ui/Text";
import { colors, radius, spacing } from "@/theme";

type Props = {
  active: boolean;
  label?: string;
  style?: ViewStyle;
};

export function RefreshIndicator({ active, label = "Refreshing…", style }: Props) {
  // Opacity fades 0 → 1 when active, otherwise back to 0.
  const visible = useSharedValue(0);
  React.useEffect(() => {
    visible.value = withTiming(active ? 1 : 0, {
      duration: active ? 200 : 320,
      easing: Easing.out(Easing.cubic),
    });
  }, [active, visible]);

  // Continuous pulse on the dot while active.
  const pulse = useSharedValue(0);
  React.useEffect(() => {
    if (!active) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [active, pulse]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: 4 * (1 - visible.value) }],
  }));
  const dotStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + 0.5 * pulse.value,
    transform: [{ scale: 0.85 + 0.3 * pulse.value }],
  }));

  if (!active && visible.value === 0) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.pill, containerStyle, style]}
    >
      <Animated.View style={[styles.dot, dotStyle]} />
      <AppText
        variant="micro"
        style={{ color: colors.inkMuted, marginLeft: 6, letterSpacing: 0.3 }}
      >
        {label}
      </AppText>
    </Animated.View>
  );
}

// referenced just to keep View import used
void View;

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.8)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignSelf: "flex-start",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.brand,
  },
});
