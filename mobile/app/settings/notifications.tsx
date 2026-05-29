/**
 * /settings/notifications — native notification preferences hub.
 *
 * What lives natively:
 *   • Current device-level push permission status (granted / denied
 *     / undetermined) with a one-tap path to the OS settings on
 *     native, or a clear "enable in browser settings" cue on web.
 *   • In-app notification inbox link (the existing /notifications
 *     route is the canonical read surface).
 *
 * What stays on the web (for now, via WebHandoffSheet):
 *   • Email-channel toggles (digest, daily summary, etc.)
 *   • Per-event template configuration (booking_created copy, etc.)
 *   • Advanced delivery rules / quiet hours
 *
 * The split is deliberate: device push state is a NATIVE concern
 * (the OS owns the permission), while channel + template config is
 * tenant-level admin work better-suited to the web's editor surface.
 */

import * as React from "react";
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import * as Notifications from "expo-notifications";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { Card, PressableCard } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SettingsGroup, SettingsRow } from "@/components/ui/SettingsRow";
import { AppText } from "@/components/ui/Text";
import { WebHandoffSheet, type HandoffSpec } from "@/components/ui/WebHandoffSheet";
import { env } from "@/lib/env";
import { colors, layout, radius, shadows, spacing } from "@/theme";

type PermissionStatus = "granted" | "denied" | "undetermined" | "loading" | "unsupported";

function statusCopy(s: PermissionStatus): { tone: PillTone; label: string; body: string } {
  switch (s) {
    case "granted":
      return {
        tone: "success",
        label: "Enabled",
        body: "You'll get push notifications for new bookings, reschedules, and reminders.",
      };
    case "denied":
      return {
        tone: "danger",
        label: "Blocked",
        body: "Push is turned off in your device settings. Re-enable to get real-time booking alerts.",
      };
    case "undetermined":
      return {
        tone: "warning",
        label: "Not asked yet",
        body: "We haven't asked for permission yet. Tap below to enable real-time booking alerts.",
      };
    case "unsupported":
      return {
        tone: "neutral",
        label: "Not supported here",
        body: "This device/browser doesn't support native push. Your alerts will still show in the in-app inbox.",
      };
    case "loading":
    default:
      return { tone: "neutral", label: "Checking…", body: "" };
  }
}

