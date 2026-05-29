/**
 * /settings/diagnostics — beta operator diagnostics surface.
 *
 * What it shows (top → bottom):
 *   • Status header: app version, connectivity, last sync timestamp.
 *   • KPI strip:     count of errors / warnings / breadcrumbs in the
 *                    in-memory ring buffer.
 *   • Filter chips:  All / Errors / Network / Mutations / Navigation.
 *   • Event list:    most recent at the top, with kind/severity icon,
 *                    label, relative time, expandable detail.
 *   • Footer:        Clear log + Copy log (where the platform supports it).
 *
 * Why this exists:
 *   For a beta cohort, "send me a screenshot of /settings/diagnostics"
 *   is a fast and reliable triage path. The telemetry buffer is local
 *   (no upload) so there's no PII/privacy concern.
 *
 * No production data leaks: the buffer only contains structural metadata
 * (URLs, status codes, error messages). Telemetry code at call sites is
 * already PII-safe.
 */

import * as React from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { AppText } from "@/components/ui/Text";
import { env } from "@/lib/env";
import {
  clearTelemetry,
  getBuffer,
  subscribe,
  type TelemetryEvent,
  type TelemetryKind,
} from "@/lib/telemetry";
import { useHealth } from "@/hooks/useHealth";
import { useNetworkStore } from "@/store/networkStore";
import { colors, layout, radius, shadows, spacing } from "@/theme";

type Filter = "all" | TelemetryKind;

const KIND_ICON: Record<TelemetryKind, React.ComponentProps<typeof Ionicons>["name"]> = {
  crash: "warning",
  runtime: "bug",
  network: "cloud-offline-outline",
  mutation: "swap-horizontal",
  navigation: "navigate-outline",
  info: "ellipse-outline",
};

const SEVERITY_TONE: Record<TelemetryEvent["severity"], PillTone> = {
  info: "neutral",
  warn: "warning",
  error: "danger",
};

