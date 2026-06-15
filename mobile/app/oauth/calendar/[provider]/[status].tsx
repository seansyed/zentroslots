/**
 * Deep-link landing for calendar OAuth callbacks:
 *   zentromeet://oauth/calendar/{provider}/success
 *   zentromeet://oauth/calendar/{provider}/error?error=<code>
 *
 * In the normal (warm) flow, WebBrowser.openAuthSessionAsync on the
 * Settings → Calendar screen captures this redirect directly and the
 * router never mounts this screen. This route exists for the COLD-START /
 * background case where the OS hands the deep link to the app outside an
 * auth session — it refreshes the calendar-connection cache, surfaces any
 * error, and lands the user back on Settings → Calendar. No tokens or
 * secrets are ever present in the URL (only success/error).
 */

import * as React from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { AppText } from "@/components/ui/Text";
import { colors } from "@/theme";

export default function CalendarOAuthCallback() {
  const params = useLocalSearchParams<{
    provider?: string;
    status?: string;
    error?: string;
  }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [message, setMessage] = React.useState("Finishing calendar connection…");

  React.useEffect(() => {
    // Refresh any cached calendar-connection lists so the new state shows.
    void qc.invalidateQueries({ queryKey: ["calendarConnections"] });

    if (params.status === "error") {
      const code =
        typeof params.error === "string" && params.error
          ? decodeURIComponent(params.error)
          : "connect_failed";
      setMessage(`Couldn't connect ${params.provider ?? "calendar"} (${code}).`);
    }

    // Land back on the calendar settings screen. Brief delay so the
    // message is readable on the rare cold-start path.
    const t = setTimeout(() => {
      router.replace("/settings/calendar");
    }, params.status === "error" ? 1400 : 200);
    return () => clearTimeout(t);
  }, [params.provider, params.status, params.error, qc, router]);

  return (
    <View style={styles.root}>
      <ActivityIndicator size="large" color={colors.brand} />
      <AppText variant="body" color="muted" style={{ marginTop: 12, textAlign: "center", paddingHorizontal: 32 }}>
        {message}
      </AppText>
    </View>
  );
}

const styles = {
  root: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: colors.surfaceSubtle,
  },
};
