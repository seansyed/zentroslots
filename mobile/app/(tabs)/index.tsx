/**
 * Home / Dashboard tab — Phase 2A redesign.
 *
 * Layout (top → bottom):
 *   1. GradientHeroCard — greeting, workspace pill, avatar, today's pulse
 *   2. KPI grid — Today / This week / Pending / Revenue MTD
 *   3. Quick actions row — link / new booking / calendar / customers
 *   4. Up Next — next 3 upcoming bookings (AppointmentRow)
 *   5. Today's activity — derived timeline (ActivityRow)
 *   6. Empty / error states handled per-section
 *
 * Each section is wrapped in SectionFade with a staggered delay so the
 * dashboard "settles" on first render. Skeletons keep the page from
 * feeling janky during the initial fetch.
 *
 * Data sources:
 *   • useProfile()       → tenant + user
 *   • useAppointments()  → bookings (filtered/grouped for KPIs)
 *
 * No new backend endpoints; the KPIs are computed locally from the
 * booking list. When the analytics endpoint lands later, swap the
 * computeKpis() in for a server call.
 */

import * as React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import { ActivityRow } from "@/components/ui/ActivityRow";
import { AppointmentRow } from "@/components/ui/AppointmentRow";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Logo } from "@/components/ui/Logo";
import { ErrorState } from "@/components/ui/ErrorState";
import { GradientHeroCard } from "@/components/ui/GradientHeroCard";
import { KpiCard } from "@/components/ui/KpiCard";
import { NotificationBellButton } from "@/components/ui/NotificationBellButton";
import { Pill } from "@/components/ui/Pill";
import { PresencePill } from "@/components/ui/PresencePill";
import { QuickCreateFAB } from "@/components/ui/QuickCreateFAB";
import { RefreshIndicator } from "@/components/ui/RefreshIndicator";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useAppointments, useUpcomingAppointments } from "@/hooks/useAppointments";
import { apptTime } from "@/lib/appointmentTime";
import { useProfile } from "@/hooks/useProfile";
import { usePresenceStore } from "@/store/presenceStore";
import { colors, radius, spacing, typography } from "@/theme";

import type { Appointment } from "@/api/appointments";

// ─── Helpers ──────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isSameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function startOfWeek(d: Date): Date {
  const n = startOfDay(d);
  n.setDate(n.getDate() - n.getDay());
  return n;
}
function startOfMonth(d: Date): Date {
  const n = startOfDay(d);
  n.setDate(1);
  return n;
}

function relativeTime(iso: string, now: Date): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  const ago = diffMs < 0;
  if (absMin < 1) return ago ? "just now" : "in <1m";
  if (absMin < 60) return ago ? `${absMin}m ago` : `in ${absMin}m`;
  const absH = Math.round(absMin / 60);
  if (absH < 24) return ago ? `${absH}h ago` : `in ${absH}h`;
  const absD = Math.round(absH / 24);
  if (absD === 1) return ago ? "yesterday" : "tomorrow";
  return ago ? `${absD}d ago` : `in ${absD}d`;
}

