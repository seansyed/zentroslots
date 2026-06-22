/**
 * /onboarding — first-launch onboarding pager.
 *
 * Three calm screens, each with a single goal:
 *
 *   1. Welcome — what ZentroMeet is, why this app exists.
 *   2. Notifications — explain WHY we want push permission, then
 *      ask. (Operating-system rationale = lower decline rate.)
 *   3. Calendar — explain WHY we want calendar sync, with a
 *      "Connect now" CTA and a "Skip for now" escape hatch.
 *
 * Every screen has a "Skip" affordance in the top-right so the user
 * is never trapped. Skipping anywhere completes the flow and lands
 * them on /(tabs).
 *
 * Phase 3 production hardening — replaces the previous "land cold in
 * Appointments" first-run experience.
 *
 * Architecture notes:
 *   • Single file because the flow is small and the screens share
 *     state + chrome. Splitting into 3 files would force prop drilling
 *     for `step`, `goNext`, `markSeen`.
 *   • No swipe gestures — the buttons are explicit. Swipe-pagination
 *     on first run too often gets people stuck on a screen they can't
 *     dismiss.
 *   • Reanimated `withTiming` for the cross-fade between steps so the
 *     transition feels intentional, not jumpy.
 */

import * as React from "react";
import { Platform, StyleSheet, View } from "react-native";
import * as Notifications from "expo-notifications";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Button } from "@/components/ui/Button";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { AppText } from "@/components/ui/Text";
import { useFirstRun } from "@/hooks/useFirstRun";
import { track } from "@/lib/telemetry";
import { colors, radius, shadows, spacing } from "@/theme";

type Step = "welcome" | "notifications" | "calendar";

const STEPS: Step[] = ["welcome", "notifications", "calendar"];

