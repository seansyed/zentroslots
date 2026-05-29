/**
 * ErrorState — premium retryable error surface.
 *
 *   <ErrorState
 *     title="Couldn't load your schedule"
 *     description="Pull to refresh or tap Retry."
 *     onRetry={refetch}
 *   />
 *
 * Treats network errors differently from server errors via the `kind`
 * prop so the copy + tone match what actually happened.
 */

import * as React from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { Button } from "./Button";
import { AppText } from "./Text";
import { colors, radius, spacing } from "@/theme";

type Props = {
  title?: string;
  description?: string;
  /** Mirrors ApiError.kind so screens can pass through without mapping.
   *  "client" (4xx) renders the same tone as "unknown" but lets us hand
   *  the user the server's error message via `description`. */
  kind?: "network" | "server" | "unknown" | "client";
  onRetry?: () => void;
};

export function ErrorState({
  title,
  description,
  kind = "unknown",
  onRetry,
}: Props) {
  const tone = KIND_TONE[kind];
  return (
    <View style={styles.wrap}>
      <View style={[styles.iconWrap, { backgroundColor: tone.bg }]}>
        <Ionicons name={tone.icon} size={26} color={tone.fg} />
      </View>
      <AppText variant="h3" align="center" style={styles.title}>
        {title ?? tone.title}
      </AppText>
      <AppText variant="small" color="muted" align="center" style={styles.body}>
        {description ?? tone.body}
      </AppText>
      {onRetry ? (
        <Button
          label="Try again"
          variant="primary"
          size="md"
          onPress={onRetry}
          style={styles.cta}
          leftIcon={<Ionicons name="refresh" size={16} color={colors.inkOnBrand} />}
        />
      ) : null}
    </View>
  );
}

const KIND_TONE: Record<
  NonNullable<Props["kind"]>,
  {
    icon: React.ComponentProps<typeof Ionicons>["name"];
    fg: string;
    bg: string;
    title: string;
    body: string;
  }
> = {
  network: {
    icon: "cloud-offline-outline",
    fg: colors.warning,
    bg: colors.warningSubtle,
    title: "You're offline",
    body: "We couldn't reach the server. Check your connection and try again.",
  },
  server: {
    icon: "alert-circle-outline",
    fg: colors.danger,
    bg: colors.dangerSubtle,
    title: "Something went wrong",
    body: "Our team has been notified. Pull to refresh once you're ready to retry.",
  },
  unknown: {
    icon: "warning-outline",
    fg: colors.warning,
    bg: colors.warningSubtle,
    title: "We hit a snag",
    body: "Tap Retry to load again.",
  },
  client: {
    // 4xx — surface the server's description and lean on the same
    // warning tone as "unknown". The caller almost always passes a
    // specific `description` here, so the default copy stays generic.
    icon: "information-circle-outline",
    fg: colors.warning,
    bg: colors.warningSubtle,
    title: "Couldn't complete",
    body: "Adjust your input or try again.",
  },
};

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing["3xl"],
  },
  iconWrap: {
    width: 60,
    height: 60,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: { maxWidth: 280 },
  body: { marginTop: spacing.sm, maxWidth: 320 },
  cta: { marginTop: spacing["2xl"] },
});
