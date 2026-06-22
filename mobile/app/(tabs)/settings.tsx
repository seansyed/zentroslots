/**
 * Settings tab — profile row + grouped settings list + sign-out.
 *
 * Navigation contract — Phase 2G native expansion:
 *
 *   Account section (NATIVE screens):
 *     • Profile        → /settings/profile         (editable, PATCH /api/auth/me)
 *     • Notifications  → /settings/notifications   (push permission native)
 *     • Calendar       → /settings/calendar        (Google + MS OAuth native)
 *     • Security       → /settings/security        (sessions native too)
 *
 *   Workspace section (WEB-FIRST — desktop-best surfaces only):
 *     • Brand Studio   → handoff sheet → web (visual editor, multi-file upload)
 *     • Billing & plan → handoff sheet → web (Stripe Checkout)
 *
 *   About section:
 *     • Diagnostics       → /settings/diagnostics (NATIVE + backend health)
 *     • Privacy Policy    → external URL (system browser)
 *     • Terms of Service  → external URL (system browser)
 *     • Contact support   → mailto:
 *
 * Phase 2G rationale: every high-frequency operational action is now
 * native. The remaining web handoffs (Brand + Billing) are intentional
 * choices for "desktop-only" surfaces — Stripe card entry is more
 * secure on a non-keylogger-prone keyboard, and Brand Studio's
 * side-by-side preview belongs on a wide screen. We make those
 * intentional via WebHandoffSheet, not silent redirects.
 */

import * as React from "react";
import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { PresencePill } from "@/components/ui/PresencePill";
import { PageHeader } from "@/components/ui/PageHeader";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import {
  SettingsGroup,
  SettingsRow,
  type SettingsRowTone,
} from "@/components/ui/SettingsRow";
import { AppText } from "@/components/ui/Text";
import { Logo } from "@/components/ui/Logo";
import { WebHandoffSheet, type HandoffSpec } from "@/components/ui/WebHandoffSheet";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { env } from "@/lib/env";
import { usePresenceStore, type Presence } from "@/store/presenceStore";
import { colors, layout, radius, shadows, spacing } from "@/theme";

type Row = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  description?: string;
  onPress: () => void;
  /** Optional accessory chip (e.g. plan name). */
  accessory?: React.ReactNode;
  /** Tone for the icon chip. Defaults to "brand" inside SettingsRow. */
  tone?: SettingsRowTone;
};