export default function OnboardingScreen() {
  const router = useRouter();
  const { markSeen } = useFirstRun();
  const [step, setStep] = React.useState<Step>("welcome");

  // Cross-fade between steps. Reanimated worklet keeps it on the UI
  // thread so navigation never stutters.
  const fade = useSharedValue(1);
  React.useEffect(() => {
    fade.value = 0;
    fade.value = withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) });
  }, [step, fade]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  function goNext() {
    void Haptics.selectionAsync().catch(() => {});
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]!);
    else void finish();
  }

  async function finish() {
    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Success,
    ).catch(() => {});
    track("info", "Onboarding completed", "info", { lastStep: step });
    await markSeen();
    router.replace("/(tabs)");
  }

  function skip() {
    void Haptics.selectionAsync().catch(() => {});
    track("info", "Onboarding skipped", "info", { atStep: step });
    void finish();
  }

  async function requestPush() {
    void Haptics.selectionAsync().catch(() => {});
    try {
      const res = await Notifications.requestPermissionsAsync();
      track("info", "Onboarding push permission decision", "info", {
        status: res.status,
      });
    } catch {
      // Web or unsupported — proceed regardless.
      track("info", "Onboarding push unsupported", "info");
    }
    goNext();
  }

  async function connectCalendar() {
    void Haptics.selectionAsync().catch(() => {});
    track("info", "Onboarding connect-calendar tapped", "info");
    // Finish onboarding, then land on the provider-NEUTRAL calendar screen
    // where the user picks Google OR Microsoft. (Was hard-coded to open
    // Google OAuth directly, which ignored Microsoft users.)
    await markSeen();
    router.replace("/settings/calendar");
  }

  // ── Step content ─────────────────────────────────────────────────
  const content = (() => {
    switch (step) {
      case "welcome":
        return (
          <StepContent
            iconName="sparkles"
            iconTone={colors.brand}
            eyebrow="Welcome"
            title="Your workspace, in your pocket."
            body={
              "Manage every booking, customer, and reminder from your phone. " +
              "Built for operators who are rarely at a desk."
            }
            primary={{ label: "Get started", onPress: goNext }}
          />
        );
      case "notifications":
        return (
          <StepContent
            iconName="notifications"
            iconTone={colors.brand}
            eyebrow="Stay in the loop"
            title="Real-time booking alerts."
            body={
              "We'll let you know the moment a customer books, " +
              "reschedules, or needs your attention. You can fine-tune " +
              "the channels later in Settings."
            }
            primary={{
              label: Platform.OS === "web" ? "Continue" : "Allow notifications",
              onPress: requestPush,
            }}
            secondary={{ label: "Not now", onPress: goNext }}
          />
        );
      case "calendar":
        return (
          <StepContent
            iconName="calendar"
            iconTone={colors.brand}
            eyebrow="Stay synced"
            title="One calendar, no double-bookings."
            body={
              "Connect Google or Microsoft so external events block your " +
              "bookable hours automatically. You can change this any time " +
              "in Settings → Calendar."
            }
            primary={{
              label: "Connect a calendar",
              onPress: connectCalendar,
            }}
            secondary={{ label: "I'll do this later", onPress: finish }}
          />
        );
    }
  })();

  return (
    <ScreenContainer padding={false} edges={["top", "bottom"]}>
      {/* Top bar: progress + skip */}
      <View style={styles.topBar}>
        <ProgressDots step={step} />
        <AppText
          variant="smallStrong"
          style={styles.skip}
          onPress={skip}
          accessibilityRole="button"
          accessibilityLabel="Skip onboarding"
        >
          Skip
        </AppText>
      </View>

      <Animated.View style={[styles.body, fadeStyle]}>{content}</Animated.View>
    </ScreenContainer>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

type StepProps = {
  iconName: React.ComponentProps<typeof Ionicons>["name"];
  iconTone: string;
  eyebrow: string;
  title: string;
  body: string;
  primary: { label: string; onPress: () => void };
  secondary?: { label: string; onPress: () => void };
};

function StepContent({
  iconName,
  iconTone,
  eyebrow,
  title,
  body,
  primary,
  secondary,
}: StepProps) {
  return (
    <View style={styles.stepWrap}>
      <View style={styles.heroIconRow}>
        <View style={styles.heroIconChip}>
          <Ionicons name={iconName} size={36} color={iconTone} />
        </View>
      </View>

      <AppText
        variant="eyebrow"
        color="brand"
        align="center"
        style={styles.stepEyebrow}
      >
        {eyebrow}
      </AppText>
      <AppText variant="displayMd" align="center" style={styles.stepTitle}>
        {title}
      </AppText>
      <AppText
        variant="bodyLg"
        color="muted"
        align="center"
        style={styles.stepBody}
      >
        {body}
      </AppText>

      <View style={styles.actions}>
        <Button
          label={primary.label}
          variant="primary"
          size="lg"
          fullWidth
          onPress={primary.onPress}
        />
        {secondary ? (
          <Button
            label={secondary.label}
            variant="ghost"
            size="md"
            fullWidth
            onPress={secondary.onPress}
            style={{ marginTop: spacing.sm }}
          />
        ) : null}
      </View>
    </View>
  );
}

function ProgressDots({ step }: { step: Step }) {
  const idx = STEPS.indexOf(step);
  return (
    <View style={styles.dotsRow}>
      {STEPS.map((s, i) => (
        <View
          key={s}
          style={[
            styles.dot,
            i === idx && styles.dotActive,
            i < idx && styles.dotPast,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  skip: {
    color: colors.inkMuted,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
  },
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.borderSubtle,
  },
  dotActive: {
    width: 22,
    backgroundColor: colors.brand,
  },
  dotPast: {
    backgroundColor: colors.brandSubtle,
  },
  body: {
    flex: 1,
  },
  stepWrap: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing["3xl"],
  },
  heroIconRow: {
    marginBottom: spacing.xl,
  },
  heroIconChip: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.brandSubtle,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.brandGlow,
  },
  stepEyebrow: {
    letterSpacing: 1.3,
  },
  stepTitle: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  stepBody: {
    marginTop: spacing.md,
    maxWidth: 360,
  },
  actions: {
    width: "100%",
    marginTop: "auto",
    marginBottom: spacing["2xl"],
    maxWidth: 420,
  },
});

// keep imports tree-shake-safe on web
void radius;
