/**
 * /appointments/[id] — full-screen booking detail.
 *
 * Sourced from GET /api/bookings/:id (added in Phase 1B). The list
 * + Home rows navigate here; deep links also resolve cleanly because
 * the screen is auth-gated by the root _layout.
 *
 * UX commitments (Phase 1B brief):
 *   • Animated slide-in (configured at the Stack screen in _layout)
 *   • Header card with service, status, time, duration
 *   • Customer avatar/name/email + contact CTA
 *   • Service info + staff
 *   • Meeting card + Join CTA (if meetLink)
 *   • Notes (customer + internal, role-gated by API)
 *   • Sticky bottom actions: Reschedule + Cancel
 *   • Loading: skeleton stack (not spinner) for perceived performance
 *   • Error: ErrorState w/ retry
 *   • Pull-to-refresh
 *   • Haptics on every CTA
 */

import * as React from "react";
import {
  Alert,
  Linking,
  Platform,
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
import { appointmentsApi, type Appointment, type BookingStatus } from "@/api/appointments";
import { formatIntakeValue, type IntakeAnswer } from "@/api/intake";
import { AppText } from "@/components/ui/Text";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DetailRow } from "@/components/ui/DetailRow";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { StalenessHint } from "@/components/ui/StalenessHint";
import { useAppointment } from "@/hooks/useAppointments";
import { apptDay, apptTimeRange } from "@/lib/appointmentTime";
import { queryKeys } from "@/lib/query";
import { colors, layout, radius, shadows, spacing, typography } from "@/theme";

function statusTone(status: BookingStatus): PillTone {
  switch (status) {
    case "confirmed":
      return "success";
    case "pending":
      return "warning";
    case "cancelled":
    case "no_show":
      return "danger";
    case "completed":
      return "neutral";
    default:
      return "neutral";
  }
}

function durationMinutes(start: string, end: string): number {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
}

function providerLabel(p: Appointment["meetingProvider"]): string {
  switch (p) {
    case "google_meet":
      return "Google Meet";
    case "microsoft_teams":
      return "Microsoft Teams";
    case "zoom":
      return "Zoom";
    case "in_person":
      return "In person";
    case "phone":
      return "Phone call";
    default:
      return "Online meeting";
  }
}

