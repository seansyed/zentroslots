/**
 * NotificationBellButton — pressable bell + live unread badge.
 *
 * Used by PageHeader on every non-Home tab AND surfaceable in the Home
 * hero's right-column. Driven by useUnreadNotificationCount() which
 * polls /api/notifications/unread-count every 30s plus refetches on
 * window focus.
 *
 * The badge is sized + positioned defensively so it stays visible
 * against any header background, isn't clipped by parent layout, and
 * never blocks the bell's tap target.
 */

import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { AppText } from "@/components/ui/Text";
import { useUnreadNotificationCount } from "@/hooks/useNotifications";
import { colors, radius, spacing } from "@/theme";

type Props = {
  /** Override the destination route. Defaults to /notifications. */
  href?: string;
  /** Override the icon size. Default 22. */
  size?: number;
};

export function NotificationBellButton({ href = "/notifications", size = 22 }: Props) {
  const router = useRouter();
  const q = useUnreadNotificationCount();
  // Fall back to 0 on undefined / error — the bell is decorative.
  const unread = typeof q.data === "number" ? q.data : 0;

  function onPress() {
    void Haptics.selectionAsync().catch(() => {});
    router.push(href as Parameters<typeof router.push>[0]);
  }

  // Single-digit vs 9+ vs 99+ — the visual contract used by Linear/Slack/
  // every mature SaaS. Caps the badge width so a tenant with 200
  // unread doesn't blow out the header layout.
  const label =
    unread <= 0 ? null : unread > 99 ? "99+" : unread > 9 ? `${unread}` : `${unread}`;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
      }
      style={styles.btn}
    >
      <Ionicons name="notifications-outline" size={size} color={colors.ink} />
      {label ? (
        <View
          pointerEvents="none"
          style={styles.badge}
        >
          <AppText variant="micro" style={styles.badgeText}>
            {label}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    // Same footprint as IconButton elsewhere so the bell aligns nicely
    // with the avatar + any other icon controls in the trailing slot.
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    // overflow: visible so the badge can overhang the icon's corner.
    // Default View is visible already but we're explicit so a parent
    // wrapper can't accidentally clip via overflow inheritance.
    overflow: "visible",
  },
  badge: {
    position: "absolute",
    // Slight overhang past the icon's top-right corner — the standard
    // notification badge silhouette.
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
    // White ring lifts the red pill off any header background. Same
    // treatment as iOS's native badge — works equally well on light
    // surfaces and on the home hero's gradient.
    borderWidth: 2,
    borderColor: colors.surface,
  },
  badgeText: {
    color: colors.inkOnBrand,
    fontWeight: "700",
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0,
    paddingHorizontal: 1,
  },
});
