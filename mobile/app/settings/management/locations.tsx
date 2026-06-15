/**
 * /settings/management/locations — locations management list.
 *
 * Managerial surface (admin|manager) for the tenant's locations. Lists
 * every location with name, a type pill, address, and a staff-count chip.
 * Search filters locally on name/address. The FAB (create) and the row
 * affordances only appear for admin|manager — the backend enforces writes
 * too, so the gating here is UX-only.
 *
 * States: loading (Shimmer), empty (EmptyState), error+retry (ErrorState),
 * success → navigate into the new location's detail screen.
 *
 * Backed by GET /api/locations via useLocations. Tap a row →
 * /settings/management/locations/[id].
 */

import * as React from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import type { Location, LocationType } from "@/api/locations";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FAB } from "@/components/ui/FAB";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useLocations } from "@/hooks/useLocations";
import { useProfile } from "@/hooks/useProfile";
import { colors, layout, radius, spacing } from "@/theme";

const TYPE_META: Record<LocationType, { label: string; tone: PillTone; icon: React.ComponentProps<typeof Ionicons>["name"] }> = {
  physical: { label: "Physical", tone: "brand", icon: "business-outline" },
  virtual: { label: "Virtual", tone: "violet", icon: "videocam-outline" },
  hybrid: { label: "Hybrid", tone: "info", icon: "git-merge-outline" },
};

function typeMeta(t: LocationType | string) {
  return TYPE_META[(t as LocationType)] ?? TYPE_META.physical;
}

export default function LocationsListScreen() {
  const router = useRouter();
  const [search, setSearch] = React.useState("");

  const profileQ = useProfile();
  const role = profileQ.data?.role;
  const isManagerial = role === "admin" || role === "manager";

  const q = useLocations();
  const locations = q.data ?? [];

  // Local filter (the list endpoint has no ?q=). Match name + address.
  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = locations.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!term) return rows;
    return rows.filter(
      (l) =>
        l.name.toLowerCase().includes(term) ||
        (l.address ?? "").toLowerCase().includes(term),
    );
  }, [locations, search]);

  const onRefresh = React.useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    return q.refetch();
  }, [q]);

  return (
    <ScreenContainer
      padding={false}
      edges={["top"]}
      floatingOverlay={
        isManagerial ? (
          <FAB
            icon="add"
            accessibilityLabel="Add location"
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              router.push("/settings/management/locations/new");
            }}
          />
        ) : undefined
      }
    >
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
          Locations
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
            Manage the places your team delivers from — physical sites,
            virtual rooms, or a mix of both.
          </AppText>
        </SectionFade>

        {/* Search */}
        <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
          <Input
            placeholder="Search locations…"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon={<Ionicons name="search" size={16} color={colors.inkSubtle} />}
          />
        </SectionFade>

        {/* List */}
        <SectionFade delay={100} style={{ marginTop: spacing.lg }}>
          {q.isError ? (
            <Card style={{ borderRadius: radius["2xl"] }}>
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
          ) : filtered.length === 0 ? (
            <Card variant="outline" style={{ borderRadius: radius["2xl"] }}>
              <EmptyState
                icon={<Ionicons name="location-outline" size={26} color={colors.brand} />}
                title={search.trim() ? "No matches" : "No locations yet"}
                body={
                  search.trim()
                    ? "Try a different name or address."
                    : isManagerial
                      ? "Add your first location with the + button."
                      : "No locations have been set up yet."
                }
              />
            </Card>
          ) : (
            <View style={{ gap: 12 }}>
              {filtered.map((loc, i) => (
                <SectionFade key={loc.id} delay={100 + Math.min(i, 8) * 30}>
                  <LocationRow
                    location={loc}
                    onPress={() =>
                      router.push(`/settings/management/locations/${loc.id}`)
                    }
                  />
                </SectionFade>
              ))}
            </View>
          )}
        </SectionFade>

        <View style={{ height: spacing["4xl"] }} />
      </ScrollView>
    </ScreenContainer>
  );
}

function LocationRow({
  location,
  onPress,
}: {
  location: Location;
  onPress: () => void;
}) {
  const meta = typeMeta(location.locationType);
  const staff = location.staffCount ?? 0;
  return (
    <PressableCard onPress={onPress} style={styles.row}>
      <View style={[styles.rowIcon, { backgroundColor: colors.brandSubtle }]}>
        <Ionicons name={meta.icon} size={20} color={colors.brand} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rowTitleLine}>
          <AppText variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {location.name}
          </AppText>
          <Pill tone={meta.tone}>{meta.label.toUpperCase()}</Pill>
          {!location.isActive ? <Pill tone="neutral">INACTIVE</Pill> : null}
        </View>
        {location.address ? (
          <AppText
            variant="caption"
            color="muted"
            numberOfLines={1}
            style={{ marginTop: 2 }}
          >
            {location.address}
          </AppText>
        ) : (
          <AppText variant="caption" color="subtle" style={{ marginTop: 2 }}>
            No address on file
          </AppText>
        )}
        <View style={styles.rowMetaLine}>
          <Ionicons name="people-outline" size={12} color={colors.inkSubtle} />
          <AppText variant="micro" color="muted" style={{ marginLeft: 4 }}>
            {staff} staff
          </AppText>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.inkSubtle} />
    </PressableCard>
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
  topTitle: { flex: 1 },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  intro: {
    paddingHorizontal: spacing.xs,
    lineHeight: 18,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  rowMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
  },
});
