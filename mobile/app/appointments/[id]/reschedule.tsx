/**
 * /appointments/[id]/reschedule — Phase 1C reschedule sheet.
 *
 * Presented as a modal from the booking detail screen. Two-step UI:
 *   1) Horizontal 14-day date strip (today + 13 forward days)
 *   2) Slot grid for the picked date, fetched from /api/slots
 *
 * On confirm:
 *   • Optimistically flip the cached appointment row to the new
 *     start/end so the back-stack detail screen reflects it instantly.
 *   • POST /api/bookings/:id/reschedule (server validates the slot is
 *     still free and recomputes endAt from service duration).
 *   • On error: roll the cache back and surface the message inline.
 *
 * No new dependencies — the date strip + slot grid are built on the
 * existing UI primitives (Card, Button, Pill, AppText). Native
 * date/time pickers are intentionally avoided so the bundle stays
 * unchanged (the strip + grid is the same UX the web booking page
 * uses).
 *
 * Why not /api/tenant/appointments: that endpoint creates new bookings
 * for admins, not reschedules. The reschedule path lives at
 * /api/bookings/:id/reschedule which the server also gates on tenant
 * feature flags + role. Mobile inherits all those guards for free.
 */

import * as React from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/api/client";
import {
  appointmentsApi,
  type Appointment,
} from "@/api/appointments";
import { AppText } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAppointment } from "@/hooks/useAppointments";
import { useProfile } from "@/hooks/useProfile";
import { apptDay, apptTimeRange } from "@/lib/appointmentTime";
import {
  formatDateLong,
  isSameDay,
} from "@/lib/format";
import { dayLabel, isoDateLocal } from "@/lib/dates";
import { queryKeys } from "@/lib/query";
import { colors, layout, radius, shadows, spacing, typography } from "@/theme";

// Stable 14-day window — today + 13 days forward, computed in the
// device's local time. We expand backwards on demand via prev/next
// buttons but the initial render avoids any layout shift.
const DATE_STRIP_DAYS = 14;

// Date → YYYY-MM-DD uses isoDateLocal (@/lib/dates) — Hermes-safe, sends the
// picked calendar day literally (the old Intl.DateTimeFormat path silently
// sent the wrong day on Hermes for operators east of UTC).

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function buildDateStrip(start: Date, count: number): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < count; i++) days.push(addDays(start, i));
  return days;
}

