/**
 * /settings/management/services — Services management workspace.
 *
 * Lists every service in the tenant (active + inactive via the existing
 * servicesApi.list() which calls GET /api/services?include=all), with:
 *   • Search (name / description, debounced, client-side)
 *   • Active / Paused segmented filter
 *   • Per-service status pill + a one-tap activate/deactivate toggle
 *     (PATCH isActive) — managerial only
 *   • FAB → create a new service (managerial only)
 *   • loading / empty / error+retry states
 *
 * Tap a row → /settings/management/services/[id] (detail + edit).
 *
 * RBAC: writes (toggle, create) require role admin|manager. The backend
 * enforces this too — our gating is UX-only. Non-managerial users get a
 * read-only list.
 *
 * Bookability rule surfaced here: a service with zero assigned staff is
 * silently un-bookable on every public surface. The backend auto-links
 * the creator on create so freshly-made services are bookable; if a
 * PATCH activation is ever rejected we surface the server's message
 * verbatim (Alert) rather than guessing the reason.
 */

import * as React from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import type { Service } from "@/api/services";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FAB } from "@/components/ui/FAB";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useProfile } from "@/hooks/useProfile";
import { useServices, useUpdateService } from "@/hooks/useServices";
import { formatCurrencyCents } from "@/lib/format";
import { colors, layout, radius, shadows, spacing } from "@/theme";

type Filter = "active" | "paused";

function isActiveTrue(s: Service): boolean {
  return s.isActive === 1 || s.isActive === true;
}

function formatDuration(minutes: number): string {
  if (!minutes || minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function ServicesManagementScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const role = profileQ.data?.role;
  const isManagerial = role === "admin" || role === "manager";

  const q = useServices();
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("active");

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const all = q.data?.all ?? [];
  const activeCount = q.data?.active.length ?? 0;
  const pausedCount = all.length - activeCount;

  const visible = React.useMemo(() => {
    let list = all.filter((s) =>
      filter === "active" ? isActiveTrue(s) : !isActiveTrue(s),
    );
    if (debounced) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(debounced) ||
          (s.description ?? "").toLowerCase().includes(debounced),
      );
    }
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [all, filter, debounced]);

  const onRefresh = React.useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    return q.refetch();
  }, [q]);

  return (
    <View style={styles.root}>
      <ScreenContainer padding={false} edges={["top"]}>
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
            Services
          </AppText>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={q.isFetching && !q.isLoading}
              onRefresh={onRefresh}
              tintColor={colors.brand}
            />
          }
        >
          <SectionFade>
            <AppText variant="caption" color="muted" style={styles.intro}>
              The services your customers can book. Pause one to hide it from
              your booking page without deleting its history.
            </AppText>
          </SectionFade>

          {/* Filter */}
          <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
            <SegmentedTabs<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: "active", label: `Active${activeCount ? ` (${activeCount})` : ""}` },
                { value: "paused", label: `Paused${pausedCount ? ` (${pausedCount})` : ""}` },
              ]}
            />
          </SectionFade>

          {/* Search */}
          <SectionFade delay={100} style={{ marginTop: spacing.md }}>
            <Input
              placeholder="Search services…"
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              autoCorrect={false}
              leftIcon={<Ionicons name="search" size={16} color={colors.inkSubtle} />}
            />
          </SectionFade>

          {/* List */}
          <SectionFade delay={140} style={{ marginTop: spacing.lg }}>
            {q.isError ? (
              <Card>
                <ErrorState
                  kind={q.error instanceof ApiError ? q.error.kind : "unknown"}
                  description={q.error instanceof Error ? q.error.message : undefined}
                  onRetry={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                    void q.refetch();
                  }}
                />
              </Card>
            ) : q.isLoading ? (
              <View style={{ gap: spacing.md }}>
                <Shimmer.Card height={92} />
                <Shimmer.Card height={92} />
                <Shimmer.Card height={92} />
                <Shimmer.Card height={92} />
              </View>
            ) : visible.length === 0 ? (
              <Card variant="outline" style={{ borderRadius: radius["2xl"] }}>
                <EmptyState
                  icon={<Ionicons name="cube-outline" size={26} color={colors.brand} />}
                  title={
                    debounced
                      ? "No matches"
                      : filter === "active"
                        ? "No active services"
                        : "No paused services"
                  }
                  body={
                    debounced
                      ? "Try a different name."
                      : filter === "active"
                        ? isManagerial
                          ? "Create your first bookable service with the + button."
                          : "No services are currently bookable."
                        : "Paused services will appear here."
                  }
                />
              </Card>
            ) : (
              <View style={{ gap: 12 }}>
                {visible.map((s, i) => (
                  <SectionFade key={s.id} delay={140 + Math.min(i, 8) * 30}>
                    <ServiceRow
                      service={s}
                      canManage={isManagerial}
                      onPress={() => router.push(`/settings/management/services/${s.id}`)}
                    />
                  </SectionFade>
                ))}
              </View>
            )}
          </SectionFade>

          <View style={{ height: spacing["3xl"] }} />
        </ScrollView>
      </ScreenContainer>

      {isManagerial ? (
        <FAB
          icon="add"
          accessibilityLabel="New service"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            router.push("/settings/management/services/new");
          }}
        />
      ) : null}
    </View>
  );
}