function greetingFor(hour: number): string {
  if (hour < 5) return "Late night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// ─── KPI computation ──────────────────────────────────────────────

type Kpis = {
  todayCount: number;
  todayDelta: number;
  weekCount: number;
  weekSpark: number[];
  pendingCount: number;
  pendingDelta: number;
  revenueCents: number;
};

function computeKpis(rows: Appointment[], now: Date): Kpis {
  const today = startOfDay(now);
  const yesterday = addDays(today, -1);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  let todayCount = 0;
  let yesterdayCount = 0;
  let weekCount = 0;
  let pendingCount = 0;
  let revenueCents = 0;

  const weekDayCounts = new Array(7).fill(0);

  for (const r of rows) {
    const start = new Date(r.startAt);
    if (isSameDate(start, today)) todayCount++;
    if (isSameDate(start, yesterday)) yesterdayCount++;
    if (start >= weekStart && start < addDays(weekStart, 7)) {
      weekCount++;
      const idx = Math.min(6, Math.max(0, Math.floor((start.getTime() - weekStart.getTime()) / 86_400_000)));
      weekDayCounts[idx]++;
    }
    if (r.status === "pending") pendingCount++;
    if (r.status === "completed" && r.amountCents && start >= monthStart) {
      revenueCents += r.amountCents;
    }
  }

  return {
    todayCount,
    todayDelta: todayCount - yesterdayCount,
    weekCount,
    weekSpark: weekDayCounts,
    pendingCount,
    pendingDelta: 0, // no historical baseline available locally
    revenueCents,
  };
}

// ─── Recent activity derivation ───────────────────────────────────

type ActivityItem = {
  id: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  tone: "brand" | "success" | "warning" | "danger" | "neutral";
  title: string;
  subtitle: string;
  timestamp: string;
  rawDate: Date;
};

function buildActivity(rows: Appointment[], now: Date): ActivityItem[] {
  // Use the 8 most-recently-updated bookings as a proxy activity feed.
  // When the real notifications endpoint ships we swap this for that.
  const items: ActivityItem[] = rows
    .slice()
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
    .slice(0, 8)
    .map((r) => {
      const start = new Date(r.startAt);
      const tone: ActivityItem["tone"] =
        r.status === "confirmed" ? "success" :
        r.status === "pending" ? "warning" :
        r.status === "cancelled" || r.status === "no_show" ? "danger" :
        r.status === "completed" ? "neutral" : "brand";
      const icon: ActivityItem["icon"] =
        r.status === "confirmed" ? "checkmark-circle" :
        r.status === "pending" ? "time" :
        r.status === "cancelled" ? "close-circle" :
        r.status === "no_show" ? "alert-circle" :
        r.status === "completed" ? "checkmark-done" : "calendar";
      const title =
        r.status === "confirmed" ? `Booking confirmed · ${r.clientName}` :
        r.status === "pending" ? `Pending booking · ${r.clientName}` :
        r.status === "cancelled" ? `Cancelled · ${r.clientName}` :
        r.status === "no_show" ? `No-show · ${r.clientName}` :
        r.status === "completed" ? `Completed · ${r.clientName}` :
        `${r.clientName} · ${r.status}`;
      return {
        id: r.id,
        icon,
        tone,
        title,
        subtitle: `${r.serviceName}${r.staffName ? ` · with ${r.staffName}` : ""}`,
        timestamp: relativeTime(r.startAt, now),
        rawDate: start,
      };
    });
  return items;
}

// ─── Today's team derivation ──────────────────────────────────────

type TodaysTeamMember = {
  staffKey: string;        // staffId when available, otherwise name-based
  staffName: string;
  totalCount: number;      // bookings today
  remainingCount: number;  // not yet started
  nextStartAt: string | null;
  nextStartLabel: string | null; // server viewer-tz label for nextStartAt
  hasPending: boolean;
};

function buildTodaysTeam(rows: Appointment[], now: Date): TodaysTeamMember[] {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const grouped = new Map<string, TodaysTeamMember>();

  for (const r of rows) {
    const start = new Date(r.startAt);
    if (start < today || start >= tomorrow) continue;
    if (r.status === "cancelled" || r.status === "no_show") continue;
    const name = r.staffName || "Unassigned";
    const key = (r.staffId ?? "") + "::" + name;
    const existing = grouped.get(key);
    const isUpcoming = start >= now;
    if (!existing) {
      grouped.set(key, {
        staffKey: key,
        staffName: name,
        totalCount: 1,
        remainingCount: isUpcoming ? 1 : 0,
        nextStartAt: isUpcoming ? r.startAt : null,
        nextStartLabel: isUpcoming ? (r.startLabel ?? null) : null,
        hasPending: r.status === "pending",
      });
    } else {
      existing.totalCount += 1;
      if (isUpcoming) {
        existing.remainingCount += 1;
        if (
          existing.nextStartAt === null ||
          new Date(r.startAt) < new Date(existing.nextStartAt)
        ) {
          existing.nextStartAt = r.startAt;
          existing.nextStartLabel = r.startLabel ?? null;
        }
      }
      if (r.status === "pending") existing.hasPending = true;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    // Members with more remaining work float to the top, then by next time.
    if (b.remainingCount !== a.remainingCount) return b.remainingCount - a.remainingCount;
    const an = a.nextStartAt ? new Date(a.nextStartAt).getTime() : Infinity;
    const bn = b.nextStartAt ? new Date(b.nextStartAt).getTime() : Infinity;
    return an - bn;
  });
}

// (formatTimeShort removed — appointment times come from @/lib/appointmentTime
//  server viewer-tz labels, never device-local getHours.)

// ─── Screen ───────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const profile = profileQ.data;
  const presence = usePresenceStore((s) => s.current());

  const now = React.useMemo(() => new Date(), []);
  const monthStart = React.useMemo(() => startOfMonth(now), [now]);
  const monthEnd = React.useMemo(() => addDays(monthStart, 32), [monthStart]);

  // Pull a wider window so KPIs + activity have material to chew on.
  const apptsQ = useAppointments({
    from: addDays(startOfDay(now), -30).toISOString(),
    to: monthEnd.toISOString(),
    limit: 200,
  });
  const appts = apptsQ.data;
  const apptsLoading = apptsQ.isLoading;

  const kpis = React.useMemo<Kpis | null>(() => {
    if (!appts?.rows) return null;
    return computeKpis(appts.rows, now);
  }, [appts, now]);

  // "Up next" is sourced from a dedicated status-filtered query (NOT the KPI
  // window), so cancelled/completed rows can't crowd out near-term bookings and
  // a booking weeks out still shows. See useUpcomingAppointments.
  const upcomingQ = useUpcomingAppointments(3);
  const upcoming = upcomingQ.upcoming;

  // The Home tab stays mounted across tab switches, so refetchOnMount won't fire
  // on re-focus. Refetch upcoming whenever Home regains focus so a booking made
  // from another screen (or elapsed time) is reflected. (`refetch` is stable.)
  const refetchUpcoming = upcomingQ.refetch;
  useFocusEffect(
    React.useCallback(() => {
      void refetchUpcoming();
    }, [refetchUpcoming]),
  );

  const activity = React.useMemo<ActivityItem[]>(() => {
    if (!appts?.rows) return [];
    return buildActivity(appts.rows, now);
  }, [appts, now]);

  // Today's team — derived staff list with workload + next time. Powered by
  // the same booking window we already fetched, so this is free.
  const todaysTeam = React.useMemo<TodaysTeamMember[]>(() => {
    if (!appts?.rows) return [];
    return buildTodaysTeam(appts.rows, now);
  }, [appts, now]);

  const greeting = greetingFor(now.getHours());
  const firstName = profile?.name?.split(" ")[0] ?? "there";

  const onRefresh = React.useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    return Promise.all([profileQ.refetch(), apptsQ.refetch(), upcomingQ.refetch()]);
  }, [profileQ, apptsQ, upcomingQ]);

  const refresh = (
    <RefreshControl
      refreshing={apptsQ.isFetching || profileQ.isFetching || upcomingQ.isFetching}
      onRefresh={onRefresh}
      tintColor={colors.brand}
    />
  );

  return (
    <ScreenContainer
      scrollable
      refreshControl={refresh}
      // Render the FAB as a viewport-anchored overlay (NOT a scroll child),
      // so it stays pinned to the bottom-right above the tab bar regardless
      // of scroll position. See ScreenContainer.floatingOverlay docs.
      floatingOverlay={<QuickCreateFAB />}
    >
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <SectionFade delay={0}>
        <GradientHeroCard>
          <View style={styles.heroTopRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={styles.eyebrowRow}>
                {/* Official ZentroMeet platform badge (not tenant logo). */}
                <Logo size={26} />
                <AppText variant="eyebrow" color="brand">
                  {greeting}
                </AppText>
                <PresencePill
                  state={presence}
                  size="sm"
                  onPress={() => router.push("/(tabs)/settings")}
                />
                <RefreshIndicator
                  active={apptsQ.isFetching && !apptsQ.isLoading}
                />
              </View>
              <AppText
                variant="displayMd"
                style={{ marginTop: 4, color: colors.ink }}
                numberOfLines={1}
              >
                {firstName}
              </AppText>
              {profile?.tenant?.name ? (
                <View style={{ marginTop: spacing.sm, flexDirection: "row" }}>
                  <Pill tone="brand">{profile.tenant.name}</Pill>
                </View>
              ) : null}
            </View>
            <View style={styles.heroRightCol}>
              {/* Same bell + badge component the other tabs use, so the
                  unread counter renders identically here. Previously this
                  spot used the plain IconButton which had no badge logic
                  at all — that's why Home showed no count even when the
                  other tabs did. */}
              <NotificationBellButton />
              <Avatar
                name={profile?.name ?? firstName}
                uri={profile?.avatarUrl}
                size={52}
              />
            </View>
          </View>

          {/* Today pulse */}
          <View style={styles.heroPulse}>
            <View style={styles.heroPulseDot} />
            <AppText variant="small" style={{ color: colors.ink, flex: 1 }}>
              {kpis === null
                ? "Loading today's plan…"
                : kpis.todayCount === 0
                  ? "Your day is open — share your booking page to fill it."
                  : `${kpis.todayCount} booking${kpis.todayCount === 1 ? "" : "s"} today`}
            </AppText>
            {kpis && kpis.pendingCount > 0 ? (
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => {});
                  router.push("/(tabs)/appointments");
                }}
                accessibilityRole="button"
                accessibilityLabel={`${kpis.pendingCount} pending bookings — tap to review`}
                hitSlop={6}
              >
                <Pill tone="warning">{kpis.pendingCount} pending</Pill>
              </Pressable>
            ) : null}
          </View>
        </GradientHeroCard>
      </SectionFade>

      {/* ── KPI grid ─────────────────────────────────────────────── */}
      <SectionFade delay={80} style={{ marginTop: spacing.lg }}>
        {apptsLoading && !kpis ? (
          <View style={styles.kpiGrid}>
            <Shimmer.Card height={108} />
            <Shimmer.Card height={108} />
            <Shimmer.Card height={108} />
            <Shimmer.Card height={108} />
          </View>
        ) : kpis ? (
          <View style={styles.kpiGrid}>
            <View style={styles.kpiSlot}>
              <KpiCard
                label="Today"
                value={kpis.todayCount}
                unit={kpis.todayCount === 1 ? "booking" : "bookings"}
                icon="calendar"
                tone="brand"
                delta={kpis.todayDelta}
                deltaLabel="vs yesterday"
              />
            </View>
            <View style={styles.kpiSlot}>
              <KpiCard
                label="This week"
                value={kpis.weekCount}
                unit={kpis.weekCount === 1 ? "booking" : "bookings"}
                icon="bar-chart"
                tone="violet"
                sparkline={kpis.weekSpark}
              />
            </View>
            <View style={styles.kpiSlot}>
              <KpiCard
                label="Pending"
                value={kpis.pendingCount}
                unit={kpis.pendingCount === 1 ? "to confirm" : "to confirm"}
                icon="hourglass"
                tone={kpis.pendingCount > 0 ? "warning" : "neutral"}
              />
            </View>
            <View style={styles.kpiSlot}>
              <KpiCard
                label="Revenue MTD"
                value={`$${Math.round(kpis.revenueCents / 100).toLocaleString()}`}
                icon="trending-up"
                tone="success"
              />
            </View>
          </View>
        ) : null}
      </SectionFade>

      {/* ── Today's team ────────────────────────────────────────── */}
      {todaysTeam.length > 0 ? (
        <SectionFade delay={120} style={{ marginTop: spacing.lg }}>
          <View style={styles.teamHeader}>
            <AppText variant="eyebrow" color="brand">
              Today's team
            </AppText>
            <AppText variant="micro" color="muted">
              {todaysTeam.length}{" "}
              {todaysTeam.length === 1 ? "operator" : "operators"} on the floor
            </AppText>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.teamRow}
          >
            {todaysTeam.map((m) => (
              <TeamMemberChip
                key={m.staffKey}
                member={m}
                onPress={() => router.push("/(tabs)/appointments")}
              />
            ))}
          </ScrollView>
        </SectionFade>
      ) : null}

      {/* ── Quick actions ───────────────────────────────────────── */}
      <SectionFade delay={160} style={{ marginTop: spacing.lg }}>
        <View style={styles.quickRow}>
          <QuickAction
            label="Calendar"
            icon="calendar-outline"
            tone="brand"
            onPress={() => router.push("/(tabs)/calendar")}
          />
          <QuickAction
            label="Appointments"
            icon="list-outline"
            tone="violet"
            onPress={() => router.push("/(tabs)/appointments")}
          />
          <QuickAction
            label="Customers"
            icon="people-outline"
            tone="success"
            onPress={() => router.push("/(tabs)/customers")}
          />
          <QuickAction
            label="Share"
            icon="share-outline"
            tone="warning"
            onPress={() => router.push("/share")}
          />
        </View>
      </SectionFade>

      {/* ── Up Next ──────────────────────────────────────────────── */}
      <SectionFade delay={200} style={{ marginTop: spacing.xl }}>
        <View style={styles.upNextHeader}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <SectionHeader
              eyebrow="Up next"
              title={upcoming.length === 0 ? "No upcoming bookings" : "Coming up"}
              description={
                upcoming.length === 0
                  ? "Confirmed bookings will appear here in real time."
                  : "Tap to see full details."
              }
            />
          </View>
          {upcoming.length > 0 ? (
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync().catch(() => {});
                router.push("/(tabs)/appointments");
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="View all appointments"
              style={styles.viewAllBtn}
            >
              <AppText variant="smallStrong" style={{ color: colors.brand }}>View all</AppText>
              <Ionicons name="chevron-forward" size={14} color={colors.brand} />
            </Pressable>
          ) : null}
        </View>
        {upcomingQ.isError ? (
          <Card>
            <ErrorState
              kind={upcomingQ.error instanceof ApiError ? upcomingQ.error.kind : "unknown"}
              description={upcomingQ.error instanceof Error ? upcomingQ.error.message : undefined}
              onRetry={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                void upcomingQ.refetch();
              }}
            />
          </Card>
        ) : upcomingQ.isLoading && upcoming.length === 0 ? (
          <View style={{ gap: spacing.sm }}>
            <Shimmer.Card height={84} />
            <Shimmer.Card height={84} />
            <Shimmer.Card height={84} />
          </View>
        ) : upcoming.length === 0 ? (
          <Card variant="outline">
            <EmptyState
              icon={<Ionicons name="sparkles-outline" size={26} color={colors.brand} />}
              title="No upcoming bookings"
              body="Create a booking or share your booking page to start filling your calendar."
            />
            <View style={styles.emptyActions}>
              <Button
                label="New booking"
                variant="primary"
                size="md"
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => {});
                  router.push("/quick-create");
                }}
                leftIcon={<Ionicons name="add" size={16} color={colors.inkOnBrand} />}
                style={{ flex: 1 }}
              />
              <Button
                label="Share link"
                variant="secondary"
                size="md"
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => {});
                  router.push("/share");
                }}
                leftIcon={<Ionicons name="share-outline" size={16} color={colors.ink} />}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {upcoming.map((row, i) => (
              <SectionFade key={row.id} delay={220 + i * 50}>
                <AppointmentRow
                  appt={row}
                  showDateInTime={!isSameDate(new Date(row.startAt), now)}
                  onPress={() => router.push(`/appointments/${row.id}`)}
                />
              </SectionFade>
            ))}
          </View>
        )}
      </SectionFade>

      {/* ── Activity ─────────────────────────────────────────────── */}
      {activity.length > 0 ? (
        <SectionFade delay={300} style={{ marginTop: spacing.xl }}>
          <SectionHeader
            eyebrow="Activity"
            title="Recent booking events"
            description="A quick pulse of what's been moving."
          />
          <Card>
            <View style={{ gap: 0 }}>
              {activity.slice(0, 5).map((a, i, arr) => (
                <ActivityRow
                  key={a.id}
                  icon={a.icon}
                  tone={a.tone}
                  title={a.title}
                  subtitle={a.subtitle}
                  timestamp={a.timestamp}
                  lineAbove={i > 0}
                  lineBelow={i < arr.length - 1}
                />
              ))}
            </View>
          </Card>
        </SectionFade>
      ) : null}

      {/* Small tail — ScreenContainer now reserves FAB clearance centrally. */}
      <View style={{ height: spacing.md }} />
    </ScreenContainer>
  );
}

