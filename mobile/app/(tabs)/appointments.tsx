/**
 * Appointments tab — chronological list with status filter strip.
 *
 * Mirrors the web /dashboard/appointments page's calm timeline shape:
 * a horizontal status segmented control, then date-grouped cards.
 */

import * as React from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import { AppointmentRow } from "@/components/ui/AppointmentRow";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { type PillTone } from "@/components/ui/Pill";
import { PageHeader } from "@/components/ui/PageHeader";
import { QuickCreateFAB } from "@/components/ui/QuickCreateFAB";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { Shimmer } from "@/components/ui/Shimmer";
import { StalenessHint } from "@/components/ui/StalenessHint";
import { AppText } from "@/components/ui/Text";
import { useAppointments } from "@/hooks/useAppointments";
import { formatDateLong } from "@/lib/format";
import { colors, layout, radius, spacing } from "@/theme";

import type { Appointment, BookingStatus } from "@/api/appointments";

type Filter = "all" | BookingStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "confirmed", label: "Confirmed" },
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "no_show", label: "No-show" },
];

// statusTone() lived here historically; AppointmentRow now encapsulates
// the status → tone mapping so every list surface paints identically.
// Keeping PillTone import for backwards-compatible filter chip work.
void (null as unknown as PillTone);

function groupByDay(rows: Appointment[]): { day: string; date: Date; items: Appointment[] }[] {
  const groups: Record<string, { date: Date; items: Appointment[] }> = {};
  for (const r of rows) {
    const key = r.startAt.slice(0, 10);
    if (!groups[key]) {
      groups[key] = { date: new Date(r.startAt), items: [] };
    }
    groups[key]!.items.push(r);
  }
  return Object.entries(groups)
    .map(([day, v]) => ({ day, date: v.date, items: v.items }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export default function AppointmentsScreen() {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const params = React.useMemo(
    () => (filter === "all" ? {} : { status: filter }),
    [filter],
  );
  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetching,
    error: apptsErr,
    dataUpdatedAt,
  } = useAppointments(params);
  const grouped = React.useMemo(() => groupByDay(data?.rows ?? []), [data]);
  const flatItems = React.useMemo(() => {
    type Item =
      | { kind: "header"; key: string; date: Date }
      | { kind: "row"; key: string; item: Appointment };
    const out: Item[] = [];
    for (const g of grouped) {
      out.push({ kind: "header", key: `h-${g.day}`, date: g.date });
      for (const it of g.items) out.push({ kind: "row", key: it.id, item: it });
    }
    return out;
  }, [grouped]);

  return (
    <ScreenContainer
      padding={false}
      // FAB anchored to the viewport (sibling of the FlatList, not a
      // child of it). See ScreenContainer.floatingOverlay docs.
      floatingOverlay={<QuickCreateFAB />}
    >
      {/* Compact non-Home tab header. Bookings list owns the operational
          density — keep this header restrained. The staleness hint slots
          in as the trailing element so operators still see "live / 12s
          ago" without losing screen real estate. */}
      <PageHeader
        title="Appointments"
        trailing={
          <StalenessHint
            dataUpdatedAt={dataUpdatedAt}
            isFetching={isFetching && !isLoading}
          />
        }
      />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        style={styles.filterScroll}
      >
        {FILTERS.map((f) => {
          const active = f.id === filter;
          return (
            <PressableCard
              key={f.id}
              variant="outline"
              padding={0}
              onPress={() => setFilter(f.id)}
              style={[
                styles.filterChip,
                active && { borderColor: colors.brand, backgroundColor: colors.brandSubtle },
              ]}
            >
              <AppText
                variant="smallStrong"
                style={{
                  color: active ? colors.brand : colors.inkMuted,
                  paddingHorizontal: spacing.md,
                }}
              >
                {f.label}
              </AppText>
            </PressableCard>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View style={[styles.content, { gap: spacing.sm }]}>
          <Shimmer.Card height={84} />
          <Shimmer.Card height={84} />
          <Shimmer.Card height={84} />
          <Shimmer.Card height={84} />
        </View>
      ) : isError ? (
        <View style={styles.content}>
          <Card>
            <ErrorState
              kind={data instanceof Error || (apptsErr as { kind?: "network" | "client" | "server" | "unknown" } | undefined)?.kind ? "server" : "unknown"}
              description={apptsErr instanceof Error ? apptsErr.message : undefined}
              onRetry={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                void refetch();
              }}
            />
          </Card>
        </View>
      ) : flatItems.length === 0 ? (
        <View style={styles.content}>
          <Card>
            <EmptyState
              icon={<Ionicons name="checkmark-done-circle-outline" size={26} color={colors.brand} />}
              title={filter === "all" ? "Calendar is open" : "Nothing matches"}
              body={
                filter === "all"
                  ? "Bookings show up here as customers schedule with you."
                  : "Try a different status filter."
              }
            />
          </Card>
        </View>
      ) : (
        <FlatList
          data={flatItems}
          keyExtractor={(it) => it.key}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          refreshControl={
            <RefreshControl
              refreshing={isFetching}
              onRefresh={() => {
                void Haptics.selectionAsync().catch(() => {});
                void refetch();
              }}
              tintColor={colors.brand}
            />
          }
          renderItem={({ item }) => {
            if (item.kind === "header") {
              return (
                <View style={styles.dayHeader}>
                  <AppText variant="smallStrong" color="muted">
                    {formatDateLong(item.date).toUpperCase()}
                  </AppText>
                </View>
              );
            }
            const a = item.item;
            return (
              <AppointmentRow
                appt={a}
                onPress={() => router.push(`/appointments/${a.id}`)}
              />
            );
          }}
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: layout.screenPaddingY,
    paddingBottom: spacing.md,
  },
  headerEyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  filterScroll: {
    maxHeight: 56,
  },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: layout.screenPaddingX,
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  filterChip: {
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
  },
  content: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
  },
  listContent: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.sm,
    paddingBottom: layout.screenPaddingY * 4,
  },
  dayHeader: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
});