export default function BookingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const q = useAppointment(id);
  const appt = q.data;

  // Service-template intake answers for this booking. Read-only on mobile —
  // the backend exposes no write path (the intake-responses route is GET-only),
  // so we display them and document the limitation. Role-gated server-side;
  // resolves to [] when there are none or the caller lacks access (never blocks
  // the screen).
  const intakeQ = useQuery({
    queryKey: ["intake-responses", id],
    queryFn: () => appointmentsApi.intakeResponses(id),
    enabled: Boolean(id) && Boolean(appt),
    staleTime: 60_000,
  });
  const intakeAnswers = intakeQ.data ?? [];

  // Optimistic cancel — flip the cached row to "cancelled" the moment
  // the user taps the button, then roll back if the server rejects.
  // Operators don't wait for the round trip; if it fails we tell them.
  const cancelMutation = useMutation({
    mutationFn: () => appointmentsApi.cancel(id),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.appointment(id) });
      const previous = queryClient.getQueryData<Appointment | undefined>(queryKeys.appointment(id));
      queryClient.setQueryData(queryKeys.appointment(id), (prev: Appointment | undefined) =>
        prev ? { ...prev, status: "cancelled" as BookingStatus } : prev,
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.appointment(id), ctx.previous);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert(
        "Couldn't cancel",
        err instanceof Error ? err.message : "Try again in a moment.",
      );
    },
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onSettled: () => {
      // Always reconcile with the server — the list refetches so other
      // screens (Home, Bookings tab) reflect the change.
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointments() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointment(id) });
    },
  });

  // Optimistic status transition — used by "Confirm" on pending bookings.
  // Same rollback semantics as cancel above. Server route enforces role.
  const statusMutation = useMutation({
    mutationFn: (next: BookingStatus) => appointmentsApi.setStatus(id, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.appointment(id) });
      const previous = queryClient.getQueryData<Appointment | undefined>(queryKeys.appointment(id));
      queryClient.setQueryData(queryKeys.appointment(id), (prev: Appointment | undefined) =>
        prev ? { ...prev, status: next } : prev,
      );
      return { previous };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.appointment(id), ctx.previous);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      Alert.alert(
        "Couldn't update",
        err instanceof Error ? err.message : "Try again in a moment.",
      );
    },
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointments() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.appointment(id) });
    },
  });

  function onCancelPress() {
    if (!appt) return;
    Alert.alert(
      "Cancel this appointment?",
      `${appt.clientName} will be notified. This can't be undone.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Cancel appointment",
          style: "destructive",
          onPress: () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            cancelMutation.mutate();
          },
        },
      ],
    );
  }

  function onReschedulePress() {
    void Haptics.selectionAsync().catch(() => {});
    // Phase 1C — push the modal route. The reschedule screen reads the
    // same [id] param so the appointment is already in cache.
    router.push(`/appointments/${id}/reschedule`);
  }

  function onJoinMeeting() {
    if (!appt?.meetLink) return;
    void Haptics.selectionAsync().catch(() => {});
    Linking.openURL(appt.meetLink).catch(() =>
      Alert.alert("Couldn't open", "The meeting link looks invalid."),
    );
  }

  function onEmailCustomer() {
    if (!appt?.clientEmail) return;
    void Haptics.selectionAsync().catch(() => {});
    Linking.openURL(`mailto:${appt.clientEmail}`).catch(() =>
      Alert.alert("Couldn't open", "No email app available."),
    );
  }

  function onCallCustomer() {
    if (!appt?.clientPhone) return;
    void Haptics.selectionAsync().catch(() => {});
    const sanitized = appt.clientPhone.replace(/[^\d+]/g, "");
    Linking.openURL(`tel:${sanitized}`).catch(() =>
      Alert.alert("Couldn't open", "No phone app available."),
    );
  }

  function onMessageCustomer() {
    if (!appt?.clientPhone) return;
    void Haptics.selectionAsync().catch(() => {});
    const sanitized = appt.clientPhone.replace(/[^\d+]/g, "");
    // SMS unavailable on web — guarded by Platform check at the button.
    Linking.openURL(`sms:${sanitized}`).catch(() =>
      Alert.alert("Couldn't open", "No messaging app available."),
    );
  }

  const refresh = (
    <RefreshControl
      refreshing={q.isFetching && !q.isLoading}
      onRefresh={() => {
        void Haptics.selectionAsync().catch(() => {});
        void q.refetch();
      }}
      tintColor={colors.brand}
    />
  );

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Header bar */}
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/appointments");
          }}
        />
        <View style={styles.topTitle}>
          <AppText variant="bodyStrong" numberOfLines={1} style={{ textAlign: "center" }}>
            Appointment
          </AppText>
          <View style={{ alignItems: "center", marginTop: 2 }}>
            <StalenessHint
              dataUpdatedAt={q.dataUpdatedAt}
              isFetching={q.isFetching && !q.isLoading}
            />
          </View>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh}
      >
        {q.isLoading ? (
          <DetailSkeleton />
        ) : q.isError ? (
          <ErrorState
            kind={q.error instanceof ApiError ? q.error.kind : "unknown"}
            description={q.error instanceof Error ? q.error.message : undefined}
            onRetry={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              void q.refetch();
            }}
          />
        ) : !appt ? (
          <ErrorState
            kind="unknown"
            title="Appointment not found"
            description="It may have been cancelled or removed."
          />
        ) : (
          <DetailBody
            appt={appt}
            intakeAnswers={intakeAnswers}
            onEmail={onEmailCustomer}
            onCall={onCallCustomer}
            onMessage={onMessageCustomer}
            onJoin={onJoinMeeting}
          />
        )}
      </ScrollView>

      {/* Sticky confirm row — appears only for pending bookings so the
          operator can approve with one tap. Sits above the Reschedule
          + Cancel bar so the primary CTA reads first. */}
      {appt && appt.status === "pending" ? (
        <View style={[styles.stickyActions, styles.stickyConfirmRow]}>
          <Button
            label={statusMutation.isPending ? "Confirming…" : "Confirm booking"}
            variant="primary"
            size="md"
            loading={statusMutation.isPending}
            disabled={statusMutation.isPending || cancelMutation.isPending}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              statusMutation.mutate("confirmed");
            }}
            leftIcon={
              !statusMutation.isPending ? (
                <Ionicons name="checkmark-circle" size={16} color={colors.inkOnBrand} />
              ) : undefined
            }
            fullWidth
          />
        </View>
      ) : null}

      {/* Sticky bottom actions — only when we have a live booking and
          the booking is still actionable (not already cancelled or
          completed). */}
      {appt && appt.status !== "cancelled" && appt.status !== "completed" && appt.status !== "no_show" ? (
        <View style={styles.stickyActions}>
          <Button
            label="Reschedule"
            variant="secondary"
            size="md"
            onPress={onReschedulePress}
            leftIcon={<Ionicons name="time-outline" size={16} color={colors.ink} />}
            style={{ flex: 1 }}
          />
          <Button
            label={cancelMutation.isPending ? "Cancelling…" : "Cancel"}
            variant="danger"
            size="md"
            loading={cancelMutation.isPending}
            disabled={cancelMutation.isPending}
            onPress={onCancelPress}
            leftIcon={
              !cancelMutation.isPending ? (
                <Ionicons name="close-circle-outline" size={16} color={colors.inkOnBrand} />
              ) : undefined
            }
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </ScreenContainer>
  );
}

function DetailBody({
  appt,
  intakeAnswers,
  onEmail,
  onCall,
  onMessage,
  onJoin,
}: {
  appt: Appointment;
  intakeAnswers: IntakeAnswer[];
  onEmail: () => void;
  onCall: () => void;
  onMessage: () => void;
  onJoin: () => void;
}) {
  const duration = durationMinutes(appt.startAt, appt.endAt);

  return (
    <View style={{ gap: spacing.lg }}>
      {/* ── Hero card ──────────────────────────────────────────── */}
      <Card variant="elevated" style={styles.heroCard}>
        <View style={styles.heroTopRow}>
          <Pill tone={statusTone(appt.status)}>
            {appt.status.replace("_", " ")}
          </Pill>
          {appt.amountCents != null ? (
            <AppText variant="bodyStrong" color="muted">
              ${(appt.amountCents / 100).toFixed(2)}
            </AppText>
          ) : null}
        </View>
        <AppText variant="h1" style={{ marginTop: spacing.md }} numberOfLines={2}>
          {appt.serviceName}
        </AppText>
        <AppText variant="body" color="muted" style={{ marginTop: spacing.xs }}>
          {apptDay(appt)}
        </AppText>
        <View style={styles.timeRow}>
          <Ionicons name="time-outline" size={16} color={colors.brand} />
          <AppText
            variant="bodyStrong"
            style={{ ...typography.bodyStrong, color: colors.brand, marginLeft: 6 }}
          >
            {apptTimeRange(appt)}
          </AppText>
          <View style={styles.dot} />
          <AppText variant="bodyStrong" color="muted">
            {duration}m
          </AppText>
        </View>
      </Card>

      {/* ── Customer card ──────────────────────────────────────── */}
      <Card>
        <View style={styles.customerRow}>
          <Avatar name={appt.clientName} size={52} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="h4" numberOfLines={1}>
              {appt.clientName}
            </AppText>
            <AppText variant="small" color="muted" numberOfLines={1} style={{ marginTop: 2 }}>
              {appt.clientEmail}
            </AppText>
            {appt.clientPhone ? (
              <AppText variant="small" color="muted" numberOfLines={1}>
                {appt.clientPhone}
              </AppText>
            ) : null}
          </View>
        </View>
        <View style={styles.customerActions}>
          <Button
            label="Email"
            variant="secondary"
            size="sm"
            onPress={onEmail}
            leftIcon={<Ionicons name="mail-outline" size={14} color={colors.ink} />}
            style={{ flex: 1 }}
          />
          {appt.clientPhone ? (
            <Button
              label="Call"
              variant="secondary"
              size="sm"
              onPress={onCall}
              leftIcon={<Ionicons name="call-outline" size={14} color={colors.ink} />}
              style={{ flex: 1 }}
            />
          ) : null}
          {/* SMS is native-only — web has no sms: handler. */}
          {appt.clientPhone && Platform.OS !== "web" ? (
            <Button
              label="Text"
              variant="secondary"
              size="sm"
              onPress={onMessage}
              leftIcon={<Ionicons name="chatbubble-outline" size={14} color={colors.ink} />}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
      </Card>

      {/* ── Meeting / Join CTA ─────────────────────────────────── */}
      {appt.meetLink ? (
        <Card variant="elevated" style={styles.meetingCard}>
          <View style={styles.meetingRow}>
            <View style={styles.meetingIcon}>
              <Ionicons name="videocam" size={20} color={colors.brand} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="bodyStrong">{providerLabel(appt.meetingProvider)}</AppText>
              <AppText variant="caption" color="muted" numberOfLines={1}>
                Tap join to open in the meeting app
              </AppText>
            </View>
          </View>
          <Button
            label="Join meeting"
            variant="primary"
            size="lg"
            fullWidth
            onPress={onJoin}
            leftIcon={<Ionicons name="videocam" size={18} color={colors.inkOnBrand} />}
            style={{ marginTop: spacing.md }}
          />
        </Card>
      ) : null}

      {/* ── Service + Staff details ─────────────────────────────── */}
      <Card>
        <SectionHeader title="Details" eyebrow="Service" />
        <DetailRow icon="briefcase-outline" label="Service" value={appt.serviceName} />
        <DetailRow icon="person-outline" label="With staff" value={appt.staffName} />
        {appt.meetingProvider ? (
          <DetailRow
            icon={appt.meetingProvider === "in_person" ? "location-outline" : "videocam-outline"}
            label="Delivery"
            value={providerLabel(appt.meetingProvider)}
          />
        ) : null}
        {appt.location ? (
          <DetailRow icon="location-outline" label="Location" value={appt.location} />
        ) : null}
      </Card>

      {/* ── Service details (intake answers, read-only) ─────────── */}
      {intakeAnswers.length > 0 ? (
        <Card>
          <SectionHeader title="Service details" eyebrow="Intake" />
          {intakeAnswers.map((a) => {
            const display = formatIntakeValue(a.value);
            return (
              <DetailRow
                key={a.fieldKey}
                icon="document-text-outline"
                label={a.fieldLabel}
                value={
                  <AppText variant="bodyStrong" style={{ marginTop: 2 }}>
                    {display || "—"}
                  </AppText>
                }
              />
            );
          })}
        </Card>
      ) : null}

      {/* ── Notes ──────────────────────────────────────────────── */}
      {appt.notes || appt.internalNotes ? (
        <Card>
          <SectionHeader title="Notes" eyebrow="Context" />
          {appt.notes ? (
            <View style={{ marginBottom: appt.internalNotes ? spacing.md : 0 }}>
              <AppText variant="micro" color="subtle" style={{ marginBottom: 2 }}>
                FROM CUSTOMER
              </AppText>
              <AppText variant="body" color="muted">
                {appt.notes}
              </AppText>
            </View>
          ) : null}
          {appt.internalNotes ? (
            <View>
              <AppText variant="micro" color="subtle" style={{ marginBottom: 2 }}>
                INTERNAL (STAFF ONLY)
              </AppText>
              <AppText variant="body" color="muted">
                {appt.internalNotes}
              </AppText>
            </View>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}

function DetailSkeleton() {
  return (
    <View style={{ gap: spacing.lg }}>
      <Card variant="elevated">
        <Skeleton width={70} height={20} borderRadius={radius.full} />
        <Skeleton width="80%" height={28} style={{ marginTop: spacing.md }} />
        <Skeleton width="50%" height={16} style={{ marginTop: spacing.xs }} />
        <Skeleton width="65%" height={18} style={{ marginTop: spacing.sm }} />
      </Card>
      <Card>
        <Skeleton.Row />
      </Card>
      <Card>
        <Skeleton width="40%" height={20} />
        <View style={{ marginTop: spacing.md, gap: spacing.md }}>
          <Skeleton width="100%" height={32} />
          <Skeleton width="100%" height={32} />
          <Skeleton width="100%" height={32} />
        </View>
      </Card>
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
    alignItems: "center",
    marginHorizontal: spacing.md,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: 140, // leave room for sticky actions
  },
  heroCard: {
    backgroundColor: colors.surface,
  },
  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.inkSubtle,
    marginHorizontal: spacing.sm,
  },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  customerActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  meetingCard: {
    backgroundColor: colors.surface,
  },
  meetingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  meetingIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brandSubtle,
  },
  stickyActions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === "ios" ? 32 : spacing.lg,
    backgroundColor: colors.surface,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    ...shadows.md,
  },
  // Confirm row floats above the reschedule/cancel bar so the operator
  // has a single primary call-to-action with the destructive options
  // tucked below.
  stickyConfirmRow: {
    bottom: Platform.OS === "ios" ? 96 : 78,
    paddingBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 0,
    flexDirection: "column",
    gap: 0,
    backgroundColor: "transparent",
    shadowOpacity: 0,
    elevation: 0,
  },
});

// Workaround for unused-import lint when typography import is used
// only inside style spreads.
void typography;
