/**
 * /notifications — premium in-app inbox.
 *
 * Sources:
 *   • notificationsApi.list()   — primary feed (stubbed empty today)
 *   • useAppointments() recent  — fallback "activity" mode so the
 *                                 inbox feels alive even when the
 *                                 backend notification endpoint is
 *                                 still stubbed.
 *
 * Grouped sections: Today / Yesterday / Earlier. Each entry is an
 * ActivityRow with a tap → relevant deep link (booking detail).
 *
 * Pull-to-refresh + skeleton + premium empty state.
 *
 * Why we derive from bookings when the API is empty: the spec asks
 * for a notification center now. Once the backend ships GET
 * /api/tenant/notifications, this screen will already paint correctly
 * with the real feed (the shape is identical).
 */

import * as React from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ActivityRow } from "@/components/ui/ActivityRow";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useAppointments } from "@/hooks/useAppointments";
import { useConfirmBooking } from "@/hooks/useBookingActions";
import { useNotifications } from "@/hooks/useNotifications";
import { colors, layout, radius, spacing } from "@/theme";

import type { Appointment } from "@/api/appointments";
import type { NotificationRow } from "@/api/notifications";

// ─── Shared item shape ────────────────────────────────────────────

type InboxItem = {
  id: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  tone: "brand" | "success" | "warning" | "danger" | "neutral" | "violet";
  title: string;
  subtitle?: string;
  rawDate: Date;
  unread: boolean;
  deepLink?: string;
  /** When the row is sourced from a booking, expose the linked booking
   *  id + status so the row can render quick actions (e.g. Confirm). */
  bookingId?: string;
  bookingStatus?: Appointment["status"];
};

