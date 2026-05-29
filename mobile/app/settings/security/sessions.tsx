/**
 * /settings/security/sessions — native active sessions surface.
 *
 * Phase 2G — replaces the previous WebHandoffSheet jump for "Active
 * sessions". The screen reads `GET /api/auth/sessions` and renders one
 * row per JTI with:
 *
 *   • Device label (or a sensible derivation from User-Agent if the
 *     backend didn't capture a label — most real sessions don't have
 *     one set).
 *   • IP address + relative login time.
 *   • A "This device" pill for the calling session (cannot be revoked
 *     individually — that would lock the user out of the very screen
 *     they're on; use "Sign out of this device" in /settings/security).
 *   • A per-row "Revoke" action with confirm dialog for non-current
 *     sessions, plus a "Sign out everywhere else" CTA at the bottom.
 *
 * Empty + error states are first-class: a calm placeholder + a retry
 * affordance instead of an inert spinner.
 */

import * as React from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { ApiError } from "@/api/client";
import type { SessionRow } from "@/api/sessions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import {
  useRevokeAllSessions,
  useRevokeSession,
  useSessions,
} from "@/hooks/useSessions";
import { colors, layout, radius, shadows, spacing } from "@/theme";

function inferDeviceLabel(row: SessionRow): string {
  if (row.deviceLabel && row.deviceLabel.trim().length > 0) return row.deviceLabel;
  const ua = row.userAgent ?? "";
  // Cheap UA heuristics — good enough for "Is this my iPhone or my
  // laptop?" recognition. Not a full UA parser.
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android device";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Linux/i.test(ua)) return "Linux";
  if (/Mobile/i.test(ua)) return "Mobile browser";
  return "Browser session";
}

function inferBrowser(ua: string | null): string | null {
  if (!ua) return null;
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Firefox\//.test(ua)) return "Firefox";
  return null;
}

function formatRelative(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 0) return "just now";
  if (diff < 60_000) return "moments ago";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}

