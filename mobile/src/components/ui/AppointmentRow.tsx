/**
 * AppointmentRow — premium booking card used across Home, Calendar,
 * and the Appointments tab. One source of truth so the surface looks
 * identical everywhere.
 *
 * Anatomy (left → right):
 *   [accent stripe]  [avatar]  [service · client · staff · meta]  [time · status · payment]
 *
 *   • The vertical accent stripe (4px) takes on the status color so a
 *     glance across the list shows which bookings are confirmed/at-risk.
 *   • Avatar shows the customer initials.
 *   • Middle column shows service name (bold), then customer name +
 *     "with <staff>", then a meta row with provider icon + duration.
 *   • Right column is right-aligned: time in tabular nums, status pill
 *     below, then a payment chip if amountCents > 0.
 *
 * Press feedback uses <PressableCard>'s scale transform — calm, not
 * jumpy. Haptic selection on press if `haptic !== false`.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AppText } from "@/components/ui/Text";
import { Avatar } from "@/components/ui/Avatar";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { PressableCard } from "@/components/ui/Card";
import { colors, radius, spacing, typography } from "@/theme";

import type { Appointment, BookingStatus } from "@/api/appointments";

type Props = {
  appt: Appointment;
  onPress?: () => void;
  /** Hide the time column (used on calendar agenda where time is in a rail). */
  hideTime?: boolean;
  /** Show only the time without a date prefix (default). Set true when
   *  rendering on a mixed-date list to also show "Tue · 2:30 PM". */
  showDateInTime?: boolean;
  /** Disable haptic on press. */
  haptic?: boolean;
  style?: ViewStyle;
};

const STATUS_TONE: Record<BookingStatus, PillTone> = {
  confirmed: "success",
  pending: "warning",
  completed: "neutral",
  cancelled: "danger",
  no_show: "danger",
  rescheduled: "info",
};

const STATUS_ACCENT: Record<BookingStatus, string> = {
  confirmed: colors.success,
  pending: colors.warning,
  completed: colors.inkSubtle,
  cancelled: colors.danger,
  no_show: colors.danger,
  rescheduled: colors.brand,
};

const PROVIDER_ICON: Record<NonNullable<Appointment["meetingProvider"]>, React.ComponentProps<typeof Ionicons>["name"]> = {
  google_meet: "videocam-outline",
  microsoft_teams: "videocam-outline",
  zoom: "videocam-outline",
  in_person: "location-outline",
  phone: "call-outline",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function formatTimeWithDay(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} · ${formatTime(iso)}`;
}

function durationMinutes(startAt: string, endAt: string): number {
  return Math.max(0, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000));
}

function AppointmentRowBase({
  appt,
  onPress,
  hideTime = false,
  showDateInTime = false,
  haptic = true,
  style,
}: Props) {
  const tone: PillTone = STATUS_TONE[appt.status] ?? "neutral";
  const accent = STATUS_ACCENT[appt.status] ?? colors.brand;
  const duration = durationMinutes(appt.startAt, appt.endAt);
  const providerIcon = appt.meetingProvider ? PROVIDER_ICON[appt.meetingProvider] : null;

  return (
    <PressableCard
      onPress={() => {
        if (haptic) void Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      padding="none"
      style={[styles.card, style]}
    >
      <View style={styles.row}>
        {/* Status accent stripe — vertical 4px bar */}
        <View style={[styles.accent, { backgroundColor: accent }]} />

        {/* Avatar */}
        <View style={styles.avatarSlot}>
          <Avatar name={appt.clientName} size={40} />
        </View>

        {/* Middle column — service / client / meta */}
        <View style={styles.middle}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {appt.serviceName}
          </AppText>
          <AppText variant="small" color="muted" numberOfLines={1} style={{ marginTop: 2 }}>
            {appt.clientName}
            {appt.staffName ? ` · with ${appt.staffName}` : ""}
          </AppText>
          <View style={styles.metaRow}>
            {providerIcon ? (
              <View style={styles.metaItem}>
                <Ionicons name={providerIcon} size={11} color={colors.inkSubtle} />
                <AppText variant="micro" color="subtle" style={styles.metaText}>
                  {providerLabel(appt.meetingProvider)}
                </AppText>
              </View>
            ) : null}
            <View style={styles.metaItem}>
              <Ionicons name="time-outline" size={11} color={colors.inkSubtle} />
              <AppText variant="micro" color="subtle" style={styles.metaText}>
                {duration}m
              </AppText>
            </View>
          </View>
        </View>

        {/* Right column — time + status pill + payment indicator */}
        <View style={styles.right}>
          {!hideTime ? (
            <AppText
              style={{
                ...typography.bodyStrong,
                color: colors.ink,
                fontVariant: ["tabular-nums"],
              }}
            >
              {showDateInTime ? formatTimeWithDay(appt.startAt) : formatTime(appt.startAt)}
            </AppText>
          ) : null}
          <Pill tone={tone} style={{ marginTop: hideTime ? 0 : 6 }}>
            {appt.status.replace("_", " ")}
          </Pill>
          {appt.amountCents && appt.amountCents > 0 ? (
            <View style={styles.paymentChip}>
              <Ionicons name="card-outline" size={10} color={colors.successInk} />
              <AppText variant="micro" style={{ color: colors.successInk, marginLeft: 3 }}>
                ${(appt.amountCents / 100).toFixed(0)}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>
    </PressableCard>
  );
}

/**
 * AppointmentRow is rendered in 3+ list surfaces (Home, Calendar agenda,
 * Bookings, customer detail). Memoize so a sibling state change higher in
 * the tree doesn't repaint every row in the list. The comparison is
 * shallow on props + a hot-field check on the booking — sufficient for
 * our optimistic mutations which mint a new appt object on every status
 * flip.
 */
export const AppointmentRow = React.memo(AppointmentRowBase, (prev, next) => {
  if (prev.hideTime !== next.hideTime) return false;
  if (prev.showDateInTime !== next.showDateInTime) return false;
  if (prev.haptic !== next.haptic) return false;
  if (prev.onPress !== next.onPress) return false;
  if (prev.style !== next.style) return false;
  const a = prev.appt;
  const b = next.appt;
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.startAt === b.startAt &&
    a.endAt === b.endAt &&
    a.clientName === b.clientName &&
    a.serviceName === b.serviceName &&
    a.staffName === b.staffName &&
    a.meetingProvider === b.meetingProvider &&
    a.amountCents === b.amountCents
  );
});

function providerLabel(p: Appointment["meetingProvider"]): string {
  switch (p) {
    case "google_meet": return "Meet";
    case "microsoft_teams": return "Teams";
    case "zoom": return "Zoom";
    case "in_person": return "In person";
    case "phone": return "Phone";
    default: return "Online";
  }
}

const styles = StyleSheet.create({
  card: {
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 84,
  },
  accent: {
    width: 4,
    alignSelf: "stretch",
  },
  avatarSlot: {
    paddingLeft: spacing.md,
    paddingVertical: spacing.md,
    justifyContent: "center",
  },
  middle: {
    flex: 1,
    minWidth: 0,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    justifyContent: "center",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 6,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  metaText: {
    letterSpacing: 0.2,
  },
  right: {
    paddingRight: spacing.md,
    paddingVertical: spacing.md,
    alignItems: "flex-end",
    justifyContent: "center",
    minWidth: 78,
  },
  paymentChip: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: colors.successSubtle,
    borderRadius: radius.full,
  },
});
