/**
 * /login — auth surface (email/password + Google + Microsoft).
 *
 * Mirrors the design language of the web app's premium login:
 *   • Brand wordmark
 *   • "Welcome back" heading
 *   • SSO buttons up top
 *   • "or use email" divider
 *   • Email + password form
 *   • Forgot password link
 *
 * State management is intentionally local — Zustand only touches the
 * store after a successful auth response.
 */

import * as React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

// OAuth on web is intentionally disabled: expo-web-browser's
// openAuthSessionAsync() can't listen for the zentromeet://oauth/callback
// deep link inside a browser (no native router), so the popup returns
// {type: "cancel"} immediately. On native the same flow works fine.
// Web testers use email + password — that path is fully wired.
const OAUTH_AVAILABLE = Platform.OS !== "web";

import { consumePendingOAuthError } from "./_layout";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { AppText } from "@/components/ui/Text";
import { useAuth } from "@/hooks/useAuth";
import { authApi } from "@/api/auth";
import { consumeSessionExpired } from "@/store/authStore";
import { colors, layout, spacing } from "@/theme";

type Mode = "login" | "forgot";

export default function LoginScreen() {
  const router = useRouter();
  const { signInWithPassword, signInWithOAuth } = useAuth();

  const [mode, setMode] = React.useState<Mode>("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [oauthLoading, setOauthLoading] = React.useState<null | "google" | "microsoft">(null);

  // Surface any OAuth deep-link error captured during cold-start
  // before the screen mounted. consumePendingOAuthError() is a
  // one-shot read — once consumed, the module-level slot is cleared.
  React.useEffect(() => {
    // Order matters: OAuth errors take precedence over the session
    // expiry hint because they're more specific. consumeSessionExpired
    // still runs so the flag clears either way.
    const expired = consumeSessionExpired();
    const pending = consumePendingOAuthError();
    if (pending) setError(pending);
    else if (expired) setError("Your session expired — please sign in again.");
  }, []);

  async function onSubmit() {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signInWithPassword(email.trim(), password);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace("/(tabs)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      setError(msg);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } finally {
      setLoading(false);
    }
  }

  async function onForgot() {
    if (!email.trim()) {
      setError("Enter your email to reset your password.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await authApi.forgotPassword(email.trim());
      // Backend always returns 200 (no email enumeration), so we always show
      // the same generic confirmation regardless of whether the account exists.
      setNotice("If an account exists for that email, we've sent a password-reset link. Check your inbox.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      // Network/rate-limit failure — keep the message generic + non-leaky.
      setError("Couldn't send the reset email right now. Please try again in a moment.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } finally {
      setLoading(false);
    }
  }

  function toggleMode() {
    setError(null);
    setNotice(null);
    setMode((m) => (m === "login" ? "forgot" : "login"));
  }

  async function onOAuth(provider: "google" | "microsoft") {
    setError(null);
    setOauthLoading(provider);
    void Haptics.selectionAsync().catch(() => {});
    try {
      await signInWithOAuth(provider);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace("/(tabs)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      setError(msg);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } finally {
      setOauthLoading(null);
    }
  }

  return (
    <ScreenContainer scrollable padding keyboardAvoiding edges={["top", "bottom"]}>
      {/* Official ZentroMeet badge */}
      <View style={styles.brandRow}>
        <Logo size={108} />
      </View>

      {/* Heading */}
      <AppText variant="displayMd" style={styles.title}>
        Welcome back
      </AppText>
      <AppText variant="bodyLg" color="muted" style={styles.subtitle}>
        Run appointments, automate scheduling, and grow your business with ZentroMeet.
      </AppText>

      {/* Auth card */}
      <Card variant="elevated" style={styles.card} padding={spacing.xl}>
        {/* SSO buttons — native only, and only in login mode (the reset flow
            is email-only). */}
        {mode === "login" && OAUTH_AVAILABLE ? (
          <>
            <Button
              label={oauthLoading === "google" ? "Opening Google…" : "Continue with Google"}
              variant="secondary"
              size="lg"
              fullWidth
              loading={oauthLoading === "google"}
              disabled={Boolean(oauthLoading) || loading}
              onPress={() => onOAuth("google")}
              leftIcon={<GoogleMark />}
              style={styles.providerBtn}
            />
            <Button
              label={oauthLoading === "microsoft" ? "Opening Microsoft…" : "Continue with Microsoft"}
              variant="secondary"
              size="lg"
              fullWidth
              loading={oauthLoading === "microsoft"}
              disabled={Boolean(oauthLoading) || loading}
              onPress={() => onOAuth("microsoft")}
              leftIcon={<MicrosoftMark />}
              style={styles.providerBtn}
            />

            {/* Divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <AppText variant="eyebrow" color="subtle" style={styles.dividerLabel}>
                or use email
              </AppText>
              <View style={styles.dividerLine} />
            </View>
          </>
        ) : null}

        {/* Form */}
        {mode === "forgot" ? (
          <AppText variant="small" color="muted" style={styles.field}>
            Enter your email and we&apos;ll send a link to reset your password.
          </AppText>
        ) : null}
        <Input
          label="Email"
          placeholder="you@company.com"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          value={email}
          onChangeText={setEmail}
          containerStyle={styles.field}
        />
        {mode === "login" ? (
          <Input
            label="Password"
            placeholder="••••••••"
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            containerStyle={styles.field}
          />
        ) : null}

        {notice ? (
          <View style={styles.errorBox}>
            <Ionicons name="checkmark-circle" size={16} color={colors.successInk} />
            <AppText variant="small" style={{ color: colors.successInk, flex: 1 }}>
              {notice}
            </AppText>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
            <AppText variant="small" style={{ color: colors.dangerInk, flex: 1 }}>
              {error}
            </AppText>
          </View>
        ) : null}

        <Button
          label={
            mode === "forgot"
              ? loading ? "Sending…" : "Send reset link"
              : loading ? "Signing in…" : "Sign in with email"
          }
          variant="primary"
          size="lg"
          fullWidth
          loading={loading}
          disabled={loading || Boolean(oauthLoading)}
          onPress={mode === "forgot" ? onForgot : onSubmit}
          style={styles.submitBtn}
        />

        <View style={styles.bottomLinks}>
          <Button
            label={mode === "login" ? "Forgot password?" : "Back to sign in"}
            variant="ghost"
            size="sm"
            onPress={toggleMode}
          />
        </View>
      </Card>

      <AppText variant="caption" color="subtle" align="center" style={styles.legal}>
        By signing in you agree to our Terms and Privacy Policy.
      </AppText>
    </ScreenContainer>
  );
}

function GoogleMark() {
  // Lightweight inline mark — keeps us from bundling lucide just for one icon.
  return (
    <View style={iconStyles.googleWrap}>
      <View style={[iconStyles.googleQuadrant, { backgroundColor: "#EA4335", top: 0, left: 0 }]} />
      <View style={[iconStyles.googleQuadrant, { backgroundColor: "#FBBC04", top: 0, right: 0 }]} />
      <View style={[iconStyles.googleQuadrant, { backgroundColor: "#34A853", bottom: 0, left: 0 }]} />
      <View style={[iconStyles.googleQuadrant, { backgroundColor: "#4285F4", bottom: 0, right: 0 }]} />
    </View>
  );
}
function MicrosoftMark() {
  return (
    <View style={iconStyles.msWrap}>
      <View style={[iconStyles.msQuadrant, { backgroundColor: "#F25022" }]} />
      <View style={[iconStyles.msQuadrant, { backgroundColor: "#7FBA00" }]} />
      <View style={[iconStyles.msQuadrant, { backgroundColor: "#00A4EF" }]} />
      <View style={[iconStyles.msQuadrant, { backgroundColor: "#FFB900" }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing["3xl"],
    marginTop: spacing.md,
  },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    marginBottom: spacing.sm,
  },
  subtitle: {
    marginBottom: spacing["2xl"],
    maxWidth: 360,
  },
  card: {
    width: "100%",
    marginBottom: spacing.lg,
  },
  providerBtn: {
    marginBottom: spacing.sm,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: spacing.lg,
    gap: spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerLabel: {
    marginHorizontal: spacing.sm,
  },
  field: {
    marginBottom: spacing.md,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    marginBottom: spacing.md,
  },
  submitBtn: {
    marginTop: spacing.sm,
  },
  bottomLinks: {
    alignItems: "center",
    marginTop: spacing.md,
  },
  legal: {
    marginTop: spacing.lg,
    paddingHorizontal: layout.screenPaddingX,
  },
});

const iconStyles = StyleSheet.create({
  googleWrap: {
    width: 18,
    height: 18,
    borderRadius: 9,
    overflow: "hidden",
    flexDirection: "row",
    flexWrap: "wrap",
  },
  googleQuadrant: {
    position: "absolute",
    width: 9,
    height: 9,
  },
  msWrap: {
    width: 18,
    height: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 1,
  },
  msQuadrant: {
    width: 8,
    height: 8,
  },
});
