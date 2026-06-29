/**
 * Business Phone tab (M3) — tenant-state-aware. Shown to ALL signed-in users.
 *
 * States (resolvePhoneScreenState over GET /api/tenant/phone/status):
 *   • marketing      → info + "Set up / Add Business Phone on web" (opens web
 *                       billing in the external browser; NO in-app purchase)
 *   • setup_pending  → "setup pending", no calling controls
 *   • active         → number/forwarding/usage + bridge click-to-call
 *   • cap_reached    → same surface, outbound blocked + cap banner
 *   • locked         → disabled/suspended message, no controls
 *
 * This is NOT a softphone: tapping Call asks the server to ring the user's own
 * phone first, then connect the customer (caller ID = business number). There is
 * no in-app audio, no WebRTC, no microphone permission. The softphone is Phase 2
 * and only ever surfaces when businessPhoneActive && softphoneAvailable.
 */

import * as React from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";

import { AppText } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ApiError } from "@/api/client";
import { phoneApi, type PhoneCallRow } from "@/api/phone";
import { useProfile } from "@/hooks/useProfile";
import { usePhoneMe } from "@/hooks/usePhoneMe";
import { usePhoneStatus } from "@/hooks/usePhoneStatus";
import { queryKeys } from "@/lib/query";
import {
  KEYPAD_KEYS,
  isSupportedKeypadKey,
  validateDialInput,
  dialPreview,
  phoneCallErrorMessage,
  buildCallBackPayload,
  resolvePhoneScreenState,
  webCtaLabel,
  BUSINESS_PHONE_MARKETING,
  CLICK_TO_CALL_NOTE,
  OUTBOUND_CALL_SUCCESS_MESSAGE,
} from "@/lib/businessPhone";
import { colors, radius, spacing } from "@/theme";

function openWeb(url: string) {
  void Linking.openURL(url).catch(() => {});
}

