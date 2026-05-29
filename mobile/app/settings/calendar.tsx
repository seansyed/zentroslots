/**
 * /settings/calendar — native calendar-connections surface.
 *
 * Phase 2G — replaces the previous WebHandoffSheet jump for "Calendar
 * infrastructure". This screen lists every provider connection for the
 * current user with first-class status, account email, and last-sync
 * time. Connect flows open the system browser via Linking.openURL;
 * disconnect flows post to the backend with a confirm dialog.
 *
 * Why we still open the system browser instead of an in-app webview:
 *   • The Google + Microsoft OAuth consent screens block embedded
 *     webviews (they detect them and refuse to render). Using the
 *     system browser is the supported path.
 *   • The backend already handles the `?mobile=1` callback by
 *     redirecting to a `zentromeet://` deep link — the OS hand-off
 *     is automatic.
 *
 * What still hands off to web:
 *   • Per-event sync rules (which calendar to sync to, which to read)
 *     — advanced admin config, lives at /dashboard/settings/calendar.
 */

import * as React from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { ApiError } from "@/api/client";
import {
  calendarConnectionsApi,
  type CalendarConnection,
  type CalendarProvider,
} from "@/api/calendarConnections";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { WebHandoffSheet, type HandoffSpec } from "@/components/ui/WebHandoffSheet";
import {
  useCalendarConnections,
  useDisconnectCalendar,
} from "@/hooks/useCalendarConnections";
import { useProfile } from "@/hooks/useProfile";
import { env } from "@/lib/env";
import { track } from "@/lib/telemetry";
import { colors, layout, radius, shadows, spacing } from "@/theme";

type ProviderMeta = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  tagline: string;
  brandBg: string;
  brandFg: string;
};

const PROVIDER_META: Record<CalendarProvider, ProviderMeta> = {
  google: {
    icon: "logo-google",
    label: "Google Calendar",
    tagline: "Sync external busy time + create events automatically",
    brandBg: colors.brandSubtle,
    brandFg: colors.brand,
  },
  microsoft: {
    icon: "logo-microsoft",
    label: "Microsoft Calendar",
    tagline: "Outlook / Microsoft 365 calendar sync",
    brandBg: colors.violetSubtle,
    brandFg: colors.violet,
  },
  zoom: {
    icon: "videocam-outline",
    label: "Zoom",
    tagline: "Auto-create Zoom links for new bookings",
    brandBg: colors.surfaceInset,
    brandFg: colors.inkMuted,
  },
};

function statusTone(status: CalendarConnection["status"]): PillTone {
  if (status === "connected") return "success";
  if (status === "error") return "danger";
  return "neutral";
}

function statusLabel(status: CalendarConnection["status"]): string {
  if (status === "connected") return "Connected";
  if (status === "error") return "Sync error";
  return "Not connected";
}

