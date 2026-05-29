/**
 * Customers tab — Phase 2B lightweight mobile CRM.
 *
 * Layout:
 *   • Search input (debounced, drives /api/customers?q=)
 *   • Sticky "X customers · Y VIPs · Z prospects" summary strip
 *   • Sorted list of CustomerRows (most recently active first)
 *   • Skeleton during initial fetch, empty state for zero results
 *
 * Tap a row → /customers/[id] detail screen.
 *
 * No new deps. Search is local-state with a 300ms debounce so we don't
 * hit the API on every keystroke.
 */

import * as React from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import { Card, PressableCard } from "@/components/ui/Card";
import { CustomerRow } from "@/components/ui/CustomerRow";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useCustomers } from "@/hooks/useCustomers";
import { colors, radius, shadows, spacing } from "@/theme";

export default function CustomersScreen() {
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");

  // 300ms debounce — calm on the network, fast enough that user feels in control.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const q = useCustomers({ q: debouncedSearch || undefined });
  const customers = q.data ?? [];

  // Sort: most recently active first, then alpha by name.
  const sorted = React.useMemo(() => {
    return customers.slice().sort((a, b) => {
      const aT = a.lastAppointmentAt ? new Date(a.lastAppointmentAt).getTime() : 0;
      const bT = b.lastAppointmentAt ? new Date(b.lastAppointmentAt).getTime() : 0;
      if (aT !== bT) return bT - aT;
      // name may be null for partial records — sort those last so they
      // don't claim alpha-first positions.
      return (a.name ?? "￿").localeCompare(b.name ?? "￿");
    });
  }, [customers]);

  // Summary counts
  const counts = React.useMemo(() => {
    let vip = 0;
    let prospect = 0;
    for (const c of customers) {
      if (c.status === "vip") vip++;
      else if (c.status === "prospect") prospect++;
    }
    return { total: customers.length, vip, prospect };
  }, [customers]);

  const onRefresh = React.useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    return q.refetch();
  }, [q]);

  return (
    <ScreenContainer
      scrollable
      refreshControl={
        <RefreshControl
          refreshing={q.isFetching && !q.isLoading}
          onRefresh={onRefresh}
          tintColor={colors.brand}
        />
      }
    >
      {/* Compact non-Home tab header — title + bell + avatar.
          The "CRM" eyebrow + Total/VIP/Prospect summary strip below
          carry the operational context, so the header stays restrained.
          We pass ScreenContainer padding={false}-style margin negation
          here so the header spans full bleed like the other tabs do. */}
      <SectionFade style={{ marginHorizontal: -spacing.lg, marginTop: -spacing.lg }}>
        <PageHeader
          title="Customers"
          subtitle={counts.total > 0 ? `${counts.total} total` : undefined}
        />
      </SectionFade>

      {/* Summary strip */}
      <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
        <View style={styles.summaryStrip}>
          <SummaryChip label="Total" value={counts.total} />
          {counts.vip > 0 ? (
            <SummaryChip label="VIP" value={counts.vip} tone="violet" />
          ) : null}
          {counts.prospect > 0 ? (
            <SummaryChip label="Prospects" value={counts.prospect} tone="info" />
          ) : null}
        </View>
      </SectionFade>

      {/* Search */}
      <SectionFade delay={100} style={{ marginTop: spacing.lg }}>
        <Input
          placeholder="Search by name or email…"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.search}
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
            <Shimmer.Card height={88} />
            <Shimmer.Card height={88} />
            <Shimmer.Card height={88} />
            <Shimmer.Card height={88} />
            <Shimmer.Card height={88} />
          </View>
        ) : sorted.length === 0 ? (
          <Card variant="outline" style={{ borderRadius: radius["2xl"] }}>
            <EmptyState
              icon={<Ionicons name="people-outline" size={26} color={colors.brand} />}
              title={debouncedSearch ? "No matches" : "No customers yet"}
              body={
                debouncedSearch
                  ? "Try a different name or email."
                  : "Customers show up here automatically after their first booking."
              }
            />
          </Card>
        ) : (
          // Phase 2F: 12px between floating rows — the design brief's
          // "10–14px" sweet spot. Tight enough to feel grouped, loose
          // enough to read each row as its own surface.
          <View style={{ gap: 12 }}>
            {sorted.map((c, i) => (
              <SectionFade key={c.id} delay={140 + Math.min(i, 8) * 30}>
                <CustomerRow
                  customer={c}
                  onPress={() => router.push(`/customers/${c.id}`)}
                />
              </SectionFade>
            ))}
          </View>
        )}
      </SectionFade>

      <View style={{ height: spacing["3xl"] }} />
    </ScreenContainer>
  );
}

function SummaryChip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "violet" | "info";
}) {
  return (
    <View style={styles.summaryChip}>
      <Pill tone={tone}>{label.toUpperCase()}</Pill>
      <AppText
        variant="bodyStrong"
        style={{ marginTop: 4, fontVariant: ["tabular-nums"] }}
      >
        {value}
      </AppText>
    </View>
  );
}

// referenced to silence import warning
void PressableCard;

const styles = StyleSheet.create({
  summaryStrip: {
    flexDirection: "row",
    gap: spacing.md,
  },
  /** Phase 2F: summary chips now read as proper floating mini-cards
   *  — softer ambient shadow, larger radius, generous insets. */
  summaryChip: {
    flex: 1,
    backgroundColor: colors.surface,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: "flex-start",
    ...shadows.ambient,
  },
  search: {
    marginBottom: 0,
  },
});
