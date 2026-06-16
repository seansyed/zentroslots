/**
 * CustomerRow — premium CRM list row.
 *
 *   [avatar] [name + email]   [booking count chip + last seen]
 *            [status pill + tags]
 *
 * Designed to scan quickly on mobile: name + the most actionable
 * signal (last interaction) are the first things visible.
 */

import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AppText } from "@/components/ui/Text";
import { Avatar } from "@/components/ui/Avatar";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { PressableCard } from "@/components/ui/Card";
import { colors, radius, shadows, spacing } from "@/theme";

import type { Customer, CustomerStatus } from "@/api/customers";

type Props = {
  customer: Customer;
  onPress?: () => void;
  style?: ViewStyle;
};

const STATUS_TONE: Record<CustomerStatus, PillTone> = {
  active: "neutral",
  vip: "violet",
  archived: "neutral",
  prospect: "info",
};

function formatLastSeen(iso: string | null, now: Date): string {
  if (!iso) return "Never booked";
  const ms = now.getTime() - new Date(iso).getTime();
  const days = Math.round(ms / 86_400_000);
  if (days < -1) return "upcoming";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function CustomerRowImpl({ customer, onPress, style }: Props) {
  const now = React.useMemo(() => new Date(), []);
  const lastSeen = formatLastSeen(customer.lastAppointmentAt, now);
  const tone = STATUS_TONE[customer.status] ?? "neutral";

  return (
    <PressableCard
      onPress={() => {
        void Haptics.selectionAsync().catch(() => {});
        onPress?.();
      }}
      padding="none"
      style={[styles.card, style]}
    >
      <View style={styles.row}>
        <View style={styles.avatarSlot}>
          <Avatar name={customer.name} uri={customer.imageUrl} size={40} />
          {customer.status === "vip" ? <View style={styles.vipDot} /> : null}
        </View>

        <View style={styles.middle}>
          <View style={styles.titleRow}>
            <AppText variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
              {customer.name}
            </AppText>
            <AppText
              variant="micro"
              color="subtle"
              style={{ marginLeft: spacing.sm, letterSpacing: 0.3 }}
            >
              {lastSeen.toUpperCase()}
            </AppText>
          </View>
          <AppText variant="small" color="muted" numberOfLines={1} style={{ marginTop: 2 }}>
            {customer.email}
          </AppText>
          <View style={styles.chipsRow}>
            <Pill tone={tone}>{customer.status}</Pill>
            <View style={styles.statsChip}>
              <Ionicons name="calendar" size={10} color={colors.inkMuted} />
              <AppText
                variant="micro"
                style={{ color: colors.inkMuted, marginLeft: 3 }}
              >
                {customer.totalBookings}{" "}
                {customer.totalBookings === 1 ? "booking" : "bookings"}
              </AppText>
            </View>
            {customer.tags.slice(0, 2).map((tag) => (
              <View key={tag} style={styles.tagChip}>
                <AppText variant="micro" style={{ color: colors.brand }}>
                  #{tag}
                </AppText>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.chevron}>
          <Ionicons name="chevron-forward" size={16} color={colors.inkSubtle} />
        </View>
      </View>
    </PressableCard>
  );
}

/**
 * Phase 3: memoized so the Customers tab list doesn't re-render every
 * row on parent state changes (search input, refetch). Shallow-compare
 * via React.memo is sufficient — `customer` is a stable object from
 * the cache, `onPress` is recreated per render but takes a closure
 * over a stable router.push — we accept the cost of the rare
 * re-render this causes in exchange for the simpler call site. If
 * scrolling stutters appear in the wild, switch to memo's second-arg
 * comparator on `customer.id` only.
 */
export const CustomerRow = React.memo(CustomerRowImpl);

const styles = StyleSheet.create({
  /** Phase 2F: floating row aesthetic — softer ambient shadow, larger
   *  rounded radius, hairline border so the surface reads as its own
   *  thing without going heavy. */
  card: {
    overflow: "hidden",
    borderRadius: radius["2xl"],
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    ...shadows.ambient,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  avatarSlot: {
    position: "relative",
  },
  vipDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.violet,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  middle: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  chipsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  statsChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceInset,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  tagChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.brandSubtle,
    borderRadius: radius.full,
  },
  chevron: {
    marginLeft: -spacing.xs,
  },
});
