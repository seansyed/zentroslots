/**
 * QrCode — a high-contrast QR for a public booking URL.
 *
 * Renders locally via react-native-qrcode-svg (which draws on the already-
 * bundled react-native-svg — no extra native module, works offline, makes no
 * third-party network call). The encoded value is ONLY the canonical public
 * URL — never a token or personal data. Wrapped in a white card so it scans on
 * any surface.
 */

import * as React from "react";
import { StyleSheet, View } from "react-native";
import QRCodeSvg from "react-native-qrcode-svg";

import { AppText } from "./Text";
import { colors, radius, spacing } from "@/theme";

export function QrCode({
  value,
  size = 200,
  caption,
}: {
  value: string;
  size?: number;
  caption?: string;
}) {
  return (
    <View style={styles.wrap} accessibilityLabel="Booking page QR code">
      <View style={styles.qrCard}>
        <QRCodeSvg
          value={value}
          size={size}
          color="#0f172a"
          backgroundColor="#ffffff"
          ecl="M"
          quietZone={8}
        />
      </View>
      {caption ? (
        <AppText variant="caption" color="subtle" align="center" style={{ marginTop: spacing.sm }}>
          {caption}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
  },
  qrCard: {
    padding: spacing.md,
    backgroundColor: "#ffffff",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
});