export default function SettingsScreen() {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const { data: profile } = useProfile();
  const displayUser = profile ?? user;
  const tenant = profile?.tenant;

  // The WebHandoffSheet drives the web-first row taps. We pass a spec
  // here instead of jumping straight to Linking.openURL so the user
  // always sees a polished bridge between mobile and web.
  const [sheet, setSheet] = React.useState<HandoffSpec | null>(null);

  async function confirmSignOut() {
    Alert.alert(
      "Sign out?",
      "You'll need to sign back in to access your workspace.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            await signOut();
            router.replace("/login");
          },
        },
      ],
      { cancelable: true },
    );
  }

  // Account — all NATIVE screens (Phase 2G).
  const accountRows: Row[] = [
    {
      icon: "person-outline",
      label: "Profile",
      description: "Name, timezone, role, workspace",
      onPress: () => router.push("/settings/profile"),
    },
    {
      icon: "notifications-outline",
      label: "Notifications",
      description: "Push permission · email rules · inbox",
      onPress: () => router.push("/settings/notifications"),
    },
    {
      icon: "calendar-outline",
      label: "Calendar",
      description: !profile?.calendarConnected
        ? "Connect Google or Microsoft calendar"
        : profile.googleConnected && profile.microsoftConnected
          ? "Google & Microsoft connected · tap to manage"
          : profile.googleConnected
            ? "Google Calendar connected · tap to manage"
            : "Microsoft Calendar connected · tap to manage",
      tone: "brand",
      onPress: () => router.push("/settings/calendar"),
    },
    {
      icon: "lock-closed-outline",
      label: "Security",
      description: "Password, active sessions, sign out",
      onPress: () => router.push("/settings/security"),
    },
  ];

  // Workspace — only desktop-first surfaces remain here. Tapping
  // opens a polished bottom-sheet that explains the split before
  // opening the browser. No more silent jumps.
  //
  // Phase 2G rationalization: Calendar moved to Account (native).
  // Only Brand Studio + Billing remain — both genuinely desktop-best
  // (visual side-by-side editing for Brand, secure card entry for
  // Billing).
  const workspaceRows: Row[] = [
    {
      icon: "color-palette-outline",
      label: "Brand Studio",
      description: "Logo, colors, public page · best on desktop",
      tone: "violet",
      onPress: () =>
        setSheet({
          icon: "color-palette-outline",
          tone: "violet",
          title: "Brand Studio",
          body:
            "Upload your logo, tune your brand colors, and preview your public booking page side-by-side. The visual editor lives on the web — every change shows up in this app within seconds.",
          url: `${env.apiBaseUrl}/dashboard/settings/branding`,
          source: "settings.brandStudio",
        }),
    },
    {
      icon: "card-outline",
      label: "Billing & plan",
      description: tenant?.plan
        ? `Current plan: ${tenant.plan} · manage on desktop`
        : "Upgrade, invoices · best on desktop",
      tone: "success",
      onPress: () =>
        setSheet({
          icon: "card-outline",
          tone: "success",
          title: "Billing & plan",
          body:
            "Plan changes, invoices, and payment-method updates run through Stripe Checkout. We keep that on the web so card entry happens in the most secure surface.",
          url: `${env.apiBaseUrl}/dashboard/billing`,
          source: "settings.billing",
        }),
      accessory: tenant?.plan ? <Pill tone="brand">{tenant.plan}</Pill> : null,
    },
  ];

  // About / legal — small "boring but required for app stores" section.
  // Neutral-tone chips so the eye doesn't read these as brand-priority
  // alongside Account / Workspace.
  const aboutRows: Row[] = [
    {
      icon: "pulse-outline",
      label: "Diagnostics",
      description: "Connectivity · last sync · recent events",
      tone: "neutral",
      onPress: () => router.push("/settings/diagnostics"),
    },
    {
      icon: "shield-checkmark-outline",
      label: "Privacy Policy",
      description: "How we handle your data",
      tone: "neutral",
      onPress: () => Linking.openURL(env.privacyPolicyUrl).catch(() => {
        Alert.alert("Couldn't open", "Try again in a moment.");
      }),
    },
    {
      icon: "document-text-outline",
      label: "Terms of Service",
      description: "Agreement, acceptable use",
      tone: "neutral",
      onPress: () => Linking.openURL(env.termsUrl).catch(() => {
        Alert.alert("Couldn't open", "Try again in a moment.");
      }),
    },
    {
      icon: "help-circle-outline",
      label: "Contact support",
      description: env.supportEmail,
      tone: "neutral",
      onPress: () => Linking.openURL(`mailto:${env.supportEmail}`).catch(() => {
        Alert.alert("Couldn't open", "No email app available.");
      }),
    },
  ];

  // Management — native CRUD for the operational catalog. Departments /
  // Services / Locations are managerial (admin|manager); Working Hours is
  // shown to everyone (staff edit their OWN schedule, managers edit any).
  // Backend enforces write-authz regardless of what the UI shows.
  const isManager = profile?.role === "admin" || profile?.role === "manager";
  const managementRows: Row[] = [
    ...(isManager
      ? ([
          {
            icon: "git-branch-outline",
            label: "Departments",
            description: "Group services & staff",
            onPress: () => router.push("/settings/management/departments"),
          },
          {
            icon: "briefcase-outline",
            label: "Services",
            description: "Catalog · duration · price · bookability",
            onPress: () => router.push("/settings/management/services"),
          },
          {
            icon: "location-outline",
            label: "Locations",
            description: "In-person & virtual meeting places",
            onPress: () => router.push("/settings/management/locations"),
          },
        ] as Row[])
      : []),
    {
      icon: "time-outline",
      label: "Working Hours",
      description: isManager ? "Weekly schedule · staff availability" : "Your weekly availability",
      onPress: () => router.push("/settings/management/working-hours"),
    },
  ];

  return (
    <ScreenContainer scrollable>
      {/* Compact PageHeader — keeps the bell + avatar reachable from
          Settings too. The big profile hero below carries the deeper
          context; this header just maintains the cross-tab top-bar
          pattern (Calendar / Appointments / Customers / Settings all
          share the same idiom). Negative margins span full-bleed. */}
      <View style={{ marginHorizontal: -spacing.lg, marginTop: -spacing.md }}>
        <PageHeader
          title="Settings"
          subtitle="Workspace & account"
        />
      </View>

      {/* Profile hero — taller, more luxurious shadow + brand-tinted
          ambient halo. This is the first thing the operator sees on
          the screen, so we let it breathe. */}
      <Card variant="elevated" style={styles.hero} padding={spacing.xl}>
        <View style={styles.heroRow}>
          <Avatar
            name={displayUser?.name ?? displayUser?.email}
            uri={profile?.avatarUrl}
            size={64}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="h2" numberOfLines={1} style={styles.heroName}>
              {displayUser?.name ?? "—"}
            </AppText>
            <AppText variant="small" color="muted" numberOfLines={1} style={styles.heroEmail}>
              {displayUser?.email ?? ""}
            </AppText>
            {tenant?.name ? (
              <View style={styles.heroChipsRow}>
                <Pill tone="brand">{tenant.name}</Pill>
                {tenant?.plan ? <Pill tone="neutral">{tenant.plan}</Pill> : null}
              </View>
            ) : null}
          </View>
        </View>
      </Card>

      {/* Availability — Phase 2B local presence controls (Phase 2F
          segmented-control upgrade) */}
      <View style={styles.sectionGap} />
      <AvailabilityCard />

      {/* Account · Workspace · About — each rendered as a stack of
          floating rows with a tighter eyebrow → row gap and a looser
          inter-group gap. */}
      <View style={styles.groupGap} />
      <SettingsGroup title="Account">
        {accountRows.map((row) => (
          <SettingsRow
            key={row.label}
            icon={row.icon}
            label={row.label}
            description={row.description}
            tone={row.tone}
            accessory={row.accessory}
            onPress={row.onPress}
          />
        ))}
      </SettingsGroup>

      <View style={styles.groupGap} />
      <SettingsGroup title="Workspace">
        {workspaceRows.map((row) => (
          <SettingsRow
            key={row.label}
            icon={row.icon}
            label={row.label}
            description={row.description}
            tone={row.tone}
            accessory={row.accessory}
            trailingIcon="open-outline"
            onPress={row.onPress}
          />
        ))}
      </SettingsGroup>

      <View style={styles.groupGap} />
      <SettingsGroup title="Management">
        {managementRows.map((row) => (
          <SettingsRow
            key={row.label}
            icon={row.icon}
            label={row.label}
            description={row.description}
            tone={row.tone}
            accessory={row.accessory}
            onPress={row.onPress}
          />
        ))}
      </SettingsGroup>

      <View style={styles.groupGap} />
      <SettingsGroup title="About">
        {aboutRows.map((row) => (
          <SettingsRow
            key={row.label}
            icon={row.icon}
            label={row.label}
            description={row.description}
            tone={row.tone}
            accessory={row.accessory}
            onPress={row.onPress}
          />
        ))}
      </SettingsGroup>

      <View style={{ marginTop: spacing["3xl"] }}>
        <Button
          label="Sign out"
          variant="secondary"
          size="lg"
          fullWidth
          onPress={confirmSignOut}
          leftIcon={<Ionicons name="log-out-outline" size={18} color={colors.ink} />}
        />
      </View>

      <View style={styles.brandFooter}>
        <Logo size={64} accessibilityLabel="ZentroMeet" />
        <AppText variant="caption" color="subtle" align="center" style={styles.versionLabel}>
          ZentroMeet · v{env.appVersion}
        </AppText>
      </View>

      {/* Mounted last so the Modal's portal sits above every settings row.
          Driven by the Workspace-section row taps — see workspaceRows above. */}
      <WebHandoffSheet spec={sheet} onDismiss={() => setSheet(null)} />
    </ScreenContainer>
  );
}