export default function SessionsScreen() {
  const router = useRouter();
  const sessionsQ = useSessions();
  const revokeMut = useRevokeSession();
  const revokeAllMut = useRevokeAllSessions();

  // Local "now" tick so the relative time labels drift forward without
  // us thrashing the network.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Filter to only active sessions for the main list. Revoked rows are
  // surfaced in a separate "Recently revoked" group below so users can
  // see the audit trail.
  const active = (sessionsQ.data?.sessions ?? []).filter((s) => !s.revoked);
  const revokedHistory = (sessionsQ.data?.sessions ?? [])
    .filter((s) => s.revoked)
    .slice(0, 5);

  const hasOthers = active.some((s) => !s.isCurrent);

  function confirmRevoke(row: SessionRow) {
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      "Revoke this session?",
      `${inferDeviceLabel(row)} will be signed out immediately. They'll need to log back in to access the workspace.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => {
            void Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Warning,
            ).catch(() => {});
            void revokeMut.mutateAsync(row.jti);
          },
        },
      ],
      { cancelable: true },
    );
  }

  function confirmRevokeAll() {
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      "Sign out everywhere else?",
      "Every device except this one will be signed out immediately. This device stays signed in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out everywhere else",
          style: "destructive",
          onPress: () => {
            void Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Warning,
            ).catch(() => {});
            void revokeAllMut.mutateAsync();
          },
        },
      ],
      { cancelable: true },
    );
  }

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/settings/security");
          }}
        />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          Active sessions
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Intro */}
        <SectionFade>
          <AppText variant="caption" color="muted" style={styles.intro}>
            Every device currently signed in to your workspace. Revoke any
            session you don't recognise — the holder is signed out
            immediately.
          </AppText>
        </SectionFade>

        {/* List */}
        <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
          {sessionsQ.isLoading && !sessionsQ.data ? (
            <View style={{ gap: spacing.md }}>
              <Shimmer.Card height={86} />
              <Shimmer.Card height={86} />
              <Shimmer.Card height={86} />
            </View>
          ) : sessionsQ.isError ? (
            <Card style={styles.errorCard}>
              <ErrorState
                kind={
                  sessionsQ.error instanceof ApiError
                    ? sessionsQ.error.kind
                    : "unknown"
                }
                description={
                  sessionsQ.error instanceof Error
                    ? sessionsQ.error.message
                    : undefined
                }
                onRetry={() => {
                  void Haptics.impactAsync(
                    Haptics.ImpactFeedbackStyle.Light,
                  ).catch(() => {});
                  void sessionsQ.refetch();
                }}
              />
            </Card>
          ) : active.length === 0 ? (
            <Card variant="outline" style={{ borderRadius: radius["2xl"] }}>
              <EmptyState
                icon={
                  <Ionicons
                    name="phone-portrait-outline"
                    size={24}
                    color={colors.brand}
                  />
                }
                title="No other active sessions"
                body="You're only signed in on this device right now. Sessions show up here as soon as you log in elsewhere."
              />
            </Card>
          ) : (
            <View style={{ gap: 12 }}>
              {active.map((row) => (
                <SessionRowCard
                  key={row.jti}
                  row={row}
                  now={now}
                  onRevoke={confirmRevoke}
                  revoking={
                    revokeMut.isPending && revokeMut.variables === row.jti
                  }
                />
              ))}
            </View>
          )}
        </SectionFade>

        {/* Bulk action */}
        {hasOthers ? (
          <SectionFade delay={120} style={{ marginTop: spacing["2xl"] }}>
            <Button
              label={
                revokeAllMut.isPending
                  ? "Signing everyone out…"
                  : "Sign out everywhere else"
              }
              variant="secondary"
              size="lg"
              fullWidth
              disabled={revokeAllMut.isPending}
              loading={revokeAllMut.isPending}
              onPress={confirmRevokeAll}
              leftIcon={
                !revokeAllMut.isPending ? (
                  <Ionicons
                    name="log-out-outline"
                    size={18}
                    color={colors.ink}
                  />
                ) : undefined
              }
            />
            <AppText
              variant="micro"
              color="subtle"
              align="center"
              style={{ marginTop: spacing.sm, paddingHorizontal: spacing.lg }}
            >
              Keeps this device signed in. Everywhere else has to log back in.
            </AppText>
          </SectionFade>
        ) : null}

        {/* Audit history — recently revoked sessions for transparency. */}
        {revokedHistory.length > 0 ? (
          <SectionFade delay={160} style={{ marginTop: spacing["2xl"] }}>
            <AppText variant="eyebrow" color="muted" style={styles.eyebrow}>
              Recently revoked
            </AppText>
            <View style={{ gap: 12 }}>
              {revokedHistory.map((row) => (
                <SessionRowCard
                  key={row.jti}
                  row={row}
                  now={now}
                  onRevoke={() => {}}
                  revoking={false}
                  disabled
                />
              ))}
            </View>
          </SectionFade>
        ) : null}

        <View style={{ height: spacing["3xl"] }} />
      </ScrollView>
    </ScreenContainer>
  );
}

type RowCardProps = {
  row: SessionRow;
  now: number;
  onRevoke: (row: SessionRow) => void;
  revoking: boolean;
  disabled?: boolean;
};

function SessionRowCard({ row, now, onRevoke, revoking, disabled }: RowCardProps) {
  const label = inferDeviceLabel(row);
  const browser = inferBrowser(row.userAgent);
  const subtitle = [browser, row.ipAddress].filter(Boolean).join(" · ");
  const relative = row.revoked
    ? row.revokedAt
      ? `Revoked ${formatRelative(row.revokedAt, now)}`
      : "Revoked"
    : `Logged in ${formatRelative(row.loggedInAt, now)}`;

  return (
    <View style={[styles.row, disabled && styles.rowMuted]}>
      <View style={styles.rowIcon}>
        <Ionicons
          name={
            /iPhone|iPad|Android|Mobile/i.test(row.userAgent ?? "")
              ? "phone-portrait-outline"
              : "desktop-outline"
          }
          size={20}
          color={row.isCurrent ? colors.brand : colors.inkMuted}
        />
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.titleRow}>
          <AppText variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {label}
          </AppText>
          {row.isCurrent ? (
            <Pill tone="brand">This device</Pill>
          ) : row.revoked ? (
            <Pill tone="neutral">Revoked</Pill>
          ) : null}
        </View>
        {subtitle ? (
          <AppText
            variant="caption"
            color="muted"
            numberOfLines={1}
            style={{ marginTop: 2 }}
          >
            {subtitle}
          </AppText>
        ) : null}
        <AppText
          variant="micro"
          color="subtle"
          style={{ marginTop: 4, letterSpacing: 0.3 }}
        >
          {relative.toUpperCase()}
        </AppText>
      </View>

      {!row.isCurrent && !row.revoked ? (
        <View style={styles.revokeWrap}>
          <AppText
            variant="smallStrong"
            style={{ color: revoking ? colors.inkSubtle : colors.dangerInk }}
            onPress={() => {
              if (revoking) return;
              onRevoke(row);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Revoke session on ${label}`}
          >
            {revoking ? "Revoking…" : "Revoke"}
          </AppText>
        </View>
      ) : null}
    </View>
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
  intro: {
    paddingHorizontal: spacing.xs,
    lineHeight: 18,
  },
  eyebrow: {
    marginBottom: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
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
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadows.ambient,
  },
  rowMuted: {
    opacity: 0.7,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceInset,
    alignItems: "center",
    justifyContent: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  revokeWrap: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  errorCard: {
    borderRadius: radius["2xl"],
    ...shadows.ambient,
  },
});