function formatRelative(iso: string | null, now: number): string {
  if (!iso) return "Never synced";
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return "Synced moments ago";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `Synced ${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `Synced ${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `Synced ${day}d ago`;
  return `Synced ${new Date(iso).toLocaleDateString()}`;
}

export default function CalendarConnectionsScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const userId = profileQ.data?.id;
  const connectionsQ = useCalendarConnections(userId);
  const disconnectMut = useDisconnectCalendar(userId);

  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // When the user returns from the OAuth browser, refetch so the new
  // connection appears. We hook AppState via a focus refetch on the
  // query; an explicit refetch on focus belt-and-braces.
  React.useEffect(() => {
    const sub = Linking.addEventListener("url", (event) => {
      if (event.url.startsWith("zentromeet://")) {
        // The deep-link handler in _layout.tsx already routes us back
        // into the app; we just need to refresh.
        void connectionsQ.refetch();
        void profileQ.refetch();
      }
    });
    return () => sub.remove();
  }, [connectionsQ, profileQ]);

  function openConnect(provider: "google" | "microsoft") {
    void Haptics.selectionAsync().catch(() => {});
    const url = calendarConnectionsApi.connectUrl(provider);
    track("navigation", `Calendar connect: ${provider}`, "info", { url });
    Linking.openURL(url).catch(() => {
      Alert.alert(
        "Couldn't open browser",
        "Open your device's browser and try again.",
      );
    });
  }

  function confirmDisconnect(row: CalendarConnection) {
    const meta = PROVIDER_META[row.provider];
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      `Disconnect ${meta.label}?`,
      "External busy time will stop syncing and new bookings won't push events. You can reconnect at any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            void Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Warning,
            ).catch(() => {});
            void disconnectMut.mutateAsync(row.id);
          },
        },
      ],
      { cancelable: true },
    );
  }

  const [sheet, setSheet] = React.useState<HandoffSpec | null>(null);
  function openAdvancedHandoff() {
    void Haptics.selectionAsync().catch(() => {});
    setSheet({
      icon: "options-outline",
      tone: "brand",
      title: "Advanced calendar rules",
      body:
        "Per-calendar sync direction, conflict rules, and writable-calendar selection are easier to manage from the desktop dashboard. Connect/disconnect lives here on mobile.",
      url: `${env.apiBaseUrl}/dashboard/settings/calendar`,
      source: "calendar.advancedWeb",
    });
  }

  // Build the visible list — always show Google + Microsoft slots
  // even when not connected, so users discover the connect CTA.
  const connections = connectionsQ.data ?? [];
  const byProvider: Record<CalendarProvider, CalendarConnection | undefined> = {
    google: connections.find((c) => c.provider === "google"),
    microsoft: connections.find((c) => c.provider === "microsoft"),
    zoom: connections.find((c) => c.provider === "zoom"),
  };

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
          Calendar
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <SectionFade>
          <AppText variant="caption" color="muted" style={styles.intro}>
            Connect external calendars so their busy time blocks your
            bookable hours and new bookings push events automatically.
          </AppText>
        </SectionFade>

        {/* Provider cards */}
        <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
          {connectionsQ.isLoading && !connectionsQ.data ? (
            <View style={{ gap: spacing.md }}>
              <Shimmer.Card height={120} />
              <Shimmer.Card height={120} />
            </View>
          ) : connectionsQ.isError ? (
            <Card style={styles.errorCard}>
              <ErrorState
                kind={
                  connectionsQ.error instanceof ApiError
                    ? connectionsQ.error.kind
                    : "unknown"
                }
                description={
                  connectionsQ.error instanceof Error
                    ? connectionsQ.error.message
                    : undefined
                }
                onRetry={() => {
                  void Haptics.impactAsync(
                    Haptics.ImpactFeedbackStyle.Light,
                  ).catch(() => {});
                  void connectionsQ.refetch();
                }}
              />
            </Card>
          ) : (
            <View style={{ gap: 12 }}>
              <ProviderCard
                provider="google"
                connection={byProvider.google}
                now={now}
                onConnect={() => openConnect("google")}
                onDisconnect={confirmDisconnect}
                disconnecting={
                  disconnectMut.isPending &&
                  disconnectMut.variables === byProvider.google?.id
                }
              />
              <ProviderCard
                provider="microsoft"
                connection={byProvider.microsoft}
                now={now}
                onConnect={() => openConnect("microsoft")}
                onDisconnect={confirmDisconnect}
                disconnecting={
                  disconnectMut.isPending &&
                  disconnectMut.variables === byProvider.microsoft?.id
                }
              />
            </View>
          )}
        </SectionFade>

        {/* Quick re-check */}
        <SectionFade delay={120} style={{ marginTop: spacing.lg }}>
          <AppText
            variant="micro"
            color="subtle"
            align="center"
            style={{ paddingHorizontal: spacing.lg, letterSpacing: 0.3 }}
          >
            CONNECTIONS REFRESH AUTOMATICALLY AFTER YOU RETURN FROM THE
            CONSENT SCREEN. PULL TO REFRESH IF SOMETHING LOOKS STALE.
          </AppText>
        </SectionFade>

        {/* Advanced web-handoff */}
        <SectionFade delay={160} style={{ marginTop: spacing["2xl"] }}>
          <Card variant="outline" style={styles.handoffCard}>
            <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
              <Ionicons name="options-outline" size={20} color={colors.brand} />
              <AppText
                variant="bodyStrong"
                align="center"
                style={{ marginTop: spacing.sm }}
              >
                Advanced sync rules
              </AppText>
              <AppText
                variant="small"
                color="muted"
                align="center"
                style={{ marginTop: 4, paddingHorizontal: spacing.lg }}
              >
                Conflict resolution, writable-calendar selection, and
                multi-calendar rules live on the desktop dashboard.
              </AppText>
              <View style={{ height: spacing.md }} />
              <Pill tone="brand">
                <AppText
                  variant="smallStrong"
                  style={{ color: colors.brand }}
                  onPress={openAdvancedHandoff}
                >
                  Open on the web →
                </AppText>
              </Pill>
            </View>
          </Card>
        </SectionFade>

        <View style={{ height: spacing["3xl"] }} />
      </ScrollView>

      <WebHandoffSheet spec={sheet} onDismiss={() => setSheet(null)} />
    </ScreenContainer>
  );
}