/**
 * AvailabilityCard — premium segmented-control treatment.
 *
 * The three presence states render as equal-width segments inside a
 * tinted track. An animated brand-tinted "pill" slides under the
 * active segment using Reanimated `withSpring`, giving the active
 * choice a halo + subtle glow.
 *
 * No backend changes — still drives the same usePresenceStore actions
 * (setBase / setTodayOnly / clearOverride).
 */
function AvailabilityCard() {
  // Local Zustand presence — hydrated in root _layout.tsx so this read
  // is always up-to-date on this screen.
  const base = usePresenceStore((s) => s.base);
  const override = usePresenceStore((s) => s.override);
  const setBase = usePresenceStore((s) => s.setBase);
  const setTodayOnly = usePresenceStore((s) => s.setTodayOnly);
  const clearOverride = usePresenceStore((s) => s.clearOverride);
  const effective: Presence = override && override.expiresAtMs > Date.now() ? override.state : base;
  const hasOverride = Boolean(override && override.expiresAtMs > Date.now());

  // Width of one segment. We measure the track on layout so the moving
  // pill matches whatever Flexbox decides — no manual math, no
  // off-by-one on different device widths.
  const [trackWidth, setTrackWidth] = React.useState(0);
  const segmentCount = 3;
  const segmentWidth = trackWidth > 0 ? trackWidth / segmentCount : 0;
  const activeIndex = effective === "available" ? 0 : effective === "busy" ? 1 : 2;

  const translate = useSharedValue(0);
  React.useEffect(() => {
    translate.value = withSpring(activeIndex * segmentWidth, {
      damping: 18,
      stiffness: 220,
      mass: 0.7,
    });
  }, [activeIndex, segmentWidth, translate]);

  // Halo opacity pulses up briefly on change for a satisfying "yes
  // it took" beat. Kept short so it never feels chatty.
  const halo = useSharedValue(0.85);
  React.useEffect(() => {
    halo.value = withTiming(1, { duration: 220 });
    const t = setTimeout(() => {
      halo.value = withTiming(0.85, { duration: 320 });
    }, 220);
    return () => clearTimeout(t);
  }, [activeIndex, halo]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translate.value }],
    width: segmentWidth,
    opacity: halo.value,
  }));

  function pickPresence(p: Presence) {
    void Haptics.selectionAsync().catch(() => {});
    if (hasOverride) void setTodayOnly(p);
    else void setBase(p);
  }

  return (
    <SectionFade>
      <AppText variant="eyebrow" color="muted" style={availStyles.eyebrow}>
        Availability
      </AppText>
      <Card variant="elevated" style={availStyles.card} padding={spacing.lg}>
        <View style={availStyles.headerRow}>
          <View style={{ flex: 1 }}>
            <AppText variant="bodyStrong">Current status</AppText>
            <AppText variant="caption" color="muted" style={{ marginTop: 2 }}>
              {hasOverride
                ? "Override active until midnight"
                : "Default presence — applies until you change it"}
            </AppText>
          </View>
          <PresencePill state={effective} size="lg" />
        </View>

        {/* Segmented control */}
        <View
          style={availStyles.track}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        >
          {/* Animated active pill — sits beneath the labels, slides on
              presence change. */}
          {trackWidth > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[availStyles.activePill, pillStyle]}
            />
          ) : null}

          {(["available", "busy", "paused"] as Presence[]).map((p) => {
            const active = effective === p;
            return (
              <Pressable
                key={p}
                onPress={() => pickPresence(p)}
                accessibilityRole="button"
                accessibilityLabel={`Set ${p}`}
                accessibilityState={{ selected: active }}
                style={availStyles.segment}
              >
                <PresencePill state={p} size="sm" showLabel={false} />
                <AppText
                  variant="smallStrong"
                  numberOfLines={1}
                  style={[
                    availStyles.segmentLabel,
                    { color: active ? colors.ink : colors.inkMuted },
                  ]}
                >
                  {p === "available" ? "Available" : p === "busy" ? "Busy" : "Paused"}
                </AppText>
              </Pressable>
            );
          })}
        </View>

        {/* Override hint row — outlined utility button, kept subtle so
            it never competes with the segmented control above. */}
        {hasOverride ? (
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              void clearOverride();
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear today's override"
            style={availStyles.clearRow}
          >
            <Ionicons name="refresh-outline" size={14} color={colors.inkMuted} />
            <AppText variant="small" color="muted" style={{ marginLeft: 6 }}>
              Clear today's override · revert to {base}
            </AppText>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              void setTodayOnly(base === "available" ? "busy" : "available");
            }}
            accessibilityRole="button"
            accessibilityLabel="Toggle today only"
            style={availStyles.clearRow}
          >
            <Ionicons name="time-outline" size={14} color={colors.inkMuted} />
            <AppText variant="small" color="muted" style={{ marginLeft: 6 }}>
              Toggle today only · auto-revert at midnight
            </AppText>
          </Pressable>
        )}
      </Card>
    </SectionFade>
  );
}

