/**
 * /settings/profile — native profile view + inline edit.
 *
 * Phase 2G upgrade: profile is now fully editable from the mobile app.
 * Tap "Edit" → inline form for name + timezone. Save commits via
 * `PATCH /api/auth/me` (additive endpoint, see scheduling-saas
 * /app/api/auth/me/route.ts) with optimistic cache update through
 * `useUpdateProfile`.
 *
 * What still hands off to web:
 *   • Avatar upload — multipart/form-data uploads feel cleaner on
 *     desktop, and the asset cropping flow there is more mature.
 *   • SSO / identity provider changes — high-stakes, lives on web's
 *     /dashboard/settings/profile.
 *
 * Layout:
 *   • Topbar with back nav + an "Edit" / "Save" / "Cancel" trailing
 *     action depending on mode.
 *   • Hero (read mode) — Avatar + name + role/workspace pills.
 *   • Detail rows (read mode) — Email, Timezone, Role, Workspace,
 *     Plan, Google Calendar status.
 *   • Inline form (edit mode) — Name (free text), Timezone (free text
 *     with current value as placeholder). Save button at the bottom
 *     with loading + error states.
 *   • Bottom: "Manage avatar + SSO on web" handoff card.
 *
 * Loading: Shimmer cards in place of the rows so the layout doesn't
 * jump when data lands.
 */

import * as React from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DetailRow } from "@/components/ui/DetailRow";
import { GradientHeroCard } from "@/components/ui/GradientHeroCard";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { WebHandoffSheet, type HandoffSpec } from "@/components/ui/WebHandoffSheet";
import { useProfile } from "@/hooks/useProfile";
import { useUpdateProfile } from "@/hooks/useUpdateProfile";
import { env } from "@/lib/env";
import { colors, layout, radius, shadows, spacing } from "@/theme";

