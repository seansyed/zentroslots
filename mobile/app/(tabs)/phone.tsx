/**
 * Business Phone tab (P1.3) — bridge-based calling on mobile. NOT WebRTC, NOT
 * CallKit: tapping Call asks the server to ring the user's own phone first, then
 * connect the customer, who sees the ZentroMeet business number as caller ID.
 *
 * Visible only to entitled tenants + users with phone access (the tab is
 * href:null otherwise; this screen also self-guards). Staff see their own
 * dialer + number setup; operators (admin/manager) additionally see recent
 * calls. The full personal bridge number is never shown — masked only.
 */

import * as React from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
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
import { queryKeys } from "@/lib/query";
import {
  KEYPAD_KEYS,
  isSupportedKeypadKey,
  validateDialInput,
  dialPreview,
  phoneCallErrorMessage,
  buildCallBackPayload,
  OUTBOUND_CALL_SUCCESS_MESSAGE,
} from "@/lib/businessPhone";
import { colors, radius, spacing } from "@/theme";

export default function PhoneScreen() {
  const { data: profile, isLoading: profileLoading } = useProfile();
  const bp = profile?.businessPhone;
  const hasAccess = bp?.entitled === true && bp?.hasPhoneAccess === true;
  const isOperator = profile?.role === "admin" || profile?.role === "manager";

  const meQ = usePhoneMe(hasAccess);
  const me = meQ.data;

  const callsQ = useQuery({
    queryKey: queryKeys.phoneCalls("recent"),
    queryFn: () => phoneApi.calls({ limit: 15 }),
    enabled: hasAccess && isOperator,
    staleTime: 30_000,
  });

  const [dial, setDial] = React.useState("");
  const [placing, setPlacing] = React.useState(false);
  const [callResult, setCallResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const [bridgeInput, setBridgeInput] = React.useState("");
  const [savingBridge, setSavingBridge] = React.useState(false);
  const [bridgeNote, setBridgeNote] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [callingBackId, setCallingBackId] = React.useState<string | null>(null);

  async function placeCall(payload: Parameters<typeof phoneApi.placeCall>[0], rowId?: string) {
    if (rowId) setCallingBackId(rowId);
    else setPlacing(true);
    setCallResult(null);
    try {
      await phoneApi.placeCall(payload);
      setCallResult({ ok: true, message: OUTBOUND_CALL_SUCCESS_MESSAGE });
      void meQ.refetch();
      if (isOperator) void callsQ.refetch();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const serverMsg = e instanceof ApiError ? (e.data as { error?: string } | undefined)?.error : null;
      setCallResult({ ok: false, message: phoneCallErrorMessage(status, serverMsg) });
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
      await meQ.refetch(); // pull the masked view back
      setBridgeInput(""); // never keep the full personal number on screen
      setBridgeNote({ ok: true, message: clear ? "Calling number cleared." : "Calling number saved." });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const serverMsg = e instanceof ApiError ? (e.data as { error?: string } | undefined)?.error : null;
      setBridgeNote({ ok: false, message: phoneCallErrorMessage(status, serverMsg) });
    } finally {
      setSavingBridge(false);
    }
  }

  // ── guards ──
  if (profileLoading || (hasAccess && meQ.isLoading)) {
    return (
      <ScreenContainer>
        <PageHeader title="Phone" />
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      </ScreenContainer>
    );
  }

  if (!hasAccess) {
    return (
      <ScreenContainer>
        <PageHeader title="Phone" />
        <Card variant="outline">
          <AppText variant="bodyStrong">Business Phone isn't available</AppText>
          <AppText variant="small" color="muted" style={{ marginTop: spacing.xs }}>
            Ask your workspace admin for access to the Business Phone module.
          </AppText>
        </Card>
      </ScreenContainer>
    );
  }

  const preview = dialPreview(dial);
  const canPlace = me?.canPlaceCalls === true;
  const usage = me?.usage ?? null;
  const percent = usage && usage.cap > 0 ? Math.min(100, Math.round((usage.minutesUsed / usage.cap) * 100)) : 0;

  return (
    <ScreenContainer scrollable>
      <PageHeader title="Phone" subtitle="Call customers from your business number" />

      {/* Business number */}
      <Card style={styles.section}>
        <AppText variant="eyebrow" color="subtle">Business number</AppText>
        <View style={styles.rowBetween}>
          <AppText variant="h3">{me?.businessNumber ?? "Not assigned"}</AppText>
          <Pill tone={me?.lineEnabled ? "success" : "neutral"} label={me?.lineEnabled ? "Active" : "Off"} />
        </View>
        <AppText variant="caption" color="muted" style={{ marginTop: spacing.xs }}>
          Customers see this number as caller ID — never your personal phone.
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
            return (
              <Pressable
                key={k}
                disabled={!supported}
                onPress={() => {
                  setDial((d) => d + k);
                  if (callResult) setCallResult(null);
                }}
                style={({ pressed }) => [
                  styles.key,
                  pressed && supported && styles.keyPressed,
                  !supported && styles.keyDisabled,
                ]}
              >
                <AppText variant="h3" color={supported ? "default" : "subtle"}>{k}</AppText>
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
            {me?.bridgePhoneNumberConfigured
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
          <Pill tone={canPlace ? "success" : "warning"} label={canPlace ? "Ready" : "Setup needed"} />
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
          <Button
            label="Save"
            size="sm"
            loading={savingBridge}
            disabled={bridgeInput.trim() === ""}
            onPress={() => void saveBridge(false)}
          />
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
      {usage ? (
        <Card style={styles.section}>
          <AppText variant="eyebrow" color="subtle">Usage this month</AppText>
          <View style={styles.rowBetween}>
            <AppText variant="body">
              {usage.minutesUsed} / {usage.cap} min
            </AppText>
            <AppText variant="small" color="muted">{percent}%</AppText>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        </Card>
      ) : null}

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
                      <AppText variant="caption" color="muted">
                        {outbound ? "Outbound" : "Inbound"} · {c.status}
                      </AppText>
                    </View>
                    {canCallBack ? (
                      <Pressable onPress={() => onCallBack(c)} disabled={callingBackId === c.id || !canPlace} hitSlop={8}>
                        {callingBackId === c.id ? (
                          <ActivityIndicator color={colors.brand} size="small" />
                        ) : (
                          <AppText variant="smallStrong" color="brand">Call back</AppText>
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

      {/* Safety note */}
      <View style={styles.safety}>
        <Ionicons name="shield-outline" size={16} color={colors.inkSubtle} />
        <AppText variant="caption" color="muted" style={{ flex: 1 }}>
          Calls are placed through your ZentroMeet Business Phone number. Emergency calling is not supported.
        </AppText>
      </View>
    </ScreenContainer>
  );
}

/** Tiny status pill (local — avoids coupling to the shared Pill's API). */
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
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  dialField: {
    marginTop: spacing.md,
    height: 56,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    textAlign: "center",
    fontSize: 24,
    fontWeight: "600",
    color: colors.ink,
  },
  keypad: {
    marginTop: spacing.md,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: spacing.sm,
  },
  key: {
    width: "31%",
    height: 52,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  keyPressed: { backgroundColor: colors.surfaceInset },
  keyDisabled: { opacity: 0.3 },
  keypadFooter: {
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
  },
  input: {
    marginTop: spacing.md,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.ink,
  },
  bridgeActions: { marginTop: spacing.sm, flexDirection: "row", gap: spacing.sm },
  banner: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  bannerOk: { backgroundColor: colors.successSubtle, borderColor: colors.success },
  bannerErr: { backgroundColor: colors.dangerSubtle, borderColor: colors.danger },
  track: {
    marginTop: spacing.sm,
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceInset,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: radius.full, backgroundColor: colors.brand },
  callRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  safety: {
    marginTop: spacing.lg,
    marginBottom: spacing["3xl"],
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceInset,
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
});
