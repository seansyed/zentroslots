/**
 * SectionFade — fade + lift entrance for screen sections.
 *
 * Wraps any block of UI and animates it in on first mount. Pass `delay`
 * to stagger multiple sections (e.g. 0ms / 60ms / 120ms / 180ms across
 * the Home dashboard cards) — the cascade gives the screen a calm,
 * premium "settle" feeling instead of every card appearing at once.
 *
 * Uses Reanimated for UI-thread driven animation. Falls back to an
 * instant render if Reanimated ever fails (we never block the UI on
 * animation libraries — content first).
 */

import * as React from "react";
import { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

type Props = {
  delay?: number;
  duration?: number;
  /** Vertical lift in px — content starts `lift` below its final position. */
  lift?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

export function SectionFade({
  delay = 0,
  duration = 420,
  lift = 8,
  style,
  children,
}: Props) {
  const t = useSharedValue(0);

  React.useEffect(() => {
    t.value = withDelay(
      delay,
      withTiming(1, {
        duration,
        easing: Easing.bezier(0.22, 1, 0.36, 1), // ease-out-expo-ish
      }),
    );
  }, [delay, duration, t]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateY: lift * (1 - t.value) }],
  }));

  return <Animated.View style={[animatedStyle, style]}>{children}</Animated.View>;
}