function relativeTime(date: Date, now: Date): string {
  const ms = now.getTime() - date.getTime();
  const ago = ms >= 0;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  if (min < 1) return ago ? "just now" : "in <1m";
  if (min < 60) return ago ? `${min}m ago` : `in ${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return ago ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return ago ? "yesterday" : "tomorrow";
  return ago ? `${d}d ago` : `in ${d}d`;
}

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

// ─── Adapters ─────────────────────────────────────────────────────

function fromNotification(n: NotificationRow): InboxItem {
  const sev = n.severity ?? "info";
  const tone: InboxItem["tone"] =
    sev === "critical" ? "danger" :
    sev === "warning" ? "warning" : "brand";
  const icon: InboxItem["icon"] =
    n.category === "booking" ? "calendar" :
    n.category === "billing" ? "card" :
    n.category === "automation" ? "flash" :
    n.category === "system" ? "construct" : "notifications";
  return {
    id: n.id,
    icon,
    tone,
    title: n.title,
    subtitle: n.body,
    rawDate: new Date(n.createdAt),
    unread: !n.readAt,
    deepLink: n.actionUrl ?? undefined,
  };
}

function fromBooking(b: Appointment): InboxItem {
  const start = new Date(b.startAt);
  const tone: InboxItem["tone"] =
    b.status === "confirmed" ? "success" :
    b.status === "pending" ? "warning" :
    b.status === "cancelled" || b.status === "no_show" ? "danger" :
    b.status === "completed" ? "neutral" : "brand";
  const icon: InboxItem["icon"] =
    b.status === "confirmed" ? "checkmark-circle" :
    b.status === "pending" ? "time" :
    b.status === "cancelled" ? "close-circle" :
    b.status === "no_show" ? "alert-circle" :
    b.status === "completed" ? "checkmark-done" : "calendar";
  const title =
    b.status === "confirmed" ? `Booking confirmed · ${b.clientName}` :
    b.status === "pending" ? `Pending booking · ${b.clientName}` :
    b.status === "cancelled" ? `Cancelled · ${b.clientName}` :
    b.status === "no_show" ? `No-show · ${b.clientName}` :
    b.status === "completed" ? `Completed · ${b.clientName}` :
    `${b.clientName} · ${b.status}`;
  return {
    id: `bk-${b.id}`,
    icon,
    tone,
    title,
    subtitle: `${b.serviceName}${b.staffName ? ` · with ${b.staffName}` : ""}`,
    rawDate: start,
    unread: false,
    deepLink: `/appointments/${b.id}`,
    bookingId: b.id,
    bookingStatus: b.status,
  };
}

// ─── Grouping ─────────────────────────────────────────────────────

function group(items: InboxItem[], now: Date): {
  today: InboxItem[];
  yesterday: InboxItem[];
  earlier: InboxItem[];
} {
  const todayKey = startOfDay(now).getTime();
  const ydayKey = addDays(startOfDay(now), -1).getTime();
  const today: InboxItem[] = [];
  const yesterday: InboxItem[] = [];
  const earlier: InboxItem[] = [];
  for (const it of items) {
    const d = startOfDay(it.rawDate).getTime();
    if (d === todayKey) today.push(it);
    else if (d === ydayKey) yesterday.push(it);
    else earlier.push(it);
  }
  return { today, yesterday, earlier };
}

// ─── Screen ───────────────────────────────────────────────────────

export default function NotificationsScreen() {
  const router = useRouter();
  const now = React.useMemo(() => new Date(), []);
  const notif = useNotifications();
  const appts = useAppointments({
    from: addDays(startOfDay(now), -14).toISOString(),
    to: addDays(startOfDay(now), 14).toISOString(),
    limit: 50,
  });

  const items = React.useMemo<InboxItem[]>(() => {
    // Prefer real notifications when present; fall back to derived
    // booking events. When both are present, merge with notifications
    // first.
    const a: InboxItem[] = (notif.data?.rows ?? []).map(fromNotification);
    const b: InboxItem[] = (appts.data?.rows ?? []).map(fromBooking);
    return [...a, ...b].sort((x, y) => y.rawDate.getTime() - x.rawDate.getTime());
  }, [notif.data, appts.data]);

  const groups = React.useMemo(() => group(items, now), [items, now]);
  const unreadCount = items.filter((i) => i.unread).length;

  const isLoading = (notif.isLoading || appts.isLoading) && items.length === 0;
  const isError = (notif.isError && appts.isError) || (notif.isError && !appts.data);
  const isEmpty = !isLoading && !isError && items.length === 0;

  const onRefresh = React.useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    return Promise.all([notif.refetch(), appts.refetch()]);
  }, [notif, appts]);

  function onItemPress(item: InboxItem) {
    void Haptics.selectionAsync().catch(() => {});
    if (item.deepLink) {
      router.push(item.deepLink);
    }
  }

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Header */}
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)");
          }}
        />
        <View style={{ flex: 1 }}>
          <AppText variant="bodyStrong" align="center">
            Notifications
          </AppText>
          {unreadCount > 0 ? (
            <AppText variant="micro" align="center" color="brand">
              {unreadCount} unread
            </AppText>
          ) : null}
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScreenContainer
        scrollable
        padding
        refreshControl={
          <RefreshControl
            refreshing={(notif.isFetching || appts.isFetching) && !isLoading}
            onRefresh={onRefresh}
            tintColor={colors.brand}
          />
        }
      >
        {isError ? (
          <Card>
            <AppText variant="bodyStrong" color="danger">
              Couldn't load notifications
            </AppText>
          </Card>
        ) : isLoading ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            <Shimmer.Card height={68} />
            <Shimmer.Card height={68} />
            <Shimmer.Card height={68} />
            <Shimmer.Card height={68} />
          </View>
        ) : isEmpty ? (
          <SectionFade>
            <Card variant="outline" style={{ marginTop: spacing.xl }}>
              <EmptyState
                icon={<Ionicons name="notifications-outline" size={28} color={colors.brand} />}
                title="You're all caught up"
                body="New bookings, cancellations, and system events show up here in real time."
              />
            </Card>
          </SectionFade>
        ) : (
          <>
            {groups.today.length > 0 ? (
              <Group title="Today" items={groups.today} now={now} onItemPress={onItemPress} delay={0} />
            ) : null}
            {groups.yesterday.length > 0 ? (
              <Group title="Yesterday" items={groups.yesterday} now={now} onItemPress={onItemPress} delay={60} />
            ) : null}
            {groups.earlier.length > 0 ? (
              <Group title="Earlier" items={groups.earlier} now={now} onItemPress={onItemPress} delay={120} />
            ) : null}
            <View style={{ height: spacing["3xl"] }} />
          </>
        )}
      </ScreenContainer>
    </ScreenContainer>
  );
}

function Group({
  title,
  items,
  now,
  onItemPress,
  delay,
}: {
  title: string;
  items: InboxItem[];
  now: Date;
  onItemPress: (item: InboxItem) => void;
  delay: number;
}) {
  const confirmBooking = useConfirmBooking();
  return (
    <SectionFade delay={delay} style={{ marginTop: spacing.lg }}>
      <SectionHeader eyebrow={title.toUpperCase()} title={`${items.length} update${items.length === 1 ? "" : "s"}`} />
      <Card padding="none">
        {items.map((it, i) => {
          const isPendingBooking = it.bookingStatus === "pending" && Boolean(it.bookingId);
          const confirmingThis = isPendingBooking && confirmBooking.isPending && confirmBooking.variables === it.bookingId;
          return (
            <PressableCard
              key={it.id}
              padding={spacing.md}
              variant="plain"
              onPress={() => onItemPress(it)}
              style={[
                styles.itemPress,
                i < items.length - 1 && styles.itemDivider,
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md }}>
                {it.unread ? <View style={styles.unreadDot} /> : <View style={styles.unreadSlot} />}
                <View style={{ flex: 1 }}>
                  <ActivityRow
                    icon={it.icon}
                    tone={it.tone}
                    title={it.title}
                    subtitle={it.subtitle}
                    timestamp={relativeTime(it.rawDate, now)}
                  />
                  {/* Inline quick actions — only pending bookings get a
                      Confirm shortcut so operators don't have to open
                      the detail just to approve. */}
                  {isPendingBooking ? (
                    <View style={styles.quickActionRow}>
                      <PressableCard
                        variant="plain"
                        padding={0}
                        onPress={() => {
                          if (!it.bookingId || confirmBooking.isPending) return;
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                          confirmBooking.mutate(it.bookingId);
                        }}
                        style={[
                          styles.quickActionChip,
                          confirmingThis && styles.quickActionChipBusy,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Confirm this booking"
                      >
                        <Ionicons
                          name="checkmark-circle"
                          size={13}
                          color={colors.brand}
                        />
                        <AppText
                          variant="micro"
                          style={{
                            color: colors.brand,
                            marginLeft: 4,
                            letterSpacing: 0.3,
                            fontWeight: "600",
                          }}
                        >
                          {confirmingThis ? "Confirming…" : "Confirm"}
                        </AppText>
                      </PressableCard>
                      <PressableCard
                        variant="plain"
                        padding={0}
                        onPress={() => onItemPress(it)}
                        style={styles.quickActionChipSubtle}
                        accessibilityRole="button"
                        accessibilityLabel="Open booking detail"
                      >
                        <AppText
                          variant="micro"
                          style={{
                            color: colors.inkMuted,
                            letterSpacing: 0.3,
                            fontWeight: "600",
                          }}
                        >
                          Open
                        </AppText>
                        <Ionicons
                          name="chevron-forward"
                          size={11}
                          color={colors.inkMuted}
                          style={{ marginLeft: 2 }}
                        />
                      </PressableCard>
                    </View>
                  ) : null}
                </View>
              </View>
            </PressableCard>
          );
        })}
      </Card>
    </SectionFade>
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
  itemPress: {
    backgroundColor: colors.surface,
  },
  itemDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    borderRadius: 0,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.brand,
    marginTop: 16,
  },
  unreadSlot: {
    width: 8,
    height: 8,
  },
  // Inline quick-action row — appears below a pending-booking row's
  // ActivityRow so operators can confirm without opening detail.
  quickActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginLeft: 38, // align under the ActivityRow icon column
  },
  quickActionChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.brandSubtle,
  },
  quickActionChipBusy: {
    opacity: 0.6,
  },
  quickActionChipSubtle: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceInset,
  },
});