type CardProps = {
  provider: "google" | "microsoft";
  connection: CalendarConnection | undefined;
  now: number;
  onConnect: () => void;
  onDisconnect: (row: CalendarConnection) => void;
  disconnecting: boolean;
};

function ProviderCard({
  provider,
  connection,
  now,
  onConnect,
  onDisconnect,
  disconnecting,
}: CardProps) {
  const meta = PROVIDER_META[provider];
  const connected = connection?.status === "connected";
  const tone = connection ? statusTone(connection.status) : "neutral";

  return (
    <Card style={styles.providerCard} padding={spacing.lg}>
      <View style={styles.providerHeader}>
        <View
          style={[styles.providerIconChip, { backgroundColor: meta.brandBg }]}
        >
          <Ionicons name={meta.icon} size={24} color={meta.brandFg} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.providerTitleRow}>
            <AppText variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
              {meta.label}
            </AppText>
            <Pill tone={tone}>{statusLabel(connection?.status ?? "disconnected")}</Pill>
          </View>
          <AppText
            variant="caption"
            color="muted"
            numberOfLines={2}
            style={{ marginTop: 2 }}
          >
            {meta.tagline}
          </AppText>
        </View>
      </View>

      {connection ? (
        <View style={styles.providerMetaRow}>
          {connection.accountEmail ? (
            <View style={styles.metaItem}>
              <Ionicons name="mail-outline" size={12} color={colors.inkSubtle} />
              <AppText
                variant="micro"
                color="muted"
                numberOfLines={1}
                style={{ marginLeft: 4, flexShrink: 1 }}
              >
                {connection.accountEmail}
              </AppText>
            </View>
          ) : null}
          <View style={styles.metaItem}>
            <Ionicons name="sync-outline" size={12} color={colors.inkSubtle} />
            <AppText
              variant="micro"
              color="muted"
              numberOfLines={1}
              style={{ marginLeft: 4 }}
            >
              {formatRelative(connection.lastSyncedAt, now)}
            </AppText>
          </View>
        </View>
      ) : null}

      {connection?.status === "error" && connection.lastError ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={14} color={colors.dangerInk} />
          <AppText
            variant="caption"
            style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}
            numberOfLines={2}
          >
            {connection.lastError}
          </AppText>
        </View>
      ) : null}

      <View style={styles.providerActions}>
        {connected ? (
          <View style={styles.actionPairWrap}>
            <View style={[styles.actionBtn, styles.actionSecondary]}>
              <AppText
                variant="smallStrong"
                style={{ color: colors.ink }}
                onPress={onConnect}
                accessibilityRole="button"
                accessibilityLabel={`Reconnect ${meta.label}`}
              >
                Reconnect
              </AppText>
            </View>
            <View style={[styles.actionBtn, styles.actionDanger]}>
              <AppText
                variant="smallStrong"
                style={{
                  color: disconnecting ? colors.inkSubtle : colors.dangerInk,
                }}
                onPress={() => {
                  if (disconnecting || !connection) return;
                  onDisconnect(connection);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Disconnect ${meta.label}`}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </AppText>
            </View>
          </View>
        ) : (
          <View style={[styles.actionBtn, styles.actionPrimary]}>
            <Ionicons
              name="link-outline"
              size={14}
              color={colors.inkOnBrand}
              style={{ marginRight: 6 }}
            />
            <AppText
              variant="smallStrong"
              style={{ color: colors.inkOnBrand }}
              onPress={onConnect}
              accessibilityRole="button"
              accessibilityLabel={`Connect ${meta.label}`}
            >
              Connect {meta.label}
            </AppText>
          </View>
        )}
      </View>
    </Card>
  );
}

// referenced to silence unused-import warning when EmptyState branch
// isn't visible (the screen always shows provider cards, but we keep
// the import available for future "no connectable providers" copy).
void EmptyState;

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
  intro: {
    paddingHorizontal: spacing.xs,
    lineHeight: 18,
  },
  errorCard: {
    borderRadius: radius["2xl"],
    ...shadows.ambient,
  },
  providerCard: {
    borderRadius: radius["2xl"],
    ...shadows.floating,
  },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  providerIconChip: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  providerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  providerMetaRow: {
    marginTop: spacing.md,
    gap: 4,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  errorRow: {
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
  },
  providerActions: {
    marginTop: spacing.md,
  },
  actionPairWrap: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  actionPrimary: {
    backgroundColor: colors.brand,
    flex: undefined,
  },
  actionSecondary: {
    backgroundColor: colors.surfaceInset,
  },
  actionDanger: {
    backgroundColor: colors.dangerSubtle,
  },
  handoffCard: {
    borderRadius: radius["2xl"],
  },
});
