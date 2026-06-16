/**
 * LinkShareCard — one public booking link with Copy / Share / Open / QR.
 *
 * Reused by the Share Links modal (tenant page + each service) and the service
 * detail screen. Shows the canonical URL (read-only), a row of one-tap actions,
 * inline "Link copied" feedback, and a collapsible QR encoding the same URL.
 * No business logic — it's handed a ready-built canonical URL.
 */

import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { AppText } from "./Text";
import { Card } from "./Card";
import { QrCode } from "./QrCode";
import { copyLink, openLink, shareLink } from "@/lib/share";
import { colors, radius, spacing } from "@/theme";

export function LinkShareCard({
  title,
  subtitle,
  url,
  defaultShowQr = false,
}: {
  title: string;
  subtitle?: string;
  url: string;
  defaultShowQr?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const [showQr, setShowQr] = React.useState(defaultShowQr);
  const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const onCopy = React.useCallback(async () => {
    const ok = await copyLink(url);
    if (ok) {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    }
  }, [url]);

  return (
    <Card variant="outline" style={styles.card}>
      <View style={styles.headRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="bodyStrong" numberOfLines={1}>{title}</AppText>
          {subtitle ? (
            <AppText variant="caption" color="muted" numberOfLines={1} style={{ marginTop: 1 }}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {copied ? (
          <View style={styles.copiedPill}>
            <Ionicons name="checkmark" size={12} color={colors.successInk} />
            <AppText variant="micro" style={{ color: colors.successInk, marginLeft: 3 }}>
              Link copied
            </AppText>
          </View>
        ) : null}
      </View>

      <Pressable onPress={onCopy} accessibilityRole="button" accessibilityLabel={`Copy link: ${url}`}>
        <View style={styles.urlBox}>
          <Ionicons name="link-outline" size={14} color={colors.inkSubtle} />
          <AppText variant="small" color="muted" numberOfLines={1} style={{ flex: 1, marginLeft: 6 }}>
            {url}
          </AppText>
        </View>
      </Pressable>

      <View style={styles.actionsRow}>
        <ActionBtn icon="copy-outline" label="Copy" onPress={onCopy} />
        <ActionBtn icon="share-social-outline" label="Share" onPress={() => void shareLink(url, title)} />
        <ActionBtn icon="open-outline" label="Open" onPress={() => void openLink(url)} />
        <ActionBtn
          icon="qr-code-outline"
          label="QR"
          active={showQr}
          onPress={() => setShowQr((s) => !s)}
        />
      </View>

      {showQr ? (
        <View style={{ marginTop: spacing.md }}>
          <QrCode value={url} size={200} caption="Scan to open this booking page" />
        </View>
      ) : null}
    </Card>
  );
}

function ActionBtn({
  icon,
  label,
  onPress,
  active,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.actionBtn, active && styles.actionBtnActive]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color={active ? colors.inkOnBrand : colors.brand} />
      <AppText
        variant="micro"
        style={{ color: active ? colors.inkOnBrand : colors.brand, marginTop: 3, fontWeight: "600" }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  copiedPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.successSubtle,
  },
  urlBox: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceInset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.brandSubtle,
  },
  actionBtnActive: {
    backgroundColor: colors.brand,
  },
});