export default function RescheduleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const apptQuery = useAppointment(id);
  const profileQuery = useProfile();
  const appt = apptQuery.data;
  const profile = profileQuery.data;

  // The staff's timezone is what the engine uses to compute slots, but
  // we don't have it on the appointment row — fall back to the signed-in
  // user's timezone (close enough; staff = signed-in user for the
  // common case of self-management).
  const timezone = profile?.timezone ?? "UTC";

  // Date strip — keep "today" stable for the lifetime of the modal so
  // the strip doesn't jump if the user lingers across midnight.
  const today = React.useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const dateStrip = React.useMemo(
    () => buildDateStrip(today, DATE_STRIP_DAYS),
    [today],
  );

  const [selectedDate, setSelectedDate] = React.useState<Date>(today);
  const [selectedSlot, setSelectedSlot] = React.useState<string | null>(null);

  const slotsQuery = useQuery({
    queryKey: appt?.serviceId && appt?.staffId
      ? ["slots", appt.serviceId, appt.staffId, isoDateLocal(selectedDate), timezone]
      : ["slots", "skip"],
    queryFn: () =>
      appointmentsApi.slots({
        serviceId: appt!.serviceId!,
        staffUserId: appt!.staffId!,
        date: isoDateLocal(selectedDate),
        timezone,
      }),
    enabled: Boolean(appt?.serviceId && appt?.staffId),
    staleTime: 30_000,
  });

  // Reset the slot pick whenever the date changes so the confirm
  // button can never fire for a stale slot from a previous day.
  React.useEffect(() => {
    setSelectedSlot(null);
  }, [selectedDate]);

  // Authoritative label for the selected slot (server-formatted in the
  // tenant tz) — never formatted on-device.
  const selectedLabel =
    slotsQuery.data?.display.find((r) => r.start === selectedSlot)?.label ?? "";

  const rescheduleMutation = useMutation({
    mutationFn: (startAtIso: string) =>
      appointmentsApi.reschedule(id, { startAt: startAtIso }),
    onMutate: async (startAtIso) => {
      // Snapshot for rollback. We optimistically project the booking
      // row to the new time using the existing duration so the back
      // stack reflects the change instantly even if the network is slow.
      await queryClient.cancelQueries({ queryKey: queryKeys.appointment(id) });
      const prev = queryClient.getQueryData<Appointment>(queryKeys.appointment(id));
      if (prev) {
        const duration =
          new Date(prev.endAt).getTime() - new Date(prev.startAt).getTime();
        const newStart = new Date(startAtIso);
        const newEnd = new Date(newStart.getTime() + duration);
        queryClient.setQueryData<Appointment>(queryKeys.appointment(id), {
          ...prev,
          startAt: newStart.toISOString(),
          endAt: newEnd.toISOString(),
          status: prev.status === "pending" ? "pending" : "confirmed",
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back the optimistic write.
      if (ctx?.prev) {
        queryClient.setQueryData(queryKeys.appointment(id), ctx.prev);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
        () => {},
      );
    },
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      // Invalidate the list so it picks up the new time on the next
      // render of the appointments tab.
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointments() });
      // Also invalidate the detail key so any server-side fields we
      // didn't optimistically write (e.g. meet link, reminder flags)
      // refresh.
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointment(id) });
      router.back();
    },
  });

  function onSlotPress(iso: string) {
    void Haptics.selectionAsync().catch(() => {});
    setSelectedSlot(iso);
  }

  function onDatePress(d: Date) {
    void Haptics.selectionAsync().catch(() => {});
    setSelectedDate(d);
  }

  function onConfirm() {
    if (!selectedSlot) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    rescheduleMutation.mutate(selectedSlot);
  }

  const errorMessage =
    rescheduleMutation.error instanceof Error
      ? rescheduleMutation.error.message
      : null;

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Header */}
      <View style={styles.topBar}>
        <IconButton
          icon="close"
          accessibilityLabel="Close"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace(`/appointments/${id}`);
          }}
        />
        <AppText variant="bodyStrong" style={styles.topTitle} numberOfLines={1}>
          Reschedule
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={slotsQuery.isFetching && !slotsQuery.isLoading}
            onRefresh={() => {
              void Haptics.selectionAsync().catch(() => {});
              void slotsQuery.refetch();
            }}
            tintColor={colors.brand}
          />
        }
      >
        {apptQuery.isLoading ? (
          <View style={{ gap: spacing.lg }}>
            <Skeleton width="100%" height={120} borderRadius={radius.lg} />
            <Skeleton width="100%" height={90} borderRadius={radius.lg} />
            <Skeleton width="100%" height={220} borderRadius={radius.lg} />
          </View>
        ) : apptQuery.isError || !appt ? (
          <ErrorState
            kind={apptQuery.error instanceof ApiError ? apptQuery.error.kind : "unknown"}
            title="Appointment not found"
            description={
              apptQuery.error instanceof Error
                ? apptQuery.error.message
                : "It may have been removed."
            }
            onRetry={() => void apptQuery.refetch()}
          />
        ) : (
          <>
            {/* ── Current booking summary ─────────────────────────── */}
            <Card style={styles.summaryCard}>
              <View style={styles.summaryTop}>
                <Pill tone="brand">Current</Pill>
                <AppText variant="caption" color="muted">
                  {timezone}
                </AppText>
              </View>
              <AppText variant="h4" style={{ marginTop: spacing.sm }} numberOfLines={1}>
                {appt.serviceName}
              </AppText>
              <View style={styles.summaryTimeRow}>
                <Ionicons name="time-outline" size={14} color={colors.inkMuted} />
                <AppText variant="small" color="muted" style={{ marginLeft: 4 }}>
                  {apptDay(appt)} · {apptTimeRange(appt)}
                </AppText>
              </View>
            </Card>

            {/* ── Date strip ──────────────────────────────────────── */}
            <View style={{ marginTop: spacing.lg }}>
              <AppText
                variant="micro"
                color="subtle"
                style={{ marginBottom: spacing.sm, paddingHorizontal: spacing.xs }}
              >
                PICK A NEW DATE
              </AppText>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.dateStripContent}
              >
                {dateStrip.map((d) => {
                  const active = isSameDay(d, selectedDate);
                  const isToday = isSameDay(d, today);
                  return (
                    <Pressable
                      key={d.toISOString()}
                      onPress={() => onDatePress(d)}
                      accessibilityRole="button"
                      accessibilityLabel={formatDateLong(d)}
                      accessibilityState={{ selected: active }}
                      style={[
                        styles.dateChip,
                        active && styles.dateChipActive,
                      ]}
                    >
                      <AppText
                        style={{
                          ...typography.micro,
                          color: active ? colors.inkOnBrand : colors.inkSubtle,
                          letterSpacing: 0.4,
                        }}
                      >
                        {d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()}
                      </AppText>
                      <AppText
                        variant="h4"
                        style={{
                          color: active ? colors.inkOnBrand : colors.ink,
                          marginTop: 2,
                        }}
                      >
                        {d.getDate()}
                      </AppText>
                      {isToday ? (
                        <View
                          style={[
                            styles.todayDot,
                            { backgroundColor: active ? colors.inkOnBrand : colors.brand },
                          ]}
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            {/* ── Slot grid ───────────────────────────────────────── */}
            <View style={{ marginTop: spacing.lg }}>
              <AppText
                variant="micro"
                color="subtle"
                style={{ marginBottom: spacing.sm, paddingHorizontal: spacing.xs }}
              >
                AVAILABLE TIMES — {formatDateLong(selectedDate).toUpperCase()}
              </AppText>
              <Card>
                {slotsQuery.isLoading ? (
                  <View style={styles.slotGrid}>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <Skeleton key={i} width="22%" height={42} borderRadius={radius.md} />
                    ))}
                  </View>
                ) : slotsQuery.isError ? (
                  <ErrorState
                    kind={slotsQuery.error instanceof ApiError ? slotsQuery.error.kind : "unknown"}
                    title="Couldn't load slots"
                    description={
                      slotsQuery.error instanceof Error
                        ? slotsQuery.error.message
                        : "Try a different date or refresh."
                    }
                    onRetry={() => void slotsQuery.refetch()}
                  />
                ) : (slotsQuery.data?.display ?? []).length === 0 ? (
                  <View style={styles.emptyState}>
                    <Ionicons name="calendar-outline" size={24} color={colors.inkSubtle} />
                    <AppText variant="bodyStrong" style={{ marginTop: spacing.sm }}>
                      No openings on this day
                    </AppText>
                    <AppText variant="small" color="muted" style={{ marginTop: 2, textAlign: "center" }}>
                      Try a nearby date — the strip above scrolls.
                    </AppText>
                  </View>
                ) : (
                  <View style={styles.slotGrid}>
                    {(slotsQuery.data?.display ?? []).map((row) => {
                      const active = row.start === selectedSlot;
                      return (
                        <Pressable
                          key={row.start}
                          onPress={() => onSlotPress(row.start)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          style={[styles.slotChip, active && styles.slotChipActive]}
                        >
                          <AppText
                            variant="bodyStrong"
                            style={{ color: active ? colors.inkOnBrand : colors.ink }}
                          >
                            {row.label}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </Card>
            </View>

            {errorMessage ? (
              <Card style={styles.errorBanner}>
                <View style={styles.errorRow}>
                  <Ionicons name="alert-circle" size={18} color={colors.dangerInk} />
                  <AppText
                    variant="small"
                    style={{ color: colors.dangerInk, marginLeft: spacing.sm, flex: 1 }}
                  >
                    {errorMessage}
                  </AppText>
                </View>
              </Card>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Sticky confirm action */}
      {appt ? (
        <View style={styles.stickyActions}>
          {selectedSlot ? (
            <View style={styles.confirmPreview}>
              <AppText variant="caption" color="muted">
                New time
              </AppText>
              <AppText variant="bodyStrong" numberOfLines={1}>
                {dayLabel(selectedDate)} · {selectedLabel}
              </AppText>
            </View>
          ) : null}
          <Button
            label={
              rescheduleMutation.isPending
                ? "Rescheduling…"
                : selectedSlot
                  ? "Confirm reschedule"
                  : "Pick a time"
            }
            variant="primary"
            size="lg"
            fullWidth
            disabled={!selectedSlot || rescheduleMutation.isPending}
            loading={rescheduleMutation.isPending}
            onPress={onConfirm}
            leftIcon={
              !rescheduleMutation.isPending && selectedSlot ? (
                <Ionicons name="checkmark" size={18} color={colors.inkOnBrand} />
              ) : undefined
            }
          />
        </View>
      ) : null}
    </ScreenContainer>
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
    textAlign: "center",
    marginHorizontal: spacing.md,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: 180,
  },
  summaryCard: {
    backgroundColor: colors.surface,
  },
  summaryTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  summaryTimeRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
  },
  dateStripContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
  },
  dateChip: {
    width: 60,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  dateChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
    ...shadows.sm,
  },
  todayDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 4,
  },
  slotGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  slotChip: {
    minWidth: "22%",
    flexGrow: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceInset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  slotChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
    ...shadows.sm,
  },
  emptyState: {
    paddingVertical: spacing.xl,
    alignItems: "center",
  },
  errorBanner: {
    marginTop: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderColor: colors.dangerInk,
    borderWidth: StyleSheet.hairlineWidth,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  stickyActions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    backgroundColor: colors.surface,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    ...shadows.md,
  },
  confirmPreview: {
    alignItems: "center",
  },
});