function ServiceRow({
  service,
  canManage,
  onPress,
}: {
  service: Service;
  canManage: boolean;
  onPress: () => void;
}) {
  const active = isActiveTrue(service);
  const toggleMut = useUpdateService(service.id);
  const accent =
    service.color && /^#[0-9a-fA-F]{6}$/.test(service.color)
      ? service.color
      : colors.brand;

  function onToggle() {
    if (toggleMut.isPending) return;
    void Haptics.selectionAsync().catch(() => {});
    const next = active ? 0 : 1;
    toggleMut.mutate(
      { isActive: next },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success,
          ).catch(() => {});
        },
        onError: (e) => {
          void Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error,
          ).catch(() => {});
          // Surface the backend message verbatim — covers plan-cap limits
          // and any future "needs staff to activate" gate.
          Alert.alert(
            active ? "Couldn't pause" : "Couldn't activate",
            e instanceof Error ? e.message : "Please try again.",
          );
        },
      },
    );
  }

  return (
    <PressableCard onPress={onPress} style={styles.row} accessibilityRole="button">
      <View style={styles.rowMain}>
        <View style={[styles.accentDot, { backgroundColor: accent }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.rowTitleLine}>
            <AppText variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
              {service.name}
            </AppText>
            <Pill tone={active ? "success" : "neutral"}>
              {active ? "Active" : "Paused"}
            </Pill>
          </View>
          <AppText variant="caption" color="muted" numberOfLines={1} style={{ marginTop: 2 }}>
            {formatDuration(service.durationMinutes)} ·{" "}
            {service.price === 0 ? "Free" : formatCurrencyCents(service.price)}
            {typeof service.bookingsLast30d === "number" && service.bookingsLast30d > 0
              ? ` · ${service.bookingsLast30d} booked (30d)`
              : ""}
          </AppText>
        </View>
      </View>

      {canManage ? (
        <View style={styles.rowActions}>
          <View
            style={[
              styles.toggleBtn,
              active ? styles.togglePause : styles.toggleActivate,
              toggleMut.isPending && styles.toggleBusy,
            ]}
          >
            <AppText
              variant="smallStrong"
              style={{ color: active ? colors.inkMuted : colors.inkOnBrand }}
              onPress={onToggle}
              accessibilityRole="button"
              accessibilityLabel={
                active ? `Pause ${service.name}` : `Activate ${service.name}`
              }
            >
              {toggleMut.isPending ? "…" : active ? "Pause" : "Activate"}
            </AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.inkSubtle} />
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={18} color={colors.inkSubtle} />
      )}
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
  topTitle: { flex: 1 },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  intro: { paddingHorizontal: spacing.xs, lineHeight: 18 },
  row: {
    borderRadius: radius["2xl"],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    ...shadows.ambient,
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flex: 1,
    minWidth: 0,
  },
  accentDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  toggleBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
  },
  toggleActivate: { backgroundColor: colors.brand },
  togglePause: { backgroundColor: colors.surfaceInset },
  toggleBusy: { opacity: 0.6 },
});
