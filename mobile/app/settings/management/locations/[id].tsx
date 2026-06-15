/**
 * /settings/management/locations/[id] — location detail / edit.
 *
 * Dual-purpose screen:
 *   • id === "new"  → create form (POST /api/locations)
 *   • id === <uuid> → edit form  (PATCH /api/locations/:id) + delete
 *
 * Editable fields mirror the backend zod schema: name, locationType (via
 * SegmentedTabs), address, phone, email, timezone, notes, isActive. The
 * private meeting credentials the schema does NOT expose are never
 * surfaced here.
 *
 * Delete is disabled for system-protected locations (isSystem=true — e.g.
 * the auto-spawned Virtual Hub). The backend also refuses with a 409, so
 * even if we can't read isSystem (the list payload omits it — see
 * api/locations.ts), the server stays the source of truth and we surface
 * its message.
 *
 * RBAC: only admin|manager see the save/delete affordances. Non-managerial
 * users get a read-only view. Writes are enforced server-side regardless.
 *
 * States: loading (Shimmer), error+retry (ErrorState), success (Haptics +
 * navigate back).
 */

import * as React from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import {
  LOCATION_TYPES,
  type LocationType,
  type LocationUpdateInput,
} from "@/api/locations";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import {
  useCreateLocation,
  useDeleteLocation,
  useLocation,
  useUpdateLocation,
} from "@/hooks/useLocations";
import { useProfile } from "@/hooks/useProfile";
import { colors, layout, radius, spacing } from "@/theme";

