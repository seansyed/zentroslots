/**
 * SettingsRow + SettingsGroup — premium enterprise settings primitive.
 *
 * Replaces the old "card with internal dividers + tight padding" pattern
 * with individually floating rows on a tinted backdrop. Reads more like
 * a high-end native settings surface (Things 3, Linear, Notion mobile)
 * and less like a HTML table.
 *
 * Why two components, not one:
 *   • SettingsGroup owns the eyebrow + the inter-row rhythm. Centralising
 *     it stops every consumer from re-implementing spacing.
 *   • SettingsRow owns the row chrome (icon chip, title, description,
 *     accessory, chevron) + press animation + haptics.
 *
 * Usage:
 *
 *   <SettingsGroup title="Account">
 *     <SettingsRow
 *       icon="person-outline"
 *       label="Profile"
 *       description="Name, photo, timezone"
 *       onPress={() => router.push("/settings/profile")}
 *     />
 *     ...
 *   </SettingsGroup>
 */

import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { AppText } from "@/components/ui/Text";
import { colors, layout, radius, shadows, spacing } from "@/theme";

export type SettingsRowTone = "brand" | "violet" | "success" | "warning" | "danger" | "neutral";

const TONE_MAP: Record<SettingsRowTone, { bg: string; fg: string }> = {
  brand: { bg: colors.brandSubtle, fg: colors.brand },
  violet: { bg: colors.violetSubtle, fg: colors.violet },
  success: { bg: colors.successSubtle, fg: colors.successInk },
  warning: { bg: colors.warningSubtle, fg: colors.warningInk },
  danger: { bg: colors.dangerSubtle, fg: colors.dangerInk },
  neutral: { bg: colors.surfaceInset, fg: colors.inkMuted },
};

type RowProps = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  description?: string;
  onPress: () => void;
  /** Right-side accessory — e.g. a plan Pill. Replaces the chevron. */
  accessory?: React.ReactNode;
  /** Right-side trailing icon override (defaults to chevron-forward). */
  trailingIcon?: React.ComponentProps<typeof Ionicons>["name"];
  /** Tone for the icon chip — defaults to "brand". */
  tone?: SettingsRowTone;
  accessibilityLabel?: string;
  /** Optional disabled state — dims the row + skips haptics. */
  disabled?: boolean;
};

function SettingsRowImpl({
  icon,
  label,
  description,
  onPress,
  accessory,
  trailingIcon = "chevron-forward",
  tone = "brand",
  accessibilityLabel,
  disabled,
}: RowProps) {
  // Spring-driven press feedback. We use a shared value so the
  // entrance is smooth and the release settles with a tactile bounce
  // rather than the ON/OFF flicker Pressable gives by default.
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  function handlePressIn() {
    if (disabled) return;
    scale.value = withSpring(0.985, { damping: 18, stiffness: 320, mass: 0.6 });
    opacity.value = withTiming(0.94, { duration: 80 });
  }
  function handlePressOut() {
    scale.value = withSpring(1, { damping: 14, stiffness: 240, mass: 0.6 });
    opacity.value = withTiming(1, { duration: 140 });
  }
  function handlePress() {
    if (disabled) return;
    void Haptics.selectionAsync().catch(() => {});
    onPress();
  }

  const chip = TONE_MAP[tone];

  return (
    <Animated.View style={[animStyle, disabled && { opacity: 0.55 }]}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: !!disabled }}
        style={styles.row}
      >
        <View style={[styles.iconChip, { backgroundColor: chip.bg }]}>
          <Ionicons name={icon} size={20} color={chip.fg} />
        </View>

        <View style={styles.copy}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {label}
          </AppText>
          {description ? (
            <AppText
              variant="caption"
              color="muted"
              numberOfLines={1}
              style={styles.description}
            >
              {description}
            </AppText>
          ) : null}
        </View>

        {accessory ? (
          <View style={styles.accessory}>{accessory}</View>
        ) : (
          <Ionicons
            name={trailingIcon}
            size={18}
            color={colors.inkSubtle}
            style={styles.trailing}
          />
        )}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Phase 3: memoized so a parent re-render (e.g. Settings tab state
 * changes after profile refetch) doesn't ripple through every row
 * with identical props. Shallow-compare is sufficient — all props are
 * primitives or stable callbacks from the call sites.
 */
export const SettingsRow = React.memo(SettingsRowImpl);

type GroupProps = {
  /** Eyebrow label above the floating row stack. */
  title?: string;
  /** Optional trailing text/element next to the eyebrow (e.g. "5 items"). */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  /** Override the inter-row gap if you really need to. */
  rowGap?: number;
};

export function SettingsGroup({ title, trailing, children, rowGap }: GroupProps) {
  const gap = rowGap ?? layout.rowFloatGap;
  return (
    <View>
      {title ? (
        <View style={styles.eyebrowRow}>
          <AppText variant="eyebrow" color="muted" style={styles.eyebrowText}>
            {title}
          </AppText>
          {trailing ? <View>{trailing}</View> : null}
        </View>
      ) : null}
      <View style={{ gap }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
  },
  eyebrowText: {
    // Slightly tighter than default eyebrow to sit closer to the rows
    // it's labelling.
    letterSpacing: 1.1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius["2xl"],
    paddingHorizontal: layout.rowInsetX,
    paddingVertical: layout.rowInsetY,
    gap: spacing.md,
    // Hairline border keeps the surface defined even on glossy displays
    // where shadows look subdued. Acts as the "soft border" in the brief.
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadows.ambient,
  },
  iconChip: {
    width: 38,
    height: 38,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  description: {
    marginTop: 2,
  },
  accessory: {
    flexShrink: 0,
    marginLeft: spacing.xs,
  },
  trailing: {
    marginLeft: spacing.xs,
  },
});
