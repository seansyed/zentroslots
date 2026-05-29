/**
 * /settings/security — native security overview.
 *
 * What lives natively:
 *   • Current sign-in identity (email, role, workspace)
 *   • Last successful sync time (proxy for "this device session is
 *     alive") via the existing networkStore
 *   • Sign-out CTA (canonical action — closes the session locally
 *     and on the server)
 *
 * What stays on the web (via WebHandoffSheet):
 *   • Change password (the backend's forgot-password flow already
 *     handles this end-to-end; we surface it as a handoff for now
 *     rather than re-implementing the email-based flow in mobile)
 *   • Active sessions list across devices (the dashboard's security
 *     page renders it with revoke buttons — high-stakes action,
 *     better-suited to the larger surface)
 *
 * Why no inline change-password: this is intentionally additive +
 * production-safe. Building an inline password-change flow would
 * require a new mobile endpoint and a new validation surface. The
 * web handoff is the lower-risk path for the beta cohort.
 */

import * as React from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SettingsGroup, SettingsRow } from "@/components/ui/SettingsRow";
import { AppText } from "@/components/ui/Text";
import { WebHandoffSheet, type HandoffSpec } from "@/components/ui/WebHandoffSheet";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { env } from "@/lib/env";
import { useNetworkStore } from "@/store/networkStore";
import { colors, layout, radius, shadows, spacing } from "@/theme";

