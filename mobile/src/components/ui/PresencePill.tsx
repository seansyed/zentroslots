/**
 * PresencePill — compact pulsing presence indicator.
 *
 *   <PresencePill state="available" />
 *   <PresencePill state="busy"      size="lg" onPress={...} />
 *   <PresencePill state="paused"    showLabel={false} />
 *
 * Renders a colored dot (animated with a soft "pulse" when available)
 * + a status label inside a rounded pill. Tappable when `onPress` is
 * provided so the same primitive can serve both Home (read-only) and
 * Settings (interactive toggle entry).
 */

import * as React from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { AppText } from "@/components/ui/Text";
import { colors, radius, spacing } from "@/theme";

import type { Presence } from "@/store/presenceStore";

type Props = {
  state: Presence;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
};

const STATE_MAP: Record<Presence, { dot: string; bg: string; fg: string; label: string; pulse: boolean }> = {
  available: { dot: colors.success, bg: colors.successSubtle, fg: colors.successInk, label: "Available", pulse: true },
  busy:      { dot: colors.warning, bg: colors.warningSubtle, fg: colors.warningInk, label: "Busy",     pulse: false },
  paused:    { dot: colors.inkSubtle, bg: colors.surfaceInset, fg: colors.inkMuted,  label: "Paused",   pulse: false },
};

const SIZE_MAP = {
  sm: { dot: 6,  paddingV: 3, paddingH: 8,  font: 10 },
  md: { dot: 8,  paddingV: 5, paddingH: 10, font: 12 },
  lg: { dot: 10, paddingV: 7, paddingH: 12, font: 13 },
} as const;

export function PresencePill({
  state,
  size = "md",
  showLabel = true,
  onPress,
  style,
}: Props) {
  const s = STATE_MAP[state];
  const sz = SIZE_MAP[size];

  // Pulse animation for Available — gentle radial bloom around the dot.
  const pulse = useSharedValue(0);
  React.useEffect(() => {
    if (!s.pulse) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
  }, [pulse, s.pulse]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.6 * (1 - pulse.value),
    transform: [{ scale: 1 + 1.8 * pulse.value }],
  }));

  const Content = (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: s.bg,
          paddingVertical: sz.paddingV,
          paddingHorizontal: sz.paddingH,
        },
        style,
      ]}
    >
      <View style={[styles.dotWrap, { width: sz.dot * 2, height: sz.dot * 2 }]}>
        {s.pulse ? (
          <Animated.View
            style={[
              styles.halo,
              {
                width: sz.dot,
                height: sz.dot,
                borderRadius: sz.dot / 2,
                backgroundColor: s.dot,
              },
              haloStyle,
            ]}
          />
        ) : null}
        <View
          style={{
            width: sz.dot,
            height: sz.dot,
            borderRadius: sz.dot / 2,
            backgroundColor: s.dot,
          }}
        />
      </View>
      {showLabel ? (
        <AppText
          style={{
            fontSize: sz.font,
            color: s.fg,
            marginLeft: 6,
            fontWeight: "600",
            letterSpacing: 0.2,
          }}
        >
          {s.label}
        </AppText>
      ) : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync().catch(() => {});
          onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel={`Presence: ${s.label}`}
      >
        {Content}
      </Pressable>
    );
  }
  return Content;
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.full,
    alignSelf: "flex-start",
  },
  dotWrap: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  halo: {
    position: "absolute",
  },
});

// silence unused-import lint when consumers only need the type
void spacing;