// ─── TeamMemberChip ───────────────────────────────────────────────

const TeamMemberChip = React.memo(function TeamMemberChip({
  member,
  onPress,
}: {
  member: TodaysTeamMember;
  onPress: () => void;
}) {
  const initials = React.useMemo(() => {
    const parts = member.staffName.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "?";
    const last = parts.length > 1 ? parts[parts.length - 1]![0] : "";
    return (first + (last ?? "")).toUpperCase();
  }, [member.staffName]);

  // A small "live" dot at the top-right of the avatar — brand-tinted when
  // they still have upcoming bookings, neutral when their day is done.
  const isActive = member.remainingCount > 0;
  const ringColor = member.hasPending ? colors.warning : colors.brand;

  return (
    <PressableCard
      variant="plain"
      padding={0}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={styles.teamChip}
      accessibilityRole="button"
      accessibilityLabel={`${member.staffName}, ${member.totalCount} bookings today, ${member.remainingCount} remaining`}
    >
      <View
        style={[
          styles.teamAvatar,
          { borderColor: isActive ? ringColor : colors.borderSubtle },
        ]}
      >
        <AppText
          variant="bodyStrong"
          style={{ color: isActive ? ringColor : colors.inkMuted }}
        >
          {initials}
        </AppText>
        {isActive ? (
          <View
            style={[
              styles.teamLiveDot,
              { backgroundColor: ringColor },
            ]}
          />
        ) : null}
      </View>
      <AppText
        variant="smallStrong"
        numberOfLines={1}
        style={{ marginTop: spacing.xs, color: colors.ink }}
      >
        {member.staffName}
      </AppText>
      <AppText
        variant="micro"
        color="muted"
        numberOfLines={1}
        style={{ marginTop: 2, fontVariant: ["tabular-nums"] }}
      >
        {member.remainingCount === 0
          ? `Done · ${member.totalCount} today`
          : member.nextStartAt
            ? `Next ${apptTime({ startAt: member.nextStartAt, startLabel: member.nextStartLabel })} · ${member.remainingCount} left`
            : `${member.remainingCount} upcoming`}
      </AppText>
    </PressableCard>
  );
});