function formatRel(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 1000) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const isOnline = useNetworkStore((s) => s.isOnline);
  const lastOnlineAt = useNetworkStore((s) => s.lastOnlineAt);
  const healthQ = useHealth();

  // The telemetry buffer is mutable, so we subscribe and re-read on
  // every change rather than holding a snapshot.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    return subscribe(() => setTick((t) => t + 1));
  }, []);
  // Also re-tick every 30s so the "X ago" labels keep drifting.
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const [filter, setFilter] = React.useState<Filter>("all");
  const [expanded, setExpanded] = React.useState<number | null>(null);

  const events = React.useMemo(() => {
    const raw = getBuffer();
    return raw
      .filter((e) => (filter === "all" ? true : e.kind === filter))
      .reverse(); // most recent first
  }, [filter]);

  const counts = React.useMemo(() => {
    const out = { error: 0, warn: 0, info: 0 };
    for (const e of getBuffer()) {
      out[e.severity] += 1;
    }
    return out;
  }, []);

  const now = Date.now();

  async function onCopy() {
    const text = getBuffer()
      .slice()
      .reverse()
      .map((e) => {
        const detail = e.detail
          ? "\n  detail: " + JSON.stringify(e.detail)
          : "";
        return `[${formatAbsoluteTime(e.ts)}] ${e.kind}/${e.severity}: ${e.label}${detail}`;
      })
      .join("\n");
    // No expo-clipboard dep — use the browser API on web; on native we
    // surface the text in an Alert so the operator can long-press to
    // select. Good enough for a beta diagnostic flow.
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert("Copied", "Diagnostics log copied to clipboard.");
        return;
      } catch {
        // Fall through to the alert fallback below.
      }
    }
    Alert.alert(
      "Diagnostics log",
      // Cap at ~1500 chars so the alert is still usable.
      text.length > 1500 ? text.slice(-1500) : text,
      [{ text: "Done", style: "default" }],
    );
  }

  function onClear() {
    Alert.alert(
      "Clear diagnostics log?",
      "This won't affect your app data — only the local debug trail.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            void clearTelemetry();
          },
        },
      ],
    );
  }

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "crash", label: "Crashes" },
    { id: "runtime", label: "Runtime" },
    { id: "network", label: "Network" },
    { id: "mutation", label: "Mutations" },
    { id: "navigation", label: "Nav" },
  ];

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Topbar */}
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/settings");
          }}
        />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          Diagnostics
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Status card ──────────────────────────────────────── */}
        <SectionFade>
          <Card>
            <View style={styles.statusRow}>
              <View style={{ flex: 1 }}>
                <AppText variant="eyebrow" color="brand">Build</AppText>
                <AppText variant="bodyStrong">v{env.appVersion}</AppText>
              </View>
              <View style={{ flex: 1, alignItems: "center" }}>
                <AppText variant="eyebrow" color="muted">Connection</AppText>
                <Pill tone={isOnline ? "success" : "warning"}>
                  {isOnline ? "Online" : "Offline"}
                </Pill>
              </View>
              <View style={{ flex: 1, alignItems: "flex-end" }}>
                <AppText variant="eyebrow" color="muted">Last sync</AppText>
                <AppText variant="bodyStrong" style={{ fontVariant: ["tabular-nums"] }}>
                  {lastOnlineAt ? formatRel(lastOnlineAt, now) : "—"}
                </AppText>
              </View>
            </View>
          </Card>
        </SectionFade>

        {/* ── Backend health ───────────────────────────────────── */}
        <SectionFade delay={40} style={{ marginTop: spacing.md }}>
          <BackendHealthCard
            loading={healthQ.isLoading}
            error={healthQ.isError}
            data={healthQ.data}
            onRefresh={() => {
              void Haptics.selectionAsync().catch(() => {});
              void healthQ.refetch();
            }}
          />
        </SectionFade>

        {/* ── Counts strip ─────────────────────────────────────── */}
        <SectionFade delay={80} style={{ marginTop: spacing.md }}>
          <View style={styles.countsRow}>
            <CountCard label="Errors" value={counts.error} tone="danger" />
            <CountCard label="Warnings" value={counts.warn} tone="warning" />
            <CountCard label="Breadcrumbs" value={counts.info} tone="neutral" />
          </View>
        </SectionFade>

        {/* ── Filter chips ─────────────────────────────────────── */}
        <SectionFade delay={120} style={{ marginTop: spacing.lg }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {filters.map((f) => {
              const active = filter === f.id;
              return (
                <Pressable
                  key={f.id}
                  onPress={() => setFilter(f.id)}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter: ${f.label}`}
                >
                  <AppText
                    variant="smallStrong"
                    style={{
                      color: active ? colors.brand : colors.inkMuted,
                      letterSpacing: 0.3,
                    }}
                  >
                    {f.label}
                  </AppText>
                </Pressable>
              );
            })}
          </ScrollView>
        </SectionFade>

        {/* ── Event list ───────────────────────────────────────── */}
        <SectionFade delay={180} style={{ marginTop: spacing.md }}>
          {events.length === 0 ? (
            <Card variant="outline">
              <EmptyState
                icon={<Ionicons name="checkmark-circle-outline" size={26} color={colors.success} />}
                title="Clean trail"
                body="No events recorded for this filter. Restart the app or interact with screens to populate the log."
              />
            </Card>
          ) : (
            <Card padding="none">
              {events.map((e, i) => {
                const isOpen = expanded === i;
                return (
                  <PressableCard
                    key={`${e.ts}-${i}`}
                    variant="plain"
                    padding={0}
                    onPress={() => setExpanded(isOpen ? null : i)}
                    style={[
                      styles.eventRow,
                      i < events.length - 1 && styles.eventDivider,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`${e.kind} event: ${e.label}`}
                  >
                    <View style={styles.eventIcon}>
                      <Ionicons
                        name={KIND_ICON[e.kind]}
                        size={16}
                        color={
                          e.severity === "error"
                            ? colors.danger
                            : e.severity === "warn"
                              ? colors.warningInk
                              : colors.inkMuted
                        }
                      />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.eventTopLine}>
                        <AppText variant="smallStrong" numberOfLines={isOpen ? 0 : 1}>
                          {e.label}
                        </AppText>
                      </View>
                      <View style={styles.eventMetaRow}>
                        <Pill tone={SEVERITY_TONE[e.severity]}>{e.kind}</Pill>
                        <AppText
                          variant="micro"
                          color="subtle"
                          style={{ marginLeft: 6, fontVariant: ["tabular-nums"] }}
                        >
                          {formatRel(e.ts, now)} · {formatAbsoluteTime(e.ts)}
                        </AppText>
                      </View>
                      {isOpen && e.detail ? (
                        <View style={styles.detailBlock}>
                          <AppText
                            variant="micro"
                            style={styles.detailMono}
                            selectable
                          >
                            {JSON.stringify(e.detail, null, 2)}
                          </AppText>
                        </View>
                      ) : null}
                    </View>
                    <Ionicons
                      name={isOpen ? "chevron-down" : "chevron-forward"}
                      size={14}
                      color={colors.inkSubtle}
                    />
                  </PressableCard>
                );
              })}
            </Card>
          )}
        </SectionFade>

        {/* ── Footer actions ───────────────────────────────────── */}
        <SectionFade delay={240} style={{ marginTop: spacing.lg, flexDirection: "row", gap: spacing.sm }}>
          <Pressable
            onPress={onCopy}
            style={[styles.footerBtn, styles.footerBtnPrimary]}
            accessibilityRole="button"
            accessibilityLabel="Copy log to clipboard"
          >
            <Ionicons name="copy-outline" size={14} color={colors.inkOnBrand} />
            <AppText
              variant="smallStrong"
              style={{ color: colors.inkOnBrand, marginLeft: 6 }}
            >
              Copy log
            </AppText>
          </Pressable>
          <Pressable
            onPress={onClear}
            style={[styles.footerBtn, styles.footerBtnSecondary]}
            accessibilityRole="button"
            accessibilityLabel="Clear log"
          >
            <Ionicons name="trash-outline" size={14} color={colors.ink} />
            <AppText
              variant="smallStrong"
              style={{ color: colors.ink, marginLeft: 6 }}
            >
              Clear log
            </AppText>
          </Pressable>
        </SectionFade>

        <View style={{ height: spacing["3xl"] }} />
      </ScrollView>
    </ScreenContainer>
  );
}

type BackendHealthProps = {
  loading: boolean;
  error: boolean;
  data: import("@/api/health").HealthResponse | undefined;
  onRefresh: () => void;
};

/**
 * BackendHealthCard — surfaces the backend's `/api/health` response.
 *
 * Shows:
 *   • Overall ok/degraded chip
 *   • Backend version + env (small text, beneath the chip)
 *   • A grid of the 5 most operationally meaningful checks:
 *       db, smtp_transport, auth_subsystem, reminder_delivery,
 *       tenant_payment_vault.
 *   • Refresh affordance — pull-to-refresh is the more discoverable
 *     gesture but a tap chip is faster.
 *
 * Failure modes are deliberate:
 *   • A network failure (offline / DNS) shows a calm "Couldn't reach
 *     backend" card with a Retry. We don't surface error details
 *     because the user's network is probably the cause.
 *   • A backend `ok: false` returns the same checks structure but
 *     with offending rows red; rendering matches.
 */
function BackendHealthCard({ loading, error, data, onRefresh }: BackendHealthProps) {
  const featuredKeys = [
    "db",
    "smtp_transport",
    "auth_subsystem",
    "reminder_delivery",
    "tenant_payment_vault",
  ];

  if (loading) {
    return (
      <Card style={styles.healthCard}>
        <View style={styles.healthHeader}>
          <AppText variant="eyebrow" color="muted">Backend</AppText>
          <AppText variant="micro" color="subtle">Checking…</AppText>
        </View>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card style={styles.healthCard}>
        <View style={styles.healthHeader}>
          <AppText variant="eyebrow" color="muted">Backend</AppText>
          <Pill tone="warning">Unreachable</Pill>
        </View>
        <AppText
          variant="caption"
          color="muted"
          style={{ marginTop: spacing.sm }}
        >
          Couldn't reach the backend. Check your connection and try again.
        </AppText>
        <Pressable
          onPress={onRefresh}
          style={[styles.healthRefresh, { marginTop: spacing.md }]}
          accessibilityRole="button"
          accessibilityLabel="Retry backend health check"
        >
          <Ionicons name="refresh-outline" size={14} color={colors.brand} />
          <AppText
            variant="smallStrong"
            style={{ color: colors.brand, marginLeft: 6 }}
          >
            Retry
          </AppText>
        </Pressable>
      </Card>
    );
  }

  const featured = featuredKeys
    .map((key) => ({ key, check: data.checks?.[key] }))
    .filter((row): row is { key: string; check: HealthCheckLike } => Boolean(row.check));

  return (
    <Card style={styles.healthCard}>
      <View style={styles.healthHeader}>
        <View>
          <AppText variant="eyebrow" color="muted">Backend</AppText>
          <AppText
            variant="micro"
            color="subtle"
            style={{ marginTop: 2, letterSpacing: 0.3 }}
          >
            {data.env?.toUpperCase() ?? "—"} · v{data.version ?? "—"}
          </AppText>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Pill tone={data.ok ? "success" : "warning"}>
            {data.ok ? "All systems go" : "Degraded"}
          </Pill>
          <Pressable
            onPress={onRefresh}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Refresh backend health"
          >
            <Ionicons name="refresh-outline" size={16} color={colors.inkSubtle} />
          </Pressable>
        </View>
      </View>

      <View style={styles.healthChecks}>
        {featured.map(({ key, check }) => (
          <View key={key} style={styles.healthCheckRow}>
            <Ionicons
              name={check.ok ? "checkmark-circle" : "alert-circle"}
              size={14}
              color={check.ok ? colors.success : colors.dangerInk}
            />
            <AppText
              variant="small"
              color={check.ok ? "muted" : undefined}
              style={[
                styles.healthCheckLabel,
                !check.ok && { color: colors.dangerInk },
              ]}
              numberOfLines={1}
            >
              {prettyCheckName(key)}
            </AppText>
            <AppText
              variant="micro"
              color="subtle"
              style={{ fontVariant: ["tabular-nums"], letterSpacing: 0.3 }}
            >
              {check.ms ?? 0}ms
            </AppText>
          </View>
        ))}
      </View>
    </Card>
  );
}

type HealthCheckLike = { ok: boolean; ms: number; detail?: string };

function prettyCheckName(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function CountCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "danger" | "warning" | "neutral";
}) {
  const color =
    tone === "danger" ? colors.danger : tone === "warning" ? colors.warningInk : colors.inkMuted;
  return (
    <View style={[styles.countCard, value > 0 && tone === "danger" && styles.countCardDangerActive]}>
      <AppText
        variant="h2"
        style={{ color, fontVariant: ["tabular-nums"] }}
      >
        {value}
      </AppText>
      <AppText variant="micro" color="subtle" style={{ marginTop: 2, letterSpacing: 0.4 }}>
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surfaceSubtle,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topTitle: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  countsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  countCard: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  countCardDangerActive: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSubtle,
  },
  filterRow: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingRight: spacing.md,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  filterChipActive: {
    backgroundColor: colors.brandSubtle,
    borderColor: colors.brand,
  },
  eventRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  eventDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  eventIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceInset,
    alignItems: "center",
    justifyContent: "center",
  },
  eventTopLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  eventMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
  },
  detailBlock: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  detailMono: {
    color: colors.inkMuted,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
    fontSize: 11,
    lineHeight: 16,
  },
  footerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  },
  footerBtnPrimary: {
    backgroundColor: colors.brand,
  },
  footerBtnSecondary: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  /* ─── Backend health card (Phase 2G) ─────────────────────────── */
  healthCard: {
    borderRadius: radius["2xl"],
    ...shadows.ambient,
  },
  healthHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  healthChecks: {
    marginTop: spacing.md,
    gap: 8,
  },
  healthCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  healthCheckLabel: {
    flex: 1,
    minWidth: 0,
  },
  healthRefresh: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.brandSubtle,
    borderRadius: radius.md,
  },
});