const availStyles = StyleSheet.create({
  eyebrow: {
    marginBottom: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
    letterSpacing: 1.1,
  },
  card: {
    borderRadius: radius["2xl"],
    ...shadows.floating,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  /** Segmented-control track. Tinted background = "rail" the active
   *  pill slides on. Slight inner padding so the active pill doesn't
   *  touch the track edge. */
  track: {
    flexDirection: "row",
    position: "relative",
    marginTop: spacing.lg,
    backgroundColor: colors.surfaceInset,
    borderRadius: radius.xl,
    padding: 4,
    height: 68,
  },
  /** The moving active pill. Brand-tinted background + soft brand
   *  halo (via shadow). Sits behind the segment labels. */
  activePill: {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: 4,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    // Inset slightly so it doesn't blow past the track padding.
    marginRight: 8,
    // Subtle brand halo for the luxurious selected state.
    ...shadows.activeLift,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
    paddingVertical: spacing.sm,
    zIndex: 1,
  },
  segmentLabel: {
    marginTop: 6,
  },
  clearRow: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceSubtle,
  },
});

const styles = StyleSheet.create({
  pageEyebrow: {
    // Tighter letter-spacing reads more premium than the wide eyebrow
    // we use for in-section labels.
    letterSpacing: 1.3,
  },
  pageTitle: {
    marginTop: 4,
    marginBottom: spacing.xl,
  },
  hero: {
    // Slightly more dramatic shadow than the default elevated card —
    // signals this is the page anchor, not just another card.
    ...shadows.floating,
    borderRadius: radius["2xl"],
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  heroName: {
    // Display-line tightening so the name doesn't wrap awkwardly.
    letterSpacing: -0.2,
  },
  heroEmail: {
    marginTop: 2,
  },
  heroChipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.sm,
  },
  /** Spacing between availability card + settings sections. Smaller
   *  than the inter-group gap so availability feels tied to the hero. */
  sectionGap: {
    height: spacing.lg,
  },
  /** Inter-group rhythm — 28px maps to the design brief's "looser
   *  inter-section" feel without crossing into "two separate screens". */
  groupGap: {
    height: spacing["2xl"] + 4,
  },
  brandFooter: {
    marginTop: spacing["3xl"],
    alignItems: "center",
    gap: spacing.xs,
  },
  versionLabel: {
    marginTop: 0,
  },
});
