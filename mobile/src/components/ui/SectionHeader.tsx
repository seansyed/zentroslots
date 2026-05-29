/**
 * SectionHeader — eyebrow + title + optional action / description.
 *
 *   <SectionHeader
 *     eyebrow="Today"
 *     title="Your schedule"
 *     action={<Button label="See all" variant="ghost" size="sm" />}
 *   />
 */

import * as React from "react";
import { StyleSheet, View } from "react-native";

import { spacing } from "@/theme";

import { AppText } from "./Text";

type Props = {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
};

export function SectionHeader({ eyebrow, title, description, action }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.copy}>
        {eyebrow ? (
          <AppText variant="eyebrow" color="brand" style={styles.eyebrow}>
            {eyebrow}
          </AppText>
        ) : null}
        <AppText variant="h2" numberOfLines={2}>
          {title}
        </AppText>
        {description ? (
          <AppText variant="small" color="muted" style={styles.description}>
            {description}
          </AppText>
        ) : null}
      </View>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    marginBottom: 2,
  },
  description: {
    marginTop: spacing.xs,
  },
  action: {
    flexShrink: 0,
  },
});
