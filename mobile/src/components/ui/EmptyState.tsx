/**
 * EmptyState — premium empty surface with icon, copy, optional CTA.
 *
 *   <EmptyState
 *     icon={<Ionicons name="calendar-outline" size={28} color={colors.brand} />}
 *     title="Your calendar is open"
 *     body="Share your booking page to start accepting meetings."
 *     action={<Button label="Share link" variant="primary" />}
 *   />
 */

import * as React from "react";
import { StyleSheet, View } from "react-native";

import { colors, radius, spacing } from "@/theme";

import { AppText } from "./Text";

type Props = {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
};

export function EmptyState({ icon, title, body, action }: Props) {
  return (
    <View style={styles.wrap}>
      {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
      <AppText variant="h3" align="center" style={styles.title}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="body" color="muted" align="center" style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing["4xl"],
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    backgroundColor: colors.brandSubtle,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: {
    maxWidth: 280,
  },
  body: {
    marginTop: spacing.sm,
    maxWidth: 320,
  },
  action: {
    marginTop: spacing["2xl"],
  },
});
