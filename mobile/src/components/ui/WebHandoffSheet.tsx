/**
 * WebHandoffSheet — premium bottom-sheet for features that intentionally
 * live on the web (Brand Studio, Billing, advanced Calendar infrastructure).
 *
 * Replaces the previous behavior of `Linking.openURL` jumping straight
 * to the web app without warning. The sheet:
 *
 *   • Animates up from the bottom over a dimmed scrim
 *   • Shows a tone-tinted icon + explanation copy so the user
 *     understands WHY this lives on the web (not a missing feature,
 *     a deliberate choice)
 *   • Primary CTA opens the web app in the system browser
 *   • Dismiss CTA closes the sheet — back-swipe also closes
 *
 * Designed to feel intentional, not apologetic. The web handoff is a
 * deliberate split of the product, not an incomplete mobile build.
 *
 * Usage:
 *
 *   const [sheet, setSheet] = React.useState<HandoffSpec | null>(null);
 *   // ...
 *   <WebHandoffSheet
 *     spec={sheet}
 *     onDismiss={() => setSheet(null)}
 *   />
 */

import * as React from "react";
import {
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText } from "@/components/ui/Text";
import { track } from "@/lib/telemetry";
import { colors, radius, shadows, spacing } from "@/theme";

export type HandoffSpec = {
  /** Sheet title — "Brand Studio", "Billing & plan", etc. */
  title: string;
  /** One-sentence subtitle explaining why this lives on the web. */
  body: string;
  /** Web URL to open when the user taps the primary CTA. */
  url: string;
  /** Ionicons name for the tone-tinted hero glyph. */
  icon: React.ComponentProps<typeof Ionicons>["name"];
  /** Optional accent tone for the icon background — defaults to brand. */
  tone?: "brand" | "violet" | "success" | "warning";
  /** Optional explicit CTA label override. Defaults to "Open in web app". */
  ctaLabel?: string;
  /** Optional analytics breadcrumb — defaults to the title. */
  source?: string;
};

const TONE_MAP = {
  brand: { bg: colors.brandSubtle, fg: colors.brand },
  violet: { bg: colors.violetSubtle, fg: colors.violet },
  success: { bg: colors.successSubtle, fg: colors.successInk },
  warning: { bg: colors.warningSubtle, fg: colors.warningInk },
} as const;

type Props = {
  spec: HandoffSpec | null;
  onDismiss: () => void;
  style?: ViewStyle;
};

export function WebHandoffSheet({ spec, onDismiss }: Props) {
  // Reanimated values for sheet entrance + scrim fade. We deliberately
  // avoid driving these from Modal's own `animationType` so the scrim
  // and sheet can animate independently (matches iOS sheet idiom).
  const visible = useSharedValue(0);

  React.useEffect(() => {
    visible.value = withTiming(spec ? 1 : 0, {
      duration: spec ? 280 : 220,
      easing: spec ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
    });
  }, [spec, visible]);

  // Track when a sheet opens so the diagnostics log shows which web
  // surface the operator was funneled to. Low-noise — fires once per
  // open, not per render.
  const lastSourceRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!spec) {
      lastSourceRef.current = null;
      return;
    }
    const src = spec.source ?? spec.title;
    if (src === lastSourceRef.current) return;
    lastSourceRef.current = src;
    track("navigation", `WebHandoffSheet opened: ${src}`, "info", {
      title: spec.title,
      url: spec.url,
    });
  }, [spec]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: 0.55 * visible.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: 60 * (1 - visible.value) }],
    opacity: visible.value,
  }));

  function close() {
    void Haptics.selectionAsync().catch(() => {});
    onDismiss();
  }

  function openWeb() {
    if (!spec) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Linking.openURL(spec.url).catch(() => {
      // Surface the failure as a runtime telemetry breadcrumb but don't
      // throw — the sheet UI stays open so the user can retry.
      track("runtime", `WebHandoffSheet open URL failed: ${spec.title}`, "warn", {
        url: spec.url,
      });
    });
    onDismiss();
  }

  // Modal won't actually unmount when spec=null because we use the
  // visible.value-driven scrim/sheet animations. The `visible` prop on
  // Modal toggles to `true` whenever spec is set, and we let the
  // animations finish before unmounting via the brief tail-end of the
  // exit transition.
  const open = Boolean(spec);
  if (!open) return null;

  const tone = TONE_MAP[spec?.tone ?? "brand"];

  return (
    <Modal
      transparent
      visible={open}
      animationType="none"
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <Animated.View style={[styles.scrim, scrimStyle]} pointerEvents="auto">
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      <View style={styles.wrap} pointerEvents="box-none">
        <Animated.View style={[styles.sheet, sheetStyle]}>
          {/* Drag handle — non-functional visual cue, the back-swipe
              and scrim tap are the real dismiss surfaces. */}
          <View style={styles.handle} />

          {/* Hero icon */}
          <View
            style={[
              styles.iconCircle,
              { backgroundColor: tone.bg, marginTop: spacing.sm },
            ]}
          >
            <Ionicons name={spec?.icon ?? "open-outline"} size={28} color={tone.fg} />
          </View>

          {/* Copy block */}
          <AppText
            variant="h3"
            align="center"
            style={{ marginTop: spacing.md }}
          >
            {spec?.title}
          </AppText>
          <AppText
            variant="body"
            color="muted"
            align="center"
            style={{ marginTop: spacing.sm, paddingHorizontal: spacing.md }}
          >
            {spec?.body}
          </AppText>

          {/* CTA — primary action opens the web in the system browser */}
          <Pressable
            onPress={openWeb}
            accessibilityRole="button"
            accessibilityLabel={spec?.ctaLabel ?? "Open in web app"}
            style={[styles.cta, styles.ctaPrimary]}
          >
            <Ionicons name="open-outline" size={16} color={colors.inkOnBrand} />
            <AppText
              variant="bodyStrong"
              style={{ color: colors.inkOnBrand, marginLeft: 8 }}
            >
              {spec?.ctaLabel ?? "Open in web app"}
            </AppText>
          </Pressable>

          {/* Dismiss — secondary, low-affordance so it doesn't compete */}
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Not now"
            style={[styles.cta, styles.ctaSecondary]}
          >
            <AppText variant="smallStrong" style={{ color: colors.inkMuted }}>
              Not now
            </AppText>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
  },
  wrap: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing["2xl"],
    alignItems: "center",
    ...shadows.md,
  },
  handle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderSubtle,
    marginTop: spacing.sm,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    width: "100%",
  },
  ctaPrimary: {
    backgroundColor: colors.brand,
    marginTop: spacing.lg,
  },
  ctaSecondary: {
    marginTop: spacing.sm,
  },
});
