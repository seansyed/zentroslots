/**
 * ErrorBoundary — top-level safety net for render errors.
 *
 * When a render throws, React unmounts the whole tree by default. That's a
 * terrible experience: the user sees a blank screen and the operator
 * loses their context. This boundary catches the throw, records it to
 * telemetry, and shows a calm recovery surface with a Retry button.
 *
 * Scoped to the whole app — mounted in the root layout. We deliberately
 * do NOT have per-screen boundaries; a single bug shouldn't be allowed to
 * hide elsewhere. If a screen wants finer-grained recovery, wrap that
 * subtree in another <ErrorBoundary>.
 */

import * as React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as SplashScreen from "expo-splash-screen";

import { AppText } from "@/components/ui/Text";
import { track } from "@/lib/telemetry";
import { storage, STORAGE_KEYS } from "@/lib/storage";
import { colors, radius, spacing } from "@/theme";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
  errorInfo: { componentStack?: string } | null;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }): void {
    // A boot-path error can unmount the tree BEFORE the splash was hidden
    // (SplashScreen.hideAsync runs from AuthBoot effects that never complete).
    // Hide it here so THIS recovery screen is actually visible instead of
    // staying frozen behind the native launch splash (the "Z" ANR).
    SplashScreen.hideAsync().catch(() => {});
    track("crash", `Render error: ${error.name}: ${error.message}`, "error", {
      stack: error.stack?.split("\n").slice(0, 8).join("\n") ?? null,
      componentStack: errorInfo.componentStack?.split("\n").slice(0, 8).join("\n") ?? null,
    });
    this.setState({ errorInfo });
  }

  reset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  // Safe recovery: drop the persisted session so the next render / cold
  // start lands on the login screen instead of replaying a corrupt stored
  // session. Best-effort; never throws. Does not touch server state.
  clearSessionAndReset = () => {
    void (async () => {
      try {
        await Promise.all([
          storage.deleteItem(STORAGE_KEYS.sessionToken),
          storage.deleteItem(STORAGE_KEYS.sessionCookie),
          storage.deleteItem(STORAGE_KEYS.userId),
          storage.deleteItem(STORAGE_KEYS.userEmail),
        ]);
      } catch {
        /* best-effort */
      }
      this.reset();
    })();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.iconWrap}>
            <Ionicons name="warning-outline" size={32} color={colors.warningInk} />
          </View>
          <AppText variant="h2" align="center" style={{ marginTop: spacing.md }}>
            Something went sideways
          </AppText>
          <AppText
            variant="body"
            align="center"
            color="muted"
            style={{ marginTop: spacing.sm, paddingHorizontal: spacing.lg }}
          >
            The screen ran into an unexpected error. Your work hasn't been lost.
            Tap below to try again.
          </AppText>

          <Pressable
            onPress={this.reset}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Ionicons name="refresh" size={16} color={colors.inkOnBrand} />
            <AppText
              variant="bodyStrong"
              style={{ color: colors.inkOnBrand, marginLeft: 8 }}
            >
              Try again
            </AppText>
          </Pressable>

          {/* Secondary recovery — clears the locally-saved session so the
              next launch starts clean. Safe: no server-side change. */}
          <Pressable
            onPress={this.clearSessionAndReset}
            style={styles.secondaryButton}
            accessibilityRole="button"
            accessibilityLabel="Reset app data and sign out"
          >
            <AppText variant="body" color="muted">
              Reset app data &amp; sign out
            </AppText>
          </Pressable>

          {/* Tiny technical line for the operator's own debugging — not
              error-prone to display, just the name + message. */}
          <AppText
            variant="micro"
            color="subtle"
            align="center"
            style={{ marginTop: spacing.xl, paddingHorizontal: spacing.lg }}
          >
            {this.state.error.name}: {this.state.error.message}
          </AppText>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surfaceSubtle,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.warningSubtle,
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.brand,
    marginTop: spacing.xl,
  },
  secondaryButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
  },
});