export default function NotificationsPrefsScreen() {
  const router = useRouter();
  const [status, setStatus] = React.useState<PermissionStatus>("loading");
  const [sheet, setSheet] = React.useState<HandoffSpec | null>(null);

  // ── Permission lookup ───────────────────────────────────────
  // expo-notifications throws on web in some browsers, so we wrap
  // every call. The "unsupported" status is a clean catch-all for
  // any environment where push isn't available.
  const refreshStatus = React.useCallback(async () => {
    try {
      const res = await Notifications.getPermissionsAsync();
      const s = res.status as Notifications.PermissionStatus;
      setStatus(s === "granted" ? "granted" : s === "denied" ? "denied" : "undetermined");
    } catch {
      setStatus("unsupported");
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function requestPermission() {
    void Haptics.selectionAsync().catch(() => {});
    try {
      const res = await Notifications.requestPermissionsAsync();
      const s = res.status as Notifications.PermissionStatus;
      setStatus(s === "granted" ? "granted" : s === "denied" ? "denied" : "undetermined");
    } catch {
      setStatus("unsupported");
    }
  }

  function openOsSettings() {
    void Haptics.selectionAsync().catch(() => {});
    // expo-linking openSettings is the canonical path on iOS/Android;
    // on web there isn't a notion of OS settings — point them at the
    // browser's site-permissions panel via a friendly note instead.
    if (Platform.OS === "web") {
      setSheet({
        icon: "lock-closed-outline",
        tone: "warning",
        title: "Re-enable browser notifications",
        body:
          "Click the lock or info icon in your browser's address bar and switch Notifications to 'Allow'. Reload this page after.",
        url: "https://support.google.com/chrome/answer/3220216",
        ctaLabel: "How to allow in browser",
        source: "notifications.osSettings.web",
      });
      return;
    }
    Linking.openSettings().catch(() => {
      // Fall back to the handoff sheet if openSettings is unavailable
      // (extremely rare on supported native builds).
      setSheet({
        icon: "settings-outline",
        tone: "warning",
        title: "Open device settings",
        body:
          "Couldn't open settings automatically. Go to your device's Settings → Notifications → ZentroMeet to allow push.",
        url: "",
        ctaLabel: "Got it",
        source: "notifications.osSettings.fallback",
      });
    });
  }

  function openWebChannels() {
    void Haptics.selectionAsync().catch(() => {});
    setSheet({
      icon: "mail-outline",
      tone: "brand",
      title: "Email + advanced rules",
      body:
        "Email digests, per-event templates, quiet hours, and delivery routing live in the web app. Push toggles on this device stay here.",
      url: `${env.apiBaseUrl}/dashboard/notifications`,
      source: "notifications.emailRules",
    });
  }

  const copy = statusCopy(status);

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/settings");
          }}
        />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          Notifications
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Push status hero ─────────────────────────────────── */}
        <SectionFade>
          <Card variant="elevated" style={styles.hero} padding={spacing.xl}>
            <View style={styles.heroRow}>
              <View style={[
                styles.iconCircle,
                {
                  backgroundColor:
                    status === "granted" ? colors.successSubtle :
                    status === "denied" ? colors.dangerSubtle :
                    status === "undetermined" ? colors.warningSubtle :
                    colors.surfaceInset,
                },
              ]}>
                <Ionicons
                  name={
                    status === "granted" ? "notifications" :
                    status === "denied" ? "notifications-off-outline" :
                    "notifications-outline"
                  }
                  size={22}
                  color={
                    status === "granted" ? colors.successInk :
                    status === "denied" ? colors.dangerInk :
                    status === "undetermined" ? colors.warningInk :
                    colors.inkMuted
                  }
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <AppText variant="bodyStrong">Push notifications</AppText>
                  {status !== "loading" ? (
                    <Pill tone={copy.tone}>{copy.label}</Pill>
                  ) : null}
                </View>
                <AppText
                  variant="small"
                  color="muted"
                  style={{ marginTop: 4 }}
                >
                  {copy.body}
                </AppText>
              </View>
            </View>

            {/* Action row driven by status */}
            {status === "undetermined" ? (
              <PressableCard
                variant="plain"
                padding={0}
                onPress={requestPermission}
                style={[styles.action, { backgroundColor: colors.brand, marginTop: spacing.md }]}
                accessibilityRole="button"
                accessibilityLabel="Enable push notifications"
              >
                <Ionicons name="notifications" size={16} color={colors.inkOnBrand} />
                <AppText variant="smallStrong" style={{ color: colors.inkOnBrand, marginLeft: 6 }}>
                  Enable push
                </AppText>
              </PressableCard>
            ) : status === "denied" ? (
              <PressableCard
                variant="plain"
                padding={0}
                onPress={openOsSettings}
                style={[styles.action, styles.actionSecondary, { marginTop: spacing.md }]}
                accessibilityRole="button"
                accessibilityLabel="Open settings"
              >
                <Ionicons name="settings-outline" size={16} color={colors.ink} />
                <AppText variant="smallStrong" style={{ color: colors.ink, marginLeft: 6 }}>
                  {Platform.OS === "web" ? "How to re-enable" : "Open device settings"}
                </AppText>
              </PressableCard>
            ) : null}
          </Card>
        </SectionFade>

        {/* ── In-app inbox quick link ──────────────────────────── */}
        <SectionFade delay={80} style={{ marginTop: spacing.xl }}>
          <SettingsGroup title="On this device">
            <SettingsRow
              icon="albums-outline"
              label="Notification inbox"
              description="Booking alerts, reschedules, and system events"
              tone="brand"
              onPress={() => router.push("/notifications")}
            />
          </SettingsGroup>
        </SectionFade>

        {/* ── Web-only advanced surfaces ───────────────────────── */}
        <SectionFade delay={140} style={{ marginTop: spacing.xl }}>
          <SettingsGroup title="Advanced">
            <SettingsRow
              icon="mail-outline"
              label="Email + delivery rules"
              description="Digests, templates, quiet hours · opens web"
              tone="brand"
              trailingIcon="open-outline"
              onPress={openWebChannels}
            />
          </SettingsGroup>
        </SectionFade>

        <View style={{ height: spacing["3xl"] }} />
      </ScrollView>

      <WebHandoffSheet spec={sheet} onDismiss={() => setSheet(null)} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surfaceSubtle,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topTitle: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  /** Hero card lift — softer, larger-blur shadow so it reads as the
   *  anchor for the entire screen. Phase 2F. */
  hero: {
    borderRadius: radius["2xl"],
    ...shadows.floating,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.full,
    alignSelf: "flex-start",
  },
  actionSecondary: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
});