// ─── QuickAction ──────────────────────────────────────────────────

const QUICK_TONE_MAP = {
  brand: { bg: colors.brandSubtle, fg: colors.brand },
  violet: { bg: colors.violetSubtle, fg: colors.violet },
  success: { bg: colors.successSubtle, fg: colors.successInk },
  warning: { bg: colors.warningSubtle, fg: colors.warningInk },
} as const;

function QuickAction({
  label,
  icon,
  tone,
  onPress,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  tone: keyof typeof QUICK_TONE_MAP;
  onPress: () => void;
}) {
  const t = QUICK_TONE_MAP[tone];
  return (
    <PressableCard
      variant="plain"
      padding={spacing.md}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={styles.quickAction}
    >
      <View style={[styles.quickIcon, { backgroundColor: t.bg }]}>
        <Ionicons name={icon} size={20} color={t.fg} />
      </View>
      {/* Allow 2 lines so longer labels like "Appointments" wrap instead of
          truncating to "Appointme…" on narrow screens. */}
      <AppText variant="micro" style={styles.quickLabel} numberOfLines={2}>
        {label}
      </AppText>
    </PressableCard>
  );
}

// ─── Styles ───────────────────────────────────────────────────────

const styles = StyleSheet.create({
  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  heroRightCol: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  heroPulse: {
    marginTop: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: "rgba(255,255,255,0.7)",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  heroPulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.brand,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  kpiSlot: {
    flexBasis: "48%",
    flexGrow: 1,
    minWidth: 140,
  },
  quickRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  upNextHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  viewAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingTop: 2,
  },
  emptyActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  quickAction: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  quickIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  quickLabel: {
    marginTop: spacing.sm,
    textAlign: "center",
    letterSpacing: 0.3,
    color: colors.inkMuted,
    fontWeight: "600",
  } as const,
  // Today's team ───────────────────────────────────────────────
  teamHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  teamRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  teamChip: {
    width: 116,
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  teamAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceInset,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    position: "relative",
  },
  teamLiveDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.surface,
  },
});

// referenced to avoid TS unused warning when typography import only
// drives style spreads.
void typography;