const TYPE_LABEL: Record<LocationType, string> = {
  physical: "Physical",
  virtual: "Virtual",
  hybrid: "Hybrid",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LocationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isCreate = id === "new";

  const profileQ = useProfile();
  const role = profileQ.data?.role;
  const isManagerial = role === "admin" || role === "manager";

  // Skip the query entirely on create.
  const q = useLocation(isCreate ? undefined : id);
  const location = q.data;

  const createMut = useCreateLocation();
  const updateMut = useUpdateLocation(isCreate ? "" : (id ?? ""));
  const deleteMut = useDeleteLocation(isCreate ? "" : (id ?? ""));
  const saving = createMut.isPending || updateMut.isPending;

  // Form state.
  const [name, setName] = React.useState("");
  const [locationType, setLocationType] = React.useState<LocationType>("physical");
  const [address, setAddress] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [timezone, setTimezone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [isActive, setIsActive] = React.useState(true);
  const [errors, setErrors] = React.useState<{ name?: string; email?: string; form?: string }>({});

  // Seed the form once the location resolves (edit) — or on first mount (create).
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (isCreate) {
      if (seededRef.current) return;
      seededRef.current = true;
      return;
    }
    if (!location) return;
    setName(location.name ?? "");
    setLocationType((location.locationType as LocationType) ?? "physical");
    setAddress(location.address ?? "");
    setPhone(location.phone ?? "");
    setEmail(location.email ?? "");
    setTimezone(location.timezone ?? "");
    setNotes(location.notes ?? "");
    setIsActive(location.isActive ?? true);
  }, [isCreate, location]);

  function validate(): boolean {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name is required";
    if (email.trim() && !EMAIL_RE.test(email.trim())) next.email = "Enter a valid email";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSave() {
    if (saving) return;
    if (!validate()) return;
    void Haptics.selectionAsync().catch(() => {});

    const payload: LocationUpdateInput = {
      name: name.trim(),
      locationType,
      address: address.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      timezone: timezone.trim() || null,
      notes: notes.trim() || null,
    };

    try {
      if (isCreate) {
        const created = await createMut.mutateAsync({
          name: payload.name!,
          locationType,
          address: payload.address,
          phone: payload.phone,
          email: payload.email,
          timezone: payload.timezone,
          notes: payload.notes,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        // Replace so back doesn't return to the empty create form.
        router.replace(`/settings/management/locations/${created.id}`);
      } else {
        await updateMut.mutateAsync({ ...payload, isActive });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        if (router.canGoBack()) router.back();
        else router.replace("/settings/management/locations");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        setErrors({ form: e.message || "You've reached your plan's location limit." });
      } else {
        setErrors({
          form: e instanceof Error ? e.message : "Couldn't save. Please try again.",
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    }
  }

  // System-protected rows can't be deleted. The list payload omits
  // isSystem, so this is best-effort UI gating — the backend 409 is the
  // real guard and we surface its message below.
  const isSystem = location?.isSystem === true;

  function onDelete() {
    if (isCreate || !id) return;
    if (isSystem) return;
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      "Delete location?",
      "If any bookings reference this location it will be archived (hidden) instead of deleted, so history stays intact. Otherwise it's removed permanently.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await deleteMut.mutateAsync();
              void Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success,
              ).catch(() => {});
              Alert.alert(
                res.archived ? "Location archived" : "Location deleted",
                res.archived
                  ? "It was archived because existing bookings reference it. Its history is preserved."
                  : "The location was removed.",
              );
              if (router.canGoBack()) router.back();
              else router.replace("/settings/management/locations");
            } catch (e) {
              void Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Error,
              ).catch(() => {});
              Alert.alert(
                "Couldn't delete",
                e instanceof Error
                  ? e.message
                  : "This location can't be deleted right now.",
              );
            }
          },
        },
      ],
    );
  }

  const title = isCreate ? "New location" : location?.name || "Location";

  // ─── Loading / error gates (edit only) ───────────────────────────
  const showLoading = !isCreate && q.isLoading;
  const showError = !isCreate && (q.isError || (!q.isLoading && !location));

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.topBar}>
          <IconButton
            icon="chevron-back"
            accessibilityLabel="Back"
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              if (router.canGoBack()) router.back();
              else router.replace("/settings/management/locations");
            }}
          />
          <AppText variant="bodyStrong" align="center" numberOfLines={1} style={styles.topTitle}>
            {title}
          </AppText>
          {!isCreate && isManagerial && !isSystem ? (
            <IconButton
              icon="trash-outline"
              tone="danger"
              accessibilityLabel="Delete location"
              onPress={onDelete}
            />
          ) : (
            <View style={{ width: 36 }} />
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {showLoading ? (
            <View style={{ gap: spacing.lg }}>
              <Shimmer.Card height={120} />
              <Shimmer.Card height={180} />
              <Shimmer.Card height={120} />
            </View>
          ) : showError ? (
            <ErrorState
              kind={q.error instanceof ApiError ? q.error.kind : "unknown"}
              title="Location not found"
              description={q.error instanceof Error ? q.error.message : undefined}
              onRetry={() => void q.refetch()}
            />
          ) : (
            <>
              {/* Read-only banner for non-managerial users */}
              {!isManagerial ? (
                <SectionFade>
                  <Card variant="outline" style={styles.readonlyCard}>
                    <View style={styles.readonlyRow}>
                      <Ionicons name="lock-closed-outline" size={16} color={colors.inkMuted} />
                      <AppText variant="caption" color="muted" style={{ marginLeft: 6, flex: 1 }}>
                        You can view this location. Editing is limited to admins and managers.
                      </AppText>
                    </View>
                  </Card>
                </SectionFade>
              ) : null}

              {/* Identity */}
              <SectionFade delay={40}>
                <Card>
                  <SectionHeader title="Identity" eyebrow="Basics" />
                  <Input
                    label="Name"
                    placeholder="Downtown Studio"
                    value={name}
                    onChangeText={setName}
                    error={errors.name}
                    editable={isManagerial}
                    autoCapitalize="words"
                  />

                  <View style={styles.gap}>
                    <AppText variant="smallStrong" color="muted" style={{ marginBottom: spacing.xs }}>
                      Type
                    </AppText>
                    {isManagerial ? (
                      <SegmentedTabs
                        value={locationType}
                        onChange={(v) => setLocationType(v)}
                        options={LOCATION_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
                      />
                    ) : (
                      <Pill tone="brand">{TYPE_LABEL[locationType].toUpperCase()}</Pill>
                    )}
                  </View>
                </Card>
              </SectionFade>

              {/* Contact */}
              <SectionFade delay={80} style={{ marginTop: spacing.lg }}>
                <Card>
                  <SectionHeader title="Contact & address" eyebrow="Reach" />
                  <Input
                    label="Address"
                    placeholder="123 Market St, Suite 200"
                    value={address}
                    onChangeText={setAddress}
                    editable={isManagerial}
                    multiline
                  />
                  <Input
                    label="Phone"
                    placeholder="+1 555 123 4567"
                    value={phone}
                    onChangeText={setPhone}
                    editable={isManagerial}
                    keyboardType="phone-pad"
                    containerStyle={styles.gap}
                  />
                  <Input
                    label="Email"
                    placeholder="hello@studio.com"
                    value={email}
                    onChangeText={setEmail}
                    error={errors.email}
                    editable={isManagerial}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    containerStyle={styles.gap}
                  />
                  <Input
                    label="Timezone"
                    placeholder="America/New_York"
                    value={timezone}
                    onChangeText={setTimezone}
                    editable={isManagerial}
                    autoCapitalize="none"
                    autoCorrect={false}
                    containerStyle={styles.gap}
                    hint="IANA name, e.g. America/Los_Angeles"
                  />
                </Card>
              </SectionFade>

              {/* Operational */}
              <SectionFade delay={120} style={{ marginTop: spacing.lg }}>
                <Card>
                  <SectionHeader title="Operational" eyebrow="Internal" />
                  <Input
                    label="Notes"
                    placeholder="Anything the team should know…"
                    value={notes}
                    onChangeText={setNotes}
                    editable={isManagerial}
                    multiline
                  />

                  {!isCreate ? (
                    <View style={[styles.activeRow, styles.gap]}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <AppText variant="smallStrong">Active</AppText>
                        <AppText variant="caption" color="muted" style={{ marginTop: 2 }}>
                          Inactive locations stay on file but are hidden from booking.
                        </AppText>
                      </View>
                      <View style={styles.activeChips}>
                        <ActiveChip
                          label="Active"
                          selected={isActive}
                          disabled={!isManagerial}
                          onPress={() => {
                            void Haptics.selectionAsync().catch(() => {});
                            setIsActive(true);
                          }}
                        />
                        <ActiveChip
                          label="Inactive"
                          selected={!isActive}
                          disabled={!isManagerial}
                          onPress={() => {
                            void Haptics.selectionAsync().catch(() => {});
                            setIsActive(false);
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                </Card>
              </SectionFade>

              {/* Counters (edit only) */}
              {!isCreate && location ? (
                <SectionFade delay={150} style={{ marginTop: spacing.lg }}>
                  <Card variant="outline">
                    <View style={styles.statsGrid}>
                      <Stat label="Staff" value={location.staffCount ?? 0} />
                      <Divider />
                      <Stat label="Services" value={location.serviceCount ?? 0} />
                      <Divider />
                      <Stat label="Bookings 30d" value={location.bookingsLast30d ?? 0} />
                    </View>
                  </Card>
                </SectionFade>
              ) : null}

              {/* System-protected note */}
              {isSystem ? (
                <SectionFade delay={170} style={{ marginTop: spacing.lg }}>
                  <Card variant="outline" style={styles.systemCard}>
                    <View style={styles.readonlyRow}>
                      <Ionicons name="shield-checkmark-outline" size={16} color={colors.infoInk} />
                      <AppText variant="caption" style={{ color: colors.infoInk, marginLeft: 6, flex: 1 }}>
                        This is a system-managed location and cannot be deleted.
                      </AppText>
                    </View>
                  </Card>
                </SectionFade>
              ) : null}

              {/* Form error */}
              {errors.form ? (
                <View style={styles.formError}>
                  <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
                  <AppText variant="caption" style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}>
                    {errors.form}
                  </AppText>
                </View>
              ) : null}

              {/* Save */}
              {isManagerial ? (
                <Button
                  label={isCreate ? "Create location" : "Save changes"}
                  size="lg"
                  fullWidth
                  loading={saving}
                  disabled={saving}
                  onPress={onSave}
                  style={styles.submit}
                />
              ) : null}

              <View style={{ height: spacing["4xl"] }} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

function ActiveChip({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <View
      style={[
        styles.activeChip,
        selected && styles.activeChipOn,
        disabled && { opacity: 0.5 },
      ]}
    >
      <AppText
        variant="smallStrong"
        style={{ color: selected ? colors.inkOnBrand : colors.ink }}
        onPress={disabled ? undefined : onPress}
        accessibilityRole="button"
        accessibilityState={{ selected, disabled }}
      >
        {label}
      </AppText>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.statCell}>
      <AppText variant="h3" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </AppText>
      <AppText variant="micro" color="subtle" style={{ marginTop: 2, letterSpacing: 0.4 }}>
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
  topTitle: { flex: 1, marginHorizontal: spacing.sm },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  gap: { marginTop: spacing.md },
  readonlyCard: { borderRadius: radius.xl },
  systemCard: { borderRadius: radius.xl, backgroundColor: colors.infoSubtle, borderColor: colors.infoSubtle },
  readonlyRow: { flexDirection: "row", alignItems: "center" },
  activeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  activeChips: { flexDirection: "row", gap: spacing.sm },
  activeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceInset,
    borderWidth: 1,
    borderColor: colors.border,
  },
  activeChipOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  statsGrid: {
    flexDirection: "row",
    alignItems: "stretch",
    paddingVertical: spacing.xs,
  },
  statCell: { flex: 1, alignItems: "center", paddingVertical: spacing.xs },
  divider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.xs,
  },
  formError: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
  },
  submit: { marginTop: spacing.xl },
});