function formatRelative(ms: number | null, now: number): string {
  if (!ms) return "Never";
  const diff = now - ms;
  if (diff < 60_000) return "Just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export default function SecurityScreen() {
  const router = useRouter();
  const { signOut } = useAuth();
  const profileQ = useProfile();
  const profile = profileQ.data;

  const lastOnlineAt = useNetworkStore((s) => s.lastOnlineAt);
  const isOnline = useNetworkStore((s) => s.isOnline);

  const [sheet, setSheet] = React.useState<HandoffSpec | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);

  // Live "X ago" tick so the last-sync line drifts forward naturally.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function openChangePassword() {
    void Haptics.selectionAsync().catch(() => {});
    setSheet({
      icon: "key-outline",
      tone: "brand",
      title: "Change your password",
      body:
        "We'll email you a secure reset link. Open it on any device — the new password works everywhere you're signed in.",
      url: `${env.apiBaseUrl}/forgot-password`,
      ctaLabel: "Open password reset",
      source: "security.changePassword",
    });
  }

  function openActiveSessions() {
    void Haptics.selectionAsync().catch(() => {});
    // Phase 2G — now fully native at /settings/security/sessions.
    // No more WebHandoffSheet jump.
    router.push("/settings/security/sessions");
  }

  /**
   * Account deletion — App Store + Play Store compliance.
   *
   * Apple guideline 5.1.1.v + Google Play personal/sensitive-data policy
   * both require apps with account creation to expose an in-app deletion
   * path. Both stores explicitly accept a "contact support" handoff when
   * automated deletion isn't yet wired — we open a pre-filled mailto so
   * the support team can action the request inside the documented SLA.
   *
   * Two-step confirm: the first dialog explains consequences, the second
   * verifies intent before launching the mailer. We deliberately do NOT
   * sign the user out — they may want to cancel mid-flight, and the
   * actual deletion happens in our support pipeline.
   */
  function confirmDeleteAccount() {
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      "Delete your account?",
      "Deleting your account is permanent. You'll lose every booking, customer record, and saved setting tied to this workspace. We can't recover this data once it's gone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => {
            // Second confirm — last chance to back out.
            Alert.alert(
              "One more thing",
              `We'll open your mail app with a deletion request pre-filled for ${env.supportEmail}. Our team will action it within 7 business days and email you when it's complete.`,
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Open mail app",
                  style: "destructive",
                  onPress: () => {
                    void Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Warning,
                    ).catch(() => {});
                    const subject = encodeURIComponent("Delete my account");
                    const body = encodeURIComponent(
                      `Please delete the ZentroMeet account associated with this email address.\n\n` +
                        `Workspace: ${profile?.tenant?.name ?? "(unknown)"}\n` +
                        `Email: ${profile?.email ?? "(unknown)"}\n` +
                        `Role: ${profile?.role ?? "(unknown)"}\n\n` +
                        `I understand this is permanent and that all associated bookings, ` +
                        `customer records, and settings will be removed.\n\n` +
                        `Sent from the ZentroMeet mobile app.`,
                    );
                    Linking.openURL(
                      `mailto:${env.supportEmail}?subject=${subject}&body=${body}`,
                    ).catch(() => {
                      Alert.alert(
                        "Couldn't open mail",
                        `Please email ${env.supportEmail} from any device to request deletion.`,
                      );
                    });
                  },
                },
              ],
              { cancelable: true },
            );
          },
        },
      ],
      { cancelable: true },
    );
  }

  function confirmSignOut() {
    Alert.alert(
      "Sign out?",
      "You'll need to sign back in to access your workspace on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            setSigningOut(true);
            try {
              await signOut();
              router.replace("/login");
            } finally {
              setSigningOut(false);
            }
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
            else router.replace("/(tabs)/settings");
          }}
        />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          Security
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Current session ──────────────────────────────────── */}
        <SectionFade>
          <Card variant="elevated" style={styles.hero} padding={spacing.xl}>
            <View style={styles.heroRow}>
              <Avatar name={profile?.name ?? "?"} uri={profile?.avatarUrl ?? undefined} size={48} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="bodyStrong" numberOfLines={1}>
                  Signed in on this device
                </AppText>
                <AppText
                  variant="small"
                  color="muted"
                  numberOfLines={1}
                  style={{ marginTop: 2 }}
                >
                  {profile?.email ?? "—"}
                </AppText>
                <View style={styles.heroChipsRow}>
                  {profile?.role ? <Pill tone="brand">{profile.role}</Pill> : null}
                  <Pill tone={isOnline ? "success" : "warning"}>
                    {isOnline ? "Online" : "Offline"}
                  </Pill>
                </View>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.metaRow}>
              <Ionicons name="cloud-done-outline" size={14} color={colors.inkSubtle} />
              <AppText
                variant="micro"
                color="muted"
                style={{ marginLeft: 4, letterSpacing: 0.3 }}
              >
                Last sync · {formatRelative(lastOnlineAt, now)}
              </AppText>
            </View>
          </Card>
        </SectionFade>

        {/* ── Security actions ─────────────────────────────────── */}
        <SectionFade delay={80} style={{ marginTop: spacing.xl }}>
          <SettingsGroup title="Account">
            <SettingsRow
              icon="key-outline"
              label="Change password"
              description="We'll email you a secure reset link"
              tone="brand"
              accessibilityLabel="Change password"
              onPress={openChangePassword}
            />
            <SettingsRow
              icon="phone-portrait-outline"
              label="Active sessions"
              description="Every device signed in to your workspace"
              tone="violet"
              accessibilityLabel="Active sessions"
              onPress={openActiveSessions}
            />
          </SettingsGroup>
        </SectionFade>

        {/* ── Danger zone (Phase 4 — App Store + Play Store compliance) ─── */}
        <SectionFade delay={110} style={{ marginTop: spacing.xl }}>
          <SettingsGroup title="Danger zone">
            <SettingsRow
              icon="trash-outline"
              label="Delete my account"
              description="Permanently removes your account and all data"
              tone="danger"
              accessibilityLabel="Delete my account"
              onPress={confirmDeleteAccount}
            />
          </SettingsGroup>
          <AppText
            variant="micro"
            color="subtle"
            style={{
              marginTop: spacing.sm,
              paddingHorizontal: spacing.xs,
              lineHeight: 16,
            }}
          >
            We action deletion requests within 7 business days. If you change
            your mind, email {env.supportEmail} before then to cancel.
          </AppText>
        </SectionFade>

        {/* ── Sign out ─────────────────────────────────────────── */}
        <SectionFade delay={140} style={{ marginTop: spacing["2xl"] }}>
          <Button
            label={signingOut ? "Signing out…" : "Sign out of this device"}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={signingOut}
            loading={signingOut}
            onPress={confirmSignOut}
            leftIcon={
              !signingOut ? (
                <Ionicons name="log-out-outline" size={18} color={colors.ink} />
              ) : undefined
            }
          />
          <AppText
            variant="micro"
            color="subtle"
            align="center"
            style={{ marginTop: spacing.sm, paddingHorizontal: spacing.lg }}
          >
            Sign out only ends the session on this device. Your other
            devices stay signed in. To sign everyone out, manage active
            sessions above.
          </AppText>
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
  /** Hero card lift — anchors the screen with a soft brand-coloured
   *  ambient shadow. Phase 2F. */
  hero: {
    borderRadius: radius["2xl"],
    ...shadows.floating,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  heroChipsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.sm,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.md,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
  },
});
