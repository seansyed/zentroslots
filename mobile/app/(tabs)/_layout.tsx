/**
 * (tabs) layout — the 5-tab bottom navigator.
 *
 *   Home · Calendar · Appointments · Customers · Settings
 *
 * Visual treatment (Phase 2F refinement):
 *   • Surface lifts off content with a soft top shadow + hairline border
 *   • Brand-tinted active state (icon + label) plus an inline glow chip
 *     behind the active icon for the premium enterprise feel
 *   • Inactive uses ink-subtle for restraint
 *   • Tab labels small + medium-weight; icons 22px
 *   • Safe-area aware on iPhone X+ — we read the bottom inset directly
 *     so the bar always sits above the home indicator with consistent
 *     breathing room across devices.
 */

import * as React from "react";
import { Platform, StyleSheet, View, type ColorValue } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppointments } from "@/hooks/useAppointments";
import { shouldShowPhoneEntry } from "@/lib/businessPhone";
import { colors, radius, shadows, typography } from "@/theme";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Active state for an icon includes a soft brand chip behind the
 * glyph — the "luxury" version of the focused tab. Inactive renders
 * the plain outline icon at the same size.
 */
function tabIcon(name: IoniconName, focusedName: IoniconName) {
  return ({ focused, color, size }: { focused: boolean; color: ColorValue; size: number }) => {
    if (focused) {
      return (
        <View style={styles.activeIconWrap}>
          <View style={styles.activeIconChip} />
          <Ionicons name={focusedName} size={size} color={color} />
        </View>
      );
    }
    return <Ionicons name={name} size={size} color={color} />;
  };
}

export default function TabsLayout() {
  // Live pending-bookings count — fed into the Bookings tab badge so
  // operators see "you have N to confirm" at a glance from anywhere
  // in the app. Pulls the same 90-day window we already cache for the
  // dashboard, so this is a free read — no extra request.
  const pendingQ = useAppointments({ status: "pending", limit: 50 });
  const pendingCount = pendingQ.data?.rows?.length ?? 0;

  // Business Phone entry is shown to ALL signed-in users (M3): the screen
  // renders marketing for the non-entitled, setup-pending / active / locked for
  // the rest. The route file always exists; the Phone screen decides the state.
  const showPhone = shouldShowPhoneEntry();

  // Safe-area aware bottom padding so the bar always clears the home
  // indicator with the same visual breathing room across devices.
  // On Android (no home indicator) we still pay a small floor (10) so
  // the bar never hugs the screen edge.
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, Platform.OS === "ios" ? 24 : 10);
  const barHeight =
    Platform.OS === "ios" ? 60 + bottomPad : 60 + bottomPad;

  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          // Light selection feedback on tab switch — matches native
          // iOS/Android system app behaviour. Silently no-ops on web
          // and on devices without a Taptic engine.
          void Haptics.selectionAsync().catch(() => {});
        },
      }}
      screenOptions={{
        headerShown: false,
        // Icons-only bottom nav — hide the text labels under each icon. The
        // per-screen `title` is kept (it still drives the tab's
        // accessibilityLabel for screen readers); React Navigation centers the
        // icon automatically when the label is hidden.
        tabBarShowLabel: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.inkSubtle,
        tabBarStyle: [
          styles.tabBar,
          {
            height: barHeight,
            paddingBottom: bottomPad,
          },
        ],
        tabBarItemStyle: styles.tabItem,
        tabBarLabelStyle: styles.tabLabel,
        tabBarIconStyle: styles.tabIcon,
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: tabIcon("home-outline", "home"),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Calendar",
          tabBarIcon: tabIcon("calendar-outline", "calendar"),
        }}
      />
      <Tabs.Screen
        name="appointments"
        options={{
          title: "Bookings",
          tabBarIcon: tabIcon("checkmark-done-circle-outline", "checkmark-done-circle"),
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
          tabBarBadgeStyle: styles.badge,
        }}
      />
      <Tabs.Screen
        name="phone"
        options={
          showPhone
            ? { title: "Phone", tabBarIcon: tabIcon("call-outline", "call") }
            : { href: null } // hidden + unreachable as a tab when not allowed
        }
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: "Customers",
          tabBarIcon: tabIcon("people-outline", "people"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: tabIcon("settings-outline", "settings"),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    // Lift the bar off the content underneath. Phase 2F bumped this
    // from `sm` → `lg` for a more deliberate separation from the
    // scrollable surface above. Casts a shadow upward via the
    // negative offset baked into the shadow tokens.
    ...shadows.lg,
  },
  tabItem: {
    paddingVertical: 4,
  },
  tabLabel: {
    fontSize: 11,
    fontFamily: typography.smallStrong.fontFamily,
    letterSpacing: 0.3,
    marginTop: 3,
  },
  tabIcon: {
    marginTop: 0,
  },
  /** Active-icon container. The chip behind the glyph gives focused
   *  tabs the premium "you are here" cue without going pill-style
   *  (which would steal too much vertical space). */
  activeIconWrap: {
    width: 38,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  activeIconChip: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.brandSubtle,
    borderRadius: radius.lg,
  },
  // Brand-tinted live badge — high-contrast enough to read at a glance
  // but not loud. Renders next to the Bookings icon when there are
  // pending bookings awaiting confirmation.
  badge: {
    backgroundColor: colors.warning,
    color: "#1f1300",
    fontSize: 11,
    fontWeight: "700",
    minWidth: 16,
    height: 16,
    lineHeight: 16,
  },
});
