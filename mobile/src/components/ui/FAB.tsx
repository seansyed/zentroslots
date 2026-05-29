/**
 * FAB — premium floating action button.
 *
 *   <FAB icon="add" accessibilityLabel="New booking" onPress={...} />
 *
 * Anchored bottom-right above the tab bar, safe-area-aware so it
 * always clears the home indicator with consistent breathing room.
 * 60dp circular surface — fits comfortably under the thumb without
 * dominating the canvas (Google Calendar, Linear Mobile idiom).
 *
 * Visual layers:
 *   • Ambient halo  — soft brand-tinted ring that fades from outside
 *                     the button, signalling "tap me" without going
 *                     loud.
 *   • Brand surface — the actual tappable disc.
 *   • Icon         — single Ionicon, white, 24-26px depending on glyph.
 *
 * Motion:
 *   • Spring-in on mount (scale 0.6 → 1 with a tiny overshoot).
 *   • Press depth     — 0.92 scale + faint opacity dip on press-in,
 *                       eased back on press-out. Reads as physical.
 *   • Medium haptic on tap.
 *
 * The `label` prop is intentionally GONE — the brief's premium-FAB
 * pattern is icon-only. If we ever need an "extended FAB" for an
 * action that desperately needs a label, that's a separate primitive
 * with its own component (don't grow this one back into a pill).
 */

import * as React from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, shadows, spacing } from "@/theme";

type Props = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  /** Required so VoiceOver / TalkBack announce the action. */
  accessibilityLabel: string;
  /**
   * Optional override for the px we add ABOVE the safe-area inset
   * when positioning from the bottom. Defaults to 76 — enough to
   * clear the tab bar's chip + give the FAB its own breathing room.
   */
  bottomOffset?: number;
  /** Horizontal anchor — defaults to right. */
  side?: "left" | "right";
  tone?: "brand" | "violet" | "success";
  /** Diameter in px. Defaults to 60 (sweet spot between 56 and 64). */
  size?: number;
  /**
   * Animate the FAB out (fade + slide) while the on-screen keyboard is
   * visible — typing in a search bar shouldn't compete with the FAB for
   * attention or accidentally trigger a tap when reaching for the return
   * key. Defaults to `true`. Disable for screens that never raise a
   * keyboard if you want to skip the listener overhead.
   */
  hideOnKeyboard?: boolean;
  style?: ViewStyle;
};

const TONE_MAP = {
  brand: { bg: colors.brand, fg: colors.inkOnBrand, halo: colors.brand },
  violet: { bg: colors.violet, fg: colors.inkOnBrand, halo: colors.violet },
  success: { bg: colors.success, fg: colors.inkOnBrand, halo: colors.success },
} as const;

export function FAB({
  icon,
  onPress,
  accessibilityLabel,
  bottomOffset = 76,
  side = "right",
  tone = "brand",
  size = 60,
  hideOnKeyboard = true,
  style,
}: Props) {
  const t = TONE_MAP[tone];
  const insets = useSafeAreaInsets();
  // Add the device's safe-area inset so the FAB never tucks under the
  // home indicator. On Android (no home indicator) the inset is 0 and
  // we fall back to the plain bottomOffset above the tab bar.
  const computedBottom = bottomOffset + Math.max(insets.bottom, 0);

  // Spring-in on mount.
  const mount = useSharedValue(0);
  React.useEffect(() => {
    mount.value = withTiming(1, {
      duration: 420,
      easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    });
  }, [mount]);

  // Press depth — feels physical without being noisy.
  const press = useSharedValue(0);

  // Halo breathing — a tiny pulse on the ambient ring so the FAB
  // reads as alive (not just a placed image). 3s cycle, very subtle.
  const halo = useSharedValue(0);
  React.useEffect(() => {
    halo.value = withRepeat(
      withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [halo]);

  // Keyboard auto-hide. 0 = fully visible, 1 = fully hidden.
  // We slide the FAB down ~30px AND fade it out so the gesture reads as
  // "stepping aside" rather than "popping away". Listening is opt-out via
  // the prop — most screens want this on, but a few (calendar grid) have
  // no inputs at all and can skip the listener cycle.
  const keyboard = useSharedValue(0);
  React.useEffect(() => {
    if (!hideOnKeyboard) return;
    // iOS fires `keyboardWill*` slightly earlier; Android only has
    // `keyboardDid*`. Using `Did` everywhere keeps timing consistent.
    const showSub = Keyboard.addListener("keyboardDidShow", () => {
      keyboard.value = withTiming(1, { duration: 180 });
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      keyboard.value = withTiming(0, { duration: 220 });
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [hideOnKeyboard, keyboard]);

  const mountStyle = useAnimatedStyle(() => ({
    opacity: mount.value * (1 - keyboard.value),
    transform: [
      { scale: 0.6 + 0.4 * mount.value },
      { translateY: 30 * keyboard.value },
    ],
  }));
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.08 * press.value }],
    opacity: 1 - 0.06 * press.value,
  }));
  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.06 * halo.value }],
    opacity: 0.18 + 0.06 * halo.value,
  }));

  const iconSize = Math.round(size * 0.4); // 24px @ size=60

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { bottom: computedBottom },
        side === "left" ? { left: spacing.lg } : { right: spacing.lg },
        style,
      ]}
    >
      <Animated.View style={mountStyle}>
        <Animated.View style={pressStyle}>
          {/* Ambient halo — sits one ring below the button surface,
              breathes subtly. We size it slightly larger than the
              button so the glow extends past the edge. */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.halo,
              haloStyle,
              {
                width: size + 16,
                height: size + 16,
                borderRadius: (size + 16) / 2,
                backgroundColor: t.halo,
                top: -8,
                left: -8,
              },
            ]}
          />
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              onPress();
            }}
            onPressIn={() => {
              press.value = withTiming(1, { duration: 120 });
            }}
            onPressOut={() => {
              press.value = withTiming(0, { duration: 180 });
            }}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={[
              styles.btn,
              {
                backgroundColor: t.bg,
                width: size,
                height: size,
                borderRadius: size / 2,
              },
            ]}
          >
            <Ionicons name={icon} size={iconSize} color={t.fg} />
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// keep the import alive on RN web (tree-shake guard)
void Platform;

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    // High z-index so the FAB always sits above scroll content, cards,
    // and section dividers. Modals/sheets use a portal-level layer with
    // their own backdrop so the FAB still tucks under them correctly.
    zIndex: 100,
    // Android-only — RN's zIndex is a JS hint only on Android; native
    // stacking uses `elevation`. Match the shadow's elevation+1 so the
    // FAB always renders above the surfaces that gave it its shadow.
    elevation: 14,
  },
  btn: {
    alignItems: "center",
    justifyContent: "center",
    // Lifted shadow + brand-tinted glow gives the disc real presence
    // against any background. The glow tint matches the surface, so
    // the FAB reads as one piece even on tinted scrolling surfaces.
    ...shadows.brandGlow,
  },
  halo: {
    position: "absolute",
  },
});