export default function ProfileScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const profile = profileQ.data;
  const updateMut = useUpdateProfile();

  const [sheet, setSheet] = React.useState<HandoffSpec | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState("");
  const [timezone, setTimezone] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [tzError, setTzError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Hydrate form state whenever the profile lands or refreshes — but
  // only when we're NOT mid-edit, so we don't clobber the user's
  // pending input on a background refetch.
  React.useEffect(() => {
    if (!editing && profile) {
      setName(profile.name);
      setTimezone(profile.timezone);
    }
  }, [profile, editing]);

  function startEdit() {
    if (!profile) return;
    void Haptics.selectionAsync().catch(() => {});
    setName(profile.name);
    setTimezone(profile.timezone);
    setNameError(null);
    setTzError(null);
    setSubmitError(null);
    setEditing(true);
  }

  function cancelEdit() {
    void Haptics.selectionAsync().catch(() => {});
    setEditing(false);
    setSubmitError(null);
    if (profile) {
      setName(profile.name);
      setTimezone(profile.timezone);
    }
  }

  async function saveEdit() {
    if (!profile) return;
    setSubmitError(null);
    const trimmedName = name.trim();
    const trimmedTz = timezone.trim();
    let valid = true;
    if (trimmedName.length < 1 || trimmedName.length > 120) {
      setNameError("Name must be 1–120 characters");
      valid = false;
    } else setNameError(null);
    if (trimmedTz.length < 1 || trimmedTz.length > 64) {
      setTzError("Timezone is required");
      valid = false;
    } else setTzError(null);
    if (!valid) return;

    // Skip the round-trip entirely if nothing changed — keeps the
    // server logs clean and the UX feels instant.
    const patch: { name?: string; timezone?: string } = {};
    if (trimmedName !== profile.name) patch.name = trimmedName;
    if (trimmedTz !== profile.timezone) patch.timezone = trimmedTz;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }

    void Haptics.selectionAsync().catch(() => {});
    try {
      await updateMut.mutateAsync(patch);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      setEditing(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't save. Try again.";
      setSubmitError(message);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
        () => {},
      );
    }
  }

  function openAvatarSsoHandoff() {
    void Haptics.selectionAsync().catch(() => {});
    setSheet({
      icon: "image-outline",
      tone: "brand",
      title: "Avatar & sign-in providers",
      body:
        "Avatar uploads and SSO provider changes are easier to do on a desktop browser. Your name + timezone edit on this device — those save instantly here.",
      url: `${env.apiBaseUrl}/dashboard/settings/profile`,
      ctaLabel: "Open on the web",
      source: "profile.avatarSsoWeb",
    });
  }

  function confirmDiscard() {
    if (!editing) return goBack();
    if (!isDirty()) return goBack();
    Alert.alert(
      "Discard changes?",
      "You have unsaved edits. Going back will lose them.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            cancelEdit();
            goBack();
          },
        },
      ],
      { cancelable: true },
    );
  }

  function isDirty() {
    if (!profile) return false;
    return name.trim() !== profile.name || timezone.trim() !== profile.timezone;
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/settings");
  }

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Topbar */}
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={confirmDiscard}
        />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          {editing ? "Edit profile" : "Profile"}
        </AppText>
        {/* Right-side action: Edit / Cancel / Save trailing. We keep
            the button area a fixed 64px wide so the title stays centred. */}
        {profile ? (
          editing ? (
            <View style={styles.topActionWrap}>
              <AppText
                variant="smallStrong"
                style={[
                  styles.topActionText,
                  { color: colors.inkMuted },
                ]}
                onPress={cancelEdit}
                accessibilityRole="button"
                accessibilityLabel="Cancel edit"
              >
                Cancel
              </AppText>
            </View>
          ) : (
            <View style={styles.topActionWrap}>
              <AppText
                variant="smallStrong"
                style={[styles.topActionText, { color: colors.brand }]}
                onPress={startEdit}
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
              >
                Edit
              </AppText>
            </View>
          )
        ) : (
          <View style={styles.topActionWrap} />
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero */}
        <SectionFade>
          {profileQ.isLoading && !profile ? (
            <Shimmer.Card height={132} />
          ) : (
            <GradientHeroCard>
              <View style={styles.heroRow}>
                <Avatar name={profile?.name ?? "?"} uri={profile?.avatarUrl ?? undefined} size={64} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="h2" numberOfLines={1}>
                    {profile?.name ?? "—"}
                  </AppText>
                  <AppText
                    variant="small"
                    color="muted"
                    numberOfLines={1}
                    style={{ marginTop: 2 }}
                  >
                    {profile?.email ?? ""}
                  </AppText>
                  <View style={styles.heroChipsRow}>
                    {profile?.role ? (
                      <Pill tone="brand">{profile.role}</Pill>
                    ) : null}
                    {profile?.tenant?.name ? (
                      <Pill tone="neutral">{profile.tenant.name}</Pill>
                    ) : null}
                  </View>
                </View>
              </View>
            </GradientHeroCard>
          )}
        </SectionFade>

        {/* Inline edit form OR detail card */}
        {editing && profile ? (
          <SectionFade delay={60} style={{ marginTop: spacing.xl }}>
            <Card style={styles.editCard} padding={spacing.lg}>
              <AppText variant="eyebrow" color="muted" style={{ marginBottom: spacing.md }}>
                Editable fields
              </AppText>

              <Input
                label="Display name"
                value={name}
                onChangeText={(v) => {
                  setName(v);
                  if (nameError) setNameError(null);
                }}
                error={nameError}
                autoCapitalize="words"
                returnKeyType="next"
                placeholder="Your name"
              />
              <Input
                label="Timezone (IANA)"
                value={timezone}
                onChangeText={(v) => {
                  setTimezone(v);
                  if (tzError) setTzError(null);
                }}
                error={tzError}
                hint="e.g. America/Los_Angeles, Europe/London"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                placeholder="America/Los_Angeles"
              />

              {submitError ? (
                <View style={styles.submitError}>
                  <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
                  <AppText
                    variant="small"
                    style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}
                  >
                    {submitError}
                  </AppText>
                </View>
              ) : null}

              <Button
                label={updateMut.isPending ? "Saving…" : "Save changes"}
                variant="primary"
                size="lg"
                fullWidth
                disabled={updateMut.isPending || !isDirty()}
                loading={updateMut.isPending}
                onPress={saveEdit}
                style={{ marginTop: spacing.lg }}
              />
              <AppText
                variant="micro"
                color="subtle"
                align="center"
                style={{ marginTop: spacing.sm }}
              >
                Changes save instantly and sync across every device.
              </AppText>
            </Card>
          </SectionFade>
        ) : (
          <SectionFade delay={80} style={{ marginTop: spacing.xl }}>
            <Card padding="none" style={styles.detailCard}>
              {profileQ.isLoading && !profile ? (
                <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                  <Shimmer width="100%" height={20} />
                  <Shimmer width="80%" height={20} />
                  <Shimmer width="60%" height={20} />
                </View>
              ) : (
                <View style={{ paddingVertical: spacing.sm }}>
                  <DetailRow
                    icon="mail-outline"
                    label="Email"
                    value={profile?.email ?? "—"}
                  />
                  <DetailRow
                    icon="time-outline"
                    label="Timezone"
                    value={profile?.timezone ?? "—"}
                  />
                  <DetailRow
                    icon="shield-outline"
                    label="Role"
                    value={profile?.role ?? "—"}
                  />
                  <DetailRow
                    icon="business-outline"
                    label="Workspace"
                    value={profile?.tenant?.name ?? "—"}
                  />
                  <DetailRow
                    icon="ribbon-outline"
                    label="Plan"
                    value={profile?.tenant?.plan ?? "—"}
                  />
                  <DetailRow
                    icon={profile?.googleConnected ? "checkmark-circle" : "close-circle-outline"}
                    label="Google Calendar"
                    value={profile?.googleConnected ? "Connected" : "Not connected"}
                  />
                </View>
              )}
            </Card>
          </SectionFade>
        )}

        {/* Avatar/SSO web-handoff — only meaningful in read mode. */}
        {!editing ? (
          <SectionFade delay={140} style={{ marginTop: spacing.xl }}>
            <Card variant="outline" style={{ borderRadius: radius["2xl"] }}>
              <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
                <Ionicons name="image-outline" size={20} color={colors.brand} />
                <AppText
                  variant="bodyStrong"
                  align="center"
                  style={{ marginTop: spacing.sm }}
                >
                  Avatar & sign-in providers
                </AppText>
                <AppText
                  variant="small"
                  color="muted"
                  align="center"
                  style={{ marginTop: 4, paddingHorizontal: spacing.lg }}
                >
                  Upload a new photo or manage SSO connections from the
                  desktop dashboard — both are easier on a larger screen.
                </AppText>
                <View style={{ height: spacing.md }} />
                <Pill tone="brand">
                  <AppText
                    variant="smallStrong"
                    style={{ color: colors.brand }}
                    onPress={openAvatarSsoHandoff}
                  >
                    Open on the web →
                  </AppText>
                </Pill>
              </View>
            </Card>
          </SectionFade>
        ) : null}

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
  topActionWrap: {
    width: 64,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  topActionText: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  heroChipsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.sm,
  },
  /** Detail card depth — softer, larger radius matches the floating
   *  row aesthetic without making detail rows feel pressable. */
  detailCard: {
    borderRadius: radius["2xl"],
    ...shadows.ambient,
  },
  /** Edit card uses the same depth language as the detail card so the
   *  surface transition feels seamless when toggling modes. */
  editCard: {
    borderRadius: radius["2xl"],
    ...shadows.floating,
  },
  submitError: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
  },
});