export default function PhoneScreen() {
  const { data: profile } = useProfile();
  const isOperator = profile?.role === "admin" || profile?.role === "manager";

  // Status drives the whole screen (shown to everyone). Marketing for the
  // non-entitled; functional states for the rest.
  const statusQ = usePhoneStatus();
  const status = statusQ.data;
  const screen = status ? resolvePhoneScreenState(status) : null;
  const callingState = screen?.kind === "active" || screen?.kind === "cap_reached";

  // Per-user calling identity (bridge number) — only fetched on the calling surface.
  const meQ = usePhoneMe(callingState);
  const me = meQ.data;

  const callsQ = useQuery({
    queryKey: queryKeys.phoneCalls("recent"),
    queryFn: () => phoneApi.calls({ limit: 15 }),
    enabled: Boolean(callingState) && isOperator,
    staleTime: 30_000,
  });

  const [dial, setDial] = React.useState("");
  const [placing, setPlacing] = React.useState(false);
  const [callResult, setCallResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [bridgeInput, setBridgeInput] = React.useState("");
  const [savingBridge, setSavingBridge] = React.useState(false);
  const [bridgeNote, setBridgeNote] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [callingBackId, setCallingBackId] = React.useState<string | null>(null);

  const refreshing = statusQ.isFetching && !statusQ.isLoading;
  const onRefresh = React.useCallback(() => {
    void statusQ.refetch();
    if (callingState) {
      void meQ.refetch();
      if (isOperator) void callsQ.refetch();
    }
  }, [statusQ, meQ, callsQ, callingState, isOperator]);
  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
  );

  async function placeCall(payload: Parameters<typeof phoneApi.placeCall>[0], rowId?: string) {
    if (rowId) setCallingBackId(rowId);
    else setPlacing(true);
    setCallResult(null);
    try {
      await phoneApi.placeCall(payload);
      setCallResult({ ok: true, message: OUTBOUND_CALL_SUCCESS_MESSAGE });
      void meQ.refetch();
      void statusQ.refetch();
      if (isOperator) void callsQ.refetch();
    } catch (e) {
      const s = e instanceof ApiError ? e.status : 0;
      const serverMsg = e instanceof ApiError ? (e.data as { error?: string } | undefined)?.error : null;
      setCallResult({ ok: false, message: phoneCallErrorMessage(s, serverMsg) });
    } finally {
      setPlacing(false);
      setCallingBackId(null);
    }
  }

  function onNewCall() {
    const v = validateDialInput(dial);
    if (!v.ok) {
      setCallResult({ ok: false, message: v.message });
      return;
    }
    void placeCall({ toNumber: v.e164, callPurpose: "new_call" });
  }

  function onCallBack(row: PhoneCallRow) {
    const payload = buildCallBackPayload(row.fromNumber);
    if (payload) void placeCall(payload, row.id);
  }

  async function saveBridge(clear: boolean) {
    setSavingBridge(true);
    setBridgeNote(null);
    try {
      await phoneApi.updateMe({ bridgePhoneNumber: clear ? null : bridgeInput.trim() });
      await meQ.refetch();
      void statusQ.refetch();
      setBridgeInput("");
      setBridgeNote({ ok: true, message: clear ? "Calling number cleared." : "Calling number saved." });
    } catch (e) {
      const s = e instanceof ApiError ? e.status : 0;
      const serverMsg = e instanceof ApiError ? (e.data as { error?: string } | undefined)?.error : null;
      setBridgeNote({ ok: false, message: phoneCallErrorMessage(s, serverMsg) });
    } finally {
      setSavingBridge(false);
    }
  }

  // ── loading / error ──
  if (statusQ.isLoading || (callingState && meQ.isLoading)) {
    return (
      <ScreenContainer>
        <PageHeader title="Business Phone" />
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      </ScreenContainer>
    );
  }

  if (statusQ.isError || !status || !screen) {
    return (
      <ScreenContainer scrollable refreshControl={refreshControl}>
        <PageHeader title="Business Phone" />
        <Card variant="outline">
          <AppText variant="bodyStrong">Couldn&apos;t load Business Phone</AppText>
          <AppText variant="small" color="muted" style={{ marginTop: spacing.xs }}>
            Pull to refresh, or try again in a moment.
          </AppText>
          <Button label="Retry" variant="ghost" size="sm" onPress={() => void statusQ.refetch()} style={{ marginTop: spacing.sm }} />
        </Card>
      </ScreenContainer>
    );
  }

  // ── MARKETING (free / paid-no-addon): info + web CTA, no controls ──
  if (screen.kind === "marketing") {
    return (
      <ScreenContainer scrollable refreshControl={refreshControl} contentContainerStyle={{ paddingTop: spacing.sm }}>
        <PageHeader
          title="Business Phone"
          subtitle="Business calls, forwarding, and call logs."
          subtitleLines={2}
        />
        <Card style={styles.section}>
          <View style={styles.rowBetween}>
            <AppText variant="h3">{BUSINESS_PHONE_MARKETING.title}</AppText>
            <AppText variant="bodyStrong" color="brand">{BUSINESS_PHONE_MARKETING.price}</AppText>
          </View>
          <View style={{ marginTop: spacing.md }}>
            {BUSINESS_PHONE_MARKETING.features.map((f) => (
              <View key={f} style={styles.featureRow}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <AppText variant="small" style={{ flex: 1 }}>{f}</AppText>
              </View>
            ))}
          </View>
          <AppText variant="caption" color="muted" style={{ marginTop: spacing.sm }}>
            {BUSINESS_PHONE_MARKETING.limitations.join(" · ")}.
          </AppText>
          <Button
            label={webCtaLabel(screen.cta)}
            rightIcon={<Ionicons name="open-outline" size={16} color={colors.inkOnBrand} />}
            fullWidth
            onPress={() => openWeb(screen.webBillingUrl)}
            style={{ marginTop: spacing.md }}
          />
          <AppText variant="caption" color="subtle" align="center" style={{ marginTop: spacing.sm }}>
            {BUSINESS_PHONE_MARKETING.note}
          </AppText>
        </Card>
      </ScreenContainer>
    );
  }

  // ── SETUP PENDING ──
  if (screen.kind === "setup_pending") {
    return (
      <ScreenContainer scrollable refreshControl={refreshControl}>
        <PageHeader title="Business Phone" />
        <Card style={styles.section}>
          <View style={styles.stateIcon}>
            <Ionicons name="hourglass-outline" size={26} color={colors.warningInk} />
          </View>
          <AppText variant="h3" align="center">Business Phone setup pending</AppText>
          <AppText variant="small" color="muted" align="center" style={{ marginTop: spacing.xs }}>
            Your add-on is active. ParaFort / ZentroMeet is assigning your business number and forwarding
            line. You&apos;ll be able to make and receive calls as soon as it&apos;s ready.
          </AppText>
          {status.includedMinutes > 0 ? (
            <AppText variant="caption" color="subtle" align="center" style={{ marginTop: spacing.sm }}>
              Includes {status.includedMinutes} US &amp; Canada minutes / month.
            </AppText>
          ) : null}
        </Card>
      </ScreenContainer>
    );
  }

  // ── LOCKED (disabled / suspended) ──
  if (screen.kind === "locked") {
    const suspended = screen.reason === "suspended";
    return (
      <ScreenContainer scrollable refreshControl={refreshControl}>
        <PageHeader title="Business Phone" />
        <Card style={styles.section}>
          <View style={styles.stateIcon}>
            <Ionicons name="lock-closed-outline" size={24} color={colors.inkMuted} />
          </View>
          <AppText variant="h3" align="center">
            {suspended ? "Business Phone suspended" : "Business Phone disabled"}
          </AppText>
          <AppText variant="small" color="muted" align="center" style={{ marginTop: spacing.xs }}>
            {suspended
              ? "There's a billing issue with your subscription. Update your payment method on the ZentroMeet web app to restore Business Phone."
              : "Business Phone is currently turned off for your workspace. Contact your administrator if you think this is a mistake."}
          </AppText>
        </Card>
      </ScreenContainer>
    );
  }

  // ── ACTIVE / CAP REACHED — calling surface ──
  const capped = screen.kind === "cap_reached";
  const canPlace = status.canClickToCall; // false when capped or not permitted
  const preview = dialPreview(dial);
  const minutesUsed = status.minutesUsed;
  const cap = status.includedMinutes;
  const percent = cap > 0 ? Math.min(100, Math.round((minutesUsed / cap) * 100)) : 0;

  return (
    <ScreenContainer scrollable refreshControl={refreshControl}>
      <PageHeader title="Business Phone" subtitle="Call customers from your business number" />

      {capped ? (
        <View style={[styles.banner, styles.bannerErr, styles.section]}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
          <AppText variant="small" style={{ flex: 1, color: colors.danger }}>
            You&apos;ve reached this month&apos;s included minutes. Outbound calling is paused until your next
            billing cycle. Inbound forwarding still works.
          </AppText>
        </View>
      ) : null}

      {/* Business number */}
      <Card style={styles.section}>
        <AppText variant="eyebrow" color="subtle">Business number</AppText>
        <View style={styles.rowBetween}>
          <AppText variant="h3">{status.businessNumber ?? "Not assigned"}</AppText>
          <Pill tone={capped ? "warning" : "success"} label={capped ? "Cap reached" : "Active"} />
        </View>
        {status.forwardingNumber ? (
          <AppText variant="caption" color="muted" style={{ marginTop: spacing.xs }}>
            Forwarding to {status.forwardingNumber}
          </AppText>
        ) : null}
        <AppText variant="caption" color="muted" style={{ marginTop: spacing.xs }}>
          {CLICK_TO_CALL_NOTE}
        </AppText>
      </Card>

      {/* New call / dialer */}
      <Card style={styles.section}>
        <AppText variant="eyebrow" color="subtle">New call</AppText>
        <TextInput
          value={dial}
          onChangeText={(t) => {
            setDial(t);
            if (callResult) setCallResult(null);
          }}
          placeholder="+1 (555) 123-4567"
          placeholderTextColor={colors.inkSubtle}
          keyboardType="phone-pad"
          editable={canPlace}
          style={styles.dialField}
        />
        {preview ? (
          <AppText variant="caption" color="muted" align="center" style={{ marginTop: spacing.xs }}>
            Will dial {preview}
          </AppText>
        ) : null}

        <View style={styles.keypad}>
          {KEYPAD_KEYS.map((k) => {
            const supported = isSupportedKeypadKey(k);
            const enabled = supported && canPlace;
            return (
              <Pressable
                key={k}
                disabled={!enabled}
                onPress={() => {
                  setDial((d) => d + k);
                  if (callResult) setCallResult(null);
                }}
                style={({ pressed }) => [
                  styles.key,
                  pressed && enabled && styles.keyPressed,
                  !enabled && styles.keyDisabled,
                ]}
              >
                <AppText variant="h3" color={enabled ? "default" : "subtle"}>{k}</AppText>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.keypadFooter}>
          <Pressable onPress={() => setDial("")} disabled={dial === ""}>
            <AppText variant="smallStrong" color={dial === "" ? "subtle" : "muted"}>Clear</AppText>
          </Pressable>
          <Pressable onPress={() => setDial((d) => d.slice(0, -1))} disabled={dial === ""} hitSlop={8}>
            <Ionicons name="backspace-outline" size={22} color={dial === "" ? colors.inkSubtle : colors.inkMuted} />
          </Pressable>
        </View>

        <Button
          label="Call via Business Phone"
          leftIcon={<Ionicons name="call" size={18} color={colors.inkOnBrand} />}
          size="lg"
          fullWidth
          loading={placing}
          disabled={!canPlace}
          onPress={onNewCall}
          style={{ marginTop: spacing.md }}
        />
        {!canPlace ? (
          <AppText variant="caption" color="warning" align="center" style={{ marginTop: spacing.sm }}>
            {capped
              ? "Outbound calling is paused — monthly minutes used up."
              : me?.bridgePhoneNumberConfigured
                ? "Calling isn't enabled for your account yet."
                : "Set your calling number below first."}
          </AppText>
        ) : null}

        {callResult ? (
          <View style={[styles.banner, callResult.ok ? styles.bannerOk : styles.bannerErr]}>
            <Ionicons
              name={callResult.ok ? "checkmark-circle-outline" : "alert-circle-outline"}
              size={18}
              color={callResult.ok ? colors.success : colors.danger}
            />
            <AppText variant="small" style={{ flex: 1, color: callResult.ok ? colors.success : colors.danger }}>
              {callResult.message}
            </AppText>
          </View>
        ) : null}
      </Card>

      {/* My calling number */}
      <Card style={styles.section}>
        <AppText variant="eyebrow" color="subtle">My calling number</AppText>
        <View style={styles.rowBetween}>
          <AppText variant="bodyStrong">
            {me?.bridgePhoneNumberConfigured ? me?.bridgePhoneNumberMasked : "Not set"}
          </AppText>
          <Pill tone={me?.canPlaceCalls ? "success" : "warning"} label={me?.canPlaceCalls ? "Ready" : "Setup needed"} />
        </View>
        <AppText variant="caption" color="muted" style={{ marginTop: spacing.xs }}>
          We ring this phone first, then connect the customer. US &amp; Canada only.
        </AppText>
        <TextInput
          value={bridgeInput}
          onChangeText={setBridgeInput}
          placeholder="+1 (555) 123-4567"
          placeholderTextColor={colors.inkSubtle}
          keyboardType="phone-pad"
          editable={!savingBridge}
          style={styles.input}
        />
        <View style={styles.bridgeActions}>
          <Button label="Save" size="sm" loading={savingBridge} disabled={bridgeInput.trim() === ""} onPress={() => void saveBridge(false)} />
          {me?.bridgePhoneNumberConfigured ? (
            <Button label="Clear" variant="ghost" size="sm" disabled={savingBridge} onPress={() => void saveBridge(true)} />
          ) : null}
        </View>
        {bridgeNote ? (
          <AppText variant="caption" color={bridgeNote.ok ? "success" : "danger"} style={{ marginTop: spacing.xs }}>
            {bridgeNote.message}
          </AppText>
        ) : null}
      </Card>

      {/* Usage */}
      <Card style={styles.section}>
        <AppText variant="eyebrow" color="subtle">Usage this month</AppText>
        <View style={styles.rowBetween}>
          <AppText variant="body">{minutesUsed} / {cap} min</AppText>
          <AppText variant="small" color={capped ? "danger" : "muted"}>
            {status.minutesRemaining} left
          </AppText>
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${percent}%` }, capped && { backgroundColor: colors.danger }]} />
        </View>
      </Card>

      {/* Recent calls — operators only */}
      {isOperator ? (
        <Card style={styles.section}>
          <AppText variant="eyebrow" color="subtle">Recent calls</AppText>
          {callsQ.isLoading ? (
            <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.md }} />
          ) : !callsQ.data || callsQ.data.calls.length === 0 ? (
            <AppText variant="small" color="muted" style={{ marginTop: spacing.sm }}>No calls yet.</AppText>
          ) : (
            <View style={{ marginTop: spacing.sm }}>
              {callsQ.data.calls.map((c) => {
                const outbound = c.direction === "outbound";
                const counterparty = outbound ? c.toNumber : c.fromNumber;
                const canCallBack = c.direction === "inbound" && c.missed && Boolean(c.fromNumber);
                return (
                  <View key={c.id} style={styles.callRow}>
                    <Ionicons
                      name={c.missed ? "call-outline" : outbound ? "arrow-up-outline" : "arrow-down-outline"}
                      size={16}
                      color={c.missed ? colors.danger : colors.inkSubtle}
                    />
                    <View style={{ flex: 1 }}>
                      <AppText variant="small">{counterparty ?? "Unknown"}</AppText>
                      <AppText variant="caption" color="muted">{outbound ? "Outbound" : "Inbound"} · {c.status}</AppText>
                    </View>
                    {canCallBack ? (
                      <Pressable onPress={() => onCallBack(c)} disabled={callingBackId === c.id || !canPlace} hitSlop={8}>
                        {callingBackId === c.id ? (
                          <ActivityIndicator color={colors.brand} size="small" />
                        ) : (
                          <AppText variant="smallStrong" color={canPlace ? "brand" : "subtle"}>Call back</AppText>
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}
        </Card>
      ) : null}

      {/* Safety + softphone-coming-soon */}
      <View style={styles.safety}>
        <Ionicons name="shield-outline" size={16} color={colors.inkSubtle} />
        <AppText variant="caption" color="muted" style={{ flex: 1 }}>
          Calls go through your ZentroMeet Business Phone number. Emergency (911) calling is not supported.
          In-browser softphone is coming soon.
        </AppText>
      </View>
    </ScreenContainer>
  );
}

/** Tiny status pill (local). */
function Pill({ tone, label }: { tone: "success" | "warning" | "neutral"; label: string }) {
  const bg =
    tone === "success" ? colors.successSubtle : tone === "warning" ? colors.warningSubtle : colors.surfaceInset;
  const fg = tone === "success" ? colors.successInk : tone === "warning" ? colors.warningInk : colors.inkMuted;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <AppText variant="caption" style={{ color: fg, fontWeight: "700" }}>{label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing["5xl"], alignItems: "center" },
  section: { marginTop: spacing.lg },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.xs },
  featureRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 3 },
  stateIcon: { alignSelf: "center", marginBottom: spacing.sm },
  dialField: {
    marginTop: spacing.md, height: 56, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, textAlign: "center", fontSize: 24, fontWeight: "600", color: colors.ink,
  },
  keypad: { marginTop: spacing.md, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: spacing.sm },
  key: {
    width: "31%", height: 52, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center",
  },
  keyPressed: { backgroundColor: colors.surfaceInset },
  keyDisabled: { opacity: 0.3 },
  keypadFooter: { marginTop: spacing.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.xs },
  input: {
    marginTop: spacing.md, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, paddingHorizontal: spacing.md, fontSize: 15, color: colors.ink,
  },
  bridgeActions: { marginTop: spacing.sm, flexDirection: "row", gap: spacing.sm },
  banner: {
    marginTop: spacing.md, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm,
    padding: spacing.md, borderRadius: radius.md, borderWidth: 1,
  },
  bannerOk: { backgroundColor: colors.successSubtle, borderColor: colors.success },
  bannerErr: { backgroundColor: colors.dangerSubtle, borderColor: colors.danger },
  track: { marginTop: spacing.sm, height: 8, borderRadius: radius.full, backgroundColor: colors.surfaceInset, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.full, backgroundColor: colors.brand },
  callRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle,
  },
  safety: {
    marginTop: spacing.lg, marginBottom: spacing["3xl"], flexDirection: "row", gap: spacing.sm,
    alignItems: "flex-start", padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceInset,
  },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
});
