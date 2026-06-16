/**
 * /customers/[id] — premium CRM detail screen.
 *
 * Sections (top → bottom):
 *   1. Top bar with back button + customer name
 *   2. Hero card — avatar, name, status pill, email + phone + tags
 *   3. Quick actions row — Call · Email · Message (mailto/tel, gracefully no-op
 *      where the OS can't handle it on web)
 *   4. Stats card — total / completed / cancelled / last seen
 *   5. Booking history list — recent bookings as AppointmentRow
 *   6. Notes card (if present)
 *
 * Backed by GET /api/customers/[id] (already exposed). The endpoint
 * returns `bookingHistory[]` so a single fetch paints the whole screen.
 */

import * as React from "react";
import { Alert, Linking, Platform, RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import { AppointmentRow } from "@/components/ui/AppointmentRow";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DetailRow } from "@/components/ui/DetailRow";
import { ErrorState } from "@/components/ui/ErrorState";
import { GradientHeroCard } from "@/components/ui/GradientHeroCard";
import { IconButton } from "@/components/ui/IconButton";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { CustomerEditModal } from "@/components/ui/CustomerEditModal";
import {
  useArchiveCustomer,
  useCustomer,
  useUnarchiveCustomer,
} from "@/hooks/useCustomers";
import { colors, layout, radius, spacing, typography } from "@/theme";

import type { Appointment, BookingStatus } from "@/api/appointments";
import type { CustomerHistoryItem, CustomerStatus } from "@/api/customers";

const STATUS_TONE: Record<CustomerStatus, PillTone> = {
  active: "neutral",
  vip: "violet",
  archived: "neutral",
  prospect: "info",
};

function asAppointment(h: CustomerHistoryItem, customerName: string): Appointment {
  // The booking-history rows from /api/customers/:id come back lean.
  // Cast to the Appointment shape so we can reuse AppointmentRow without
  // a second sub-primitive. Missing fields default to null.
  return {
    id: h.id,
    serviceId: null,
    serviceName: h.serviceName ?? "Appointment",
    staffId: null,
    staffName: h.staffName ?? "Staff",
    clientId: null,
    clientName: customerName,
    clientEmail: "",
    clientPhone: null,
    startAt: h.startAt,
    endAt: h.endAt,
    status: (h.status as BookingStatus) ?? "completed",
    meetingProvider: null,
    meetLink: null,
    location: null,
    amountCents: h.amountCents ?? null,
    notes: null,
  };
}

/**
 * Date formatter that survives the messy real world:
 *   • undefined / null      → "Recently added" (used for "first seen")
 *   • empty string          → "Recently added"
 *   • non-parseable string  → "Unknown"
 *   • valid ISO             → "Tuesday, May 28, 2026"
 *
 * Use this everywhere we render a customer-side date. Replaces the
 * previous `new Date(iso).toLocaleDateString(...)` which produced
 * "Invalid Date" whenever the field arrived undefined (the documented
 * customer-detail wrapper-shape bug surfaced exactly that way).
 */
