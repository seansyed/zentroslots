/**
 * OfflineBanner — global "you're offline" cue.
 *
 * Mounted once at the root layout. Listens to networkStore.isOnline:
 *   • Slides down from the top with a soft amber tone when offline.
 *   • Slides back up the moment we observe a successful request.
 *   • Renders nothing when fully online (no DOM cost when not needed).
 *
 * Designed to be unobtrusive — the operator gets a calm signal that
 * "we're working with cached data right now," not a panic notification.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText } from "@/components/ui/Text";
import { useNetworkAttach, useNetworkStore } from "@/store/networkStore";
import { colors, radius, spacing } from "@/theme";

type Props = {
  /** Allow callers to nudge the banner away from the safe-area top edge. */
  topOffset?: number;
  style?: ViewStyle;
};

export function OfflineBanner({ topOffset = 0, style }: Props) {
  useNetworkAttach();
  const isOnline = useNetworkStore((s) => s.isOnline);

  const visible = useSharedValue(0);

  React.useEffect(() => {
    visible.value = withTiming(isOnline ? 0 : 1, {
      duration: isOnline ? 280 : 220,
      easing: isOnline ? Easing.out(Easing.cubic) : Easing.out(Easing.back(1.2)),
    });
  }, [isOnline, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: -28 * (1 - visible.value) }],
  }));

  // Don't pay any layout cost when fully online and never been offline.
  if (isOnline && visible.value === 0) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { top: topOffset }, animatedStyle, style]}
    >
      <View style={styles.pill}>
        <Ionicons name="cloud-offline-outline" size={14} color={colors.warningInk} />
        <AppText
          variant="smallStrong"
          style={{ color: colors.warningInk, marginLeft: 6, letterSpacing: 0.3 }}
        >
          Offline · using cached data
        </AppText>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingTop: spacing.sm,
    zIndex: 1000,
    elevation: 10,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.warningSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warningInk,
  },
});