function formatDateLong(
  iso: string | null | undefined,
  emptyFallback = "Recently added",
): string {
  if (!iso) return emptyFallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Customer name resolver — preferred fallback chain:
 *   1. trimmed name
 *   2. email local-part (capitalised, e.g. "Sahl" from "sahl@x.com")
 *   3. phone number as-is
 *   4. literal "Customer"
 *
 * Avoids the harsh "Unknown customer" label when we actually have an
 * identifier — partial records imported from CSV often have phone or
 * email but no name, and the operator still wants to see something
 * recognisable in the header.
 */
function displayNameOf(c: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  const trimmedName = c.name?.trim();
  if (trimmedName) return trimmedName;
  const email = c.email?.trim();
  if (email && email.includes("@")) {
    const local = email.split("@")[0]!.trim();
    if (local) {
      return local.charAt(0).toUpperCase() + local.slice(1);
    }
  }
  const phone = c.phone?.trim();
  if (phone) return phone;
  return "Customer";
}

function relativeAgo(iso: string | null | undefined, now: Date): string {
  if (!iso) return "Never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) {
    // Future contact (upcoming booking)
    const future = Math.abs(ms);
    const days = Math.round(future / 86_400_000);
    if (days < 1) return "later today";
    if (days === 1) return "tomorrow";
    if (days < 7) return `in ${days}d`;
    return `in ${Math.round(days / 7)}w`;
  }
  const days = Math.round(ms / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/**
 * Safe first-name extractor.
 *
 * Production data can have:
 *   • null / undefined `name` (record imported from a partial form)
 *   • empty string after trim (whitespace-only)
 *   • single-token name with no spaces
 *
 * Calling `.split(" ")[0]` on a null is the crash that prompted this fix.
 * Always return a non-empty string so callers can use it inline in
 * email/SMS templates without further null checks.
 */
function firstNameOf(name: string | null | undefined, fallback = "there"): string {
  if (!name) return fallback;
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/)[0] ?? fallback;
}

function findUpcoming(history: CustomerHistoryItem[], now: Date): CustomerHistoryItem | null {
  const future = history
    .filter((h) => new Date(h.startAt).getTime() > now.getTime())
    .filter((h) => h.status === "confirmed" || h.status === "pending")
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return future[0] ?? null;
}

function findLastPast(history: CustomerHistoryItem[], now: Date): CustomerHistoryItem | null {
  const past = history
    .filter((h) => new Date(h.startAt).getTime() <= now.getTime())
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
  return past[0] ?? null;
}

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const q = useCustomer(id);
  const customer = q.data;
  const [editOpen, setEditOpen] = React.useState(false);
  const archiveMut = useArchiveCustomer(id ?? "");
  const unarchiveMut = useUnarchiveCustomer(id ?? "");

  function onArchiveToggle() {
    if (!customer) return;
    const archived = customer.status === "archived";
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      archived ? "Restore customer?" : "Archive customer?",
      archived
        ? "This customer will return to your active list."
        : "They'll be hidden from your active customer list. Their full booking history is preserved and nothing is deleted — you can restore them any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: archived ? "Restore" : "Archive",
          style: archived ? "default" : "destructive",
          onPress: async () => {
            try {
              if (archived) await unarchiveMut.mutateAsync();
              else await archiveMut.mutateAsync();
              void Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success,
              ).catch(() => {});
              await q.refetch();
            } catch (e) {
              Alert.alert(
                "Couldn't update",
                e instanceof Error ? e.message : "Please try again.",
              );
            }
          },
        },
      ],
    );
  }

  // Defensive: STATUS_TONE has 4 known statuses; if the API ever returns
  // something outside that set (e.g. legacy "lead", future "frozen") the
  // map lookup returns undefined which crashes Pill. Fall back to neutral.
  const tone: PillTone =
    (customer && STATUS_TONE[customer.status]) ?? "neutral";
  const history = customer?.bookingHistory ?? [];
  // Tags can be null on partial / imported customer records even though
  // the TypeScript type says `string[]`. Default to [] for slice safety.
  const tags = customer?.tags ?? [];

  function onCall() {
    if (!customer?.phone) return;
    void Haptics.selectionAsync().catch(() => {});
    const sanitized = customer.phone.replace(/[^\d+]/g, "");
    Linking.openURL(`tel:${sanitized}`).catch(() =>
      Alert.alert("Couldn't open", "No phone app available."),
    );
  }
  function onEmail() {
    if (!customer?.email) return;
    void Haptics.selectionAsync().catch(() => {});
    Linking.openURL(`mailto:${customer.email}`).catch(() =>
      Alert.alert("Couldn't open", "No email app available."),
    );
  }
  function onMessage() {
    if (!customer?.phone) return;
    void Haptics.selectionAsync().catch(() => {});
    const sanitized = customer.phone.replace(/[^\d+]/g, "");
    Linking.openURL(`sms:${sanitized}`).catch(() =>
      Alert.alert("Couldn't open", "No SMS app available."),
    );
  }

  function onSendThanks() {
    if (!customer?.email) return;
    void Haptics.selectionAsync().catch(() => {});
    const subject = "Thank you for choosing us";
    const body = `Hi ${firstNameOf(displayNameOf(customer))},\n\nThank you for booking with us — it was great working with you. If you have a moment to share feedback or refer a friend, we'd really appreciate it.\n\nLooking forward to seeing you again soon.`;
    const url = `mailto:${customer.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    Linking.openURL(url).catch(() =>
      Alert.alert("Couldn't open", "No email app available."),
    );
  }

  function onSendReminder() {
    if (!customer?.email) return;
    void Haptics.selectionAsync().catch(() => {});
    const upcoming = findUpcoming(customer.bookingHistory ?? [], new Date());
    const when = upcoming
      ? new Date(upcoming.startAt).toLocaleString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "your upcoming booking";
    const subject = "Friendly reminder about your appointment";
    const body = `Hi ${firstNameOf(displayNameOf(customer))},\n\nJust a quick reminder about ${when}. Let me know if you need to reschedule — happy to find a better time.\n\nSee you soon.`;
    const url = `mailto:${customer.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    Linking.openURL(url).catch(() =>
      Alert.alert("Couldn't open", "No email app available."),
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
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/customers");
          }}
        />
        <AppText variant="bodyStrong" numberOfLines={1} style={styles.topTitle}>
          {customer ? displayNameOf(customer) : "Customer"}
        </AppText>
        {customer ? (
          <View style={styles.topActions}>
            <IconButton
              icon="create-outline"
              accessibilityLabel="Edit customer"
              onPress={() => {
                void Haptics.selectionAsync().catch(() => {});
                setEditOpen(true);
              }}
            />
            <IconButton
              icon={customer.status === "archived" ? "refresh-outline" : "archive-outline"}
              accessibilityLabel={
                customer.status === "archived" ? "Restore customer" : "Archive customer"
              }
              onPress={onArchiveToggle}
            />
          </View>
        ) : (
          <View style={{ width: 36 }} />
        )}
      </View>

      <CustomerEditModal
        visible={editOpen}
        customer={customer}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          void q.refetch();
        }}
      />

      <View style={styles.scroll}>
        {q.isLoading ? (
          <View style={{ gap: spacing.lg }}>
            <Shimmer.Card height={160} />
            <Shimmer.Card height={68} />
            <Shimmer.Card height={140} />
          </View>
        ) : q.isError || !customer ? (
          <ErrorState
            kind={q.error instanceof ApiError ? q.error.kind : "unknown"}
            title="Customer not found"
            description={q.error instanceof Error ? q.error.message : undefined}
            onRetry={() => void q.refetch()}
          />
        ) : (
          <View style={{ gap: spacing.lg }}>
            {/* Hero */}
            <SectionFade>
              <GradientHeroCard>
                <View style={styles.heroRow}>
                  <Avatar name={displayNameOf(customer)} uri={customer.imageUrl} size={64} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="h2" numberOfLines={1}>
                      {displayNameOf(customer)}
                    </AppText>
                    <AppText
                      variant="small"
                      color="muted"
                      numberOfLines={1}
                      style={{ marginTop: 2 }}
                    >
                      {customer.email ?? "No email on file"}
                    </AppText>
                    <View style={styles.heroChipsRow}>
                      {customer.status ? (
                        <Pill tone={tone}>{customer.status}</Pill>
                      ) : null}
                      {tags.slice(0, 3).map((t) => (
                        <Pill key={t} tone="brand">#{t}</Pill>
                      ))}
                    </View>
                  </View>
                </View>
              </GradientHeroCard>
            </SectionFade>

            {/* Quick actions */}
            <SectionFade delay={60}>
              <View style={styles.actionsRow}>
                <Button
                  label="Email"
                  variant="secondary"
                  size="md"
                  onPress={onEmail}
                  leftIcon={<Ionicons name="mail-outline" size={16} color={colors.ink} />}
                  style={{ flex: 1 }}
                />
                {customer.phone ? (
                  <>
                    <Button
                      label="Call"
                      variant="secondary"
                      size="md"
                      onPress={onCall}
                      leftIcon={<Ionicons name="call-outline" size={16} color={colors.ink} />}
                      style={{ flex: 1 }}
                    />
                    {Platform.OS !== "web" ? (
                      <Button
                        label="Text"
                        variant="secondary"
                        size="md"
                        onPress={onMessage}
                        leftIcon={
                          <Ionicons name="chatbubble-outline" size={16} color={colors.ink} />
                        }
                        style={{ flex: 1 }}
                      />
                    ) : null}
                  </>
                ) : null}
              </View>
            </SectionFade>

            {/* Stats */}
            <SectionFade delay={120}>
              <Card>
                <View style={styles.statsGrid}>
                  <StatCell label="Total" value={customer.totalBookings} />
                  <Divider />
                  <StatCell label="Completed" value={customer.completed} tone="success" />
                  <Divider />
                  <StatCell label="Cancelled" value={customer.cancelled} tone="danger" />
                </View>
                <View style={{ height: 1, backgroundColor: colors.borderSubtle, marginVertical: spacing.md }} />
                <DetailRow
                  icon="time-outline"
                  label="Last interaction"
                  value={
                    customer.lastAppointmentAt
                      ? formatDateLong(customer.lastAppointmentAt)
                      : "Never"
                  }
                />
                {customer.phone ? (
                  <DetailRow icon="call-outline" label="Phone" value={customer.phone} />
                ) : null}
                <DetailRow
                  icon="calendar-outline"
                  label="First seen"
                  value={formatDateLong(customer.createdAt)}
                />
              </Card>
            </SectionFade>

            {/* Communication — light-touch timeline cue + reminder shortcuts.
                Always renders because every customer has either a past or no
                contact (which is itself useful information). */}
            <SectionFade delay={150}>
              <Card>
                <SectionHeader
                  title="Communication"
                  eyebrow="Touchpoints"
                  description="Last contact + quick follow-ups."
                />
                <View style={{ gap: spacing.sm }}>
                  <View style={styles.commsRow}>
                    <View style={styles.commsDot} />
                    <View style={{ flex: 1 }}>
                      <AppText variant="smallStrong">
                        {(() => {
                          const last = findLastPast(history, new Date());
                          if (last) {
                            return `Last seen · ${relativeAgo(last.startAt, new Date())}`;
                          }
                          return "No past bookings yet";
                        })()}
                      </AppText>
                      <AppText
                        variant="micro"
                        color="muted"
                        numberOfLines={1}
                        style={{ marginTop: 2 }}
                      >
                        {(() => {
                          const last = findLastPast(history, new Date());
                          return last
                            ? `${last.serviceName ?? "Appointment"} · ${formatDateLong(last.startAt)}`
                            : "Be the first to reach out below.";
                        })()}
                      </AppText>
                    </View>
                  </View>
                  {(() => {
                    const upcoming = findUpcoming(history, new Date());
                    if (!upcoming) return null;
                    return (
                      <View style={styles.commsRow}>
                        <View style={[styles.commsDot, { backgroundColor: colors.brand }]} />
                        <View style={{ flex: 1 }}>
                          <AppText variant="smallStrong" style={{ color: colors.brand }}>
                            Upcoming · {relativeAgo(upcoming.startAt, new Date())}
                          </AppText>
                          <AppText
                            variant="micro"
                            color="muted"
                            numberOfLines={1}
                            style={{ marginTop: 2 }}
                          >
                            {upcoming.serviceName ?? "Appointment"} · {formatDateLong(upcoming.startAt)}
                          </AppText>
                        </View>
                      </View>
                    );
                  })()}
                </View>
                {customer.email ? (
                  <View style={[styles.actionsRow, { marginTop: spacing.md }]}>
                    {(() => {
                      const upcoming = findUpcoming(history, new Date());
                      return upcoming ? (
                        <Button
                          label="Send reminder"
                          variant="primary"
                          size="sm"
                          onPress={onSendReminder}
                          leftIcon={
                            <Ionicons name="alarm-outline" size={14} color={colors.inkOnBrand} />
                          }
                          style={{ flex: 1 }}
                        />
                      ) : (
                        <Button
                          label="Send thanks"
                          variant="secondary"
                          size="sm"
                          onPress={onSendThanks}
                          leftIcon={
                            <Ionicons name="heart-outline" size={14} color={colors.ink} />
                          }
                          style={{ flex: 1 }}
                        />
                      );
                    })()}
                    {findLastPast(history, new Date()) ? (
                      <Button
                        label="Send thanks"
                        variant="secondary"
                        size="sm"
                        onPress={onSendThanks}
                        leftIcon={
                          <Ionicons name="heart-outline" size={14} color={colors.ink} />
                        }
                        style={{ flex: 1 }}
                      />
                    ) : null}
                  </View>
                ) : null}
              </Card>
            </SectionFade>

            {/* Notes */}
            {customer.notes ? (
              <SectionFade delay={170}>
                <Card>
                  <SectionHeader title="Notes" eyebrow="Internal" />
                  <AppText variant="body" color="muted">
                    {customer.notes}
                  </AppText>
                </Card>
              </SectionFade>
            ) : null}

            {/* Booking history */}
            <SectionFade delay={200}>
              <SectionHeader
                title={history.length === 0 ? "No bookings yet" : "Booking history"}
                eyebrow="Timeline"
                description={
                  history.length === 0
                    ? "Bookings made by this customer will appear here."
                    : `${history.length} booking${history.length === 1 ? "" : "s"} on file.`
                }
              />
              {history.length === 0 ? (
                <Card variant="outline">
                  <View style={{ alignItems: "center", paddingVertical: spacing.xl }}>
                    <Ionicons name="calendar-outline" size={26} color={colors.inkSubtle} />
                    <AppText
                      variant="small"
                      color="muted"
                      style={{ marginTop: spacing.sm }}
                    >
                      Nothing on file yet.
                    </AppText>
                  </View>
                </Card>
              ) : (
                <View style={{ gap: spacing.sm }}>
                  {history.slice(0, 10).map((h) => (
                    <AppointmentRow
                      key={h.id}
                      appt={asAppointment(h, displayNameOf(customer))}
                      showDateInTime
                      onPress={() => router.push(`/appointments/${h.id}`)}
                    />
                  ))}
                </View>
              )}
            </SectionFade>
          </View>
        )}
      </View>
      {/* Bottom breathing room */}
      <View style={{ height: spacing["3xl"] }} />
      {/* Force RefreshControl mount even though we use a manual layout */}
      <View style={{ height: 0 }}>{refresh}</View>
    </ScreenContainer>
  );
}

function StatCell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "danger";
}) {
  const color =
    tone === "success" ? colors.successInk :
    tone === "danger" ? colors.dangerInk : colors.ink;
  return (
    <View style={styles.statCell}>
      <AppText
        style={{
          ...typography.h2,
          color,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </AppText>
      <AppText
        variant="micro"
        color="subtle"
        style={{ marginTop: 2, letterSpacing: 0.4 }}
      >
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
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
  topActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  topTitle: {
    flex: 1,
    textAlign: "center",
    marginHorizontal: spacing.md,
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  heroChipsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  statsGrid: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingVertical: spacing.sm,
  },
  statCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.xs,
  },
  // Communication card timeline rows
  commsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: 6,
  },
  commsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.inkSubtle,
    marginTop: 6,
  },
});
