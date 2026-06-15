/**
 * /settings/management/services/[id] — service detail + edit form.
 *
 * Two modes, one screen:
 *   • CREATE — when the route param id === "new". Posts to
 *     POST /api/services (servicesApi.create via useCreateService). The
 *     backend auto-links the creating user as staff so the new service
 *     is immediately bookable.
 *   • EDIT   — when id is a real service id. Pre-fills from
 *     servicesApi.byId (useService), patches via useUpdateService, and
 *     offers delete (useDeleteService) with a confirm dialog.
 *
 * Fields: name, description, duration (minutes), price (entered in
 * dollars, stored as CENTS), color (brand palette chips — there is no
 * native color picker dependency), buffers before/after (minutes), and
 * the active toggle (edit only — new services land active by default).
 *
 * Backend-write constraints honoured here (lib/validation.ts +
 * app/api/services/[id]/route.ts):
 *   • name 1–120, durationMinutes 5–480, price int ≥ 0,
 *     buffers 0–240, color "#rrggbb".
 *   • `color` is PATCH-only — it cannot be sent on CREATE, so on a new
 *     service the chosen color is applied via a follow-up update right
 *     after the create returns the new id.
 *   • minNoticeMinutes / maxAdvanceDays have NO write path in either
 *     route — surfaced as a read-only "managed on web" note, never as
 *     a silently-no-op input.
 *
 * RBAC: this screen is reachable from the managerial-only FAB / rows,
 * and the backend rejects non-managerial writes regardless. Save/Delete
 * affordances render only for admin|manager.
 */

import * as React from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import { servicesApi, type Service, type ServiceUpdateInput } from "@/api/services";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useProfile } from "@/hooks/useProfile";
import {
  useCreateService,
  useDeleteService,
  useService,
  useUpdateService,
} from "@/hooks/useServices";
import { colors, layout, radius, spacing } from "@/theme";

/** Brand-aligned palette for the color chip (no native color picker). */
const COLOR_CHIPS = [
  colors.brand, // #359df3
  colors.violet, // #8b5cf6
  colors.emerald, // #10b981
  colors.amber, // #f59e0b
  colors.rose, // #f43f5e
  colors.sky, // #0ea5e9
  colors.slate, // #64748b
];

function isActiveTrue(s: Service): boolean {
  return s.isActive === 1 || s.isActive === true;
}

type FormErrors = {
  name?: string;
  duration?: string;
  price?: string;
  bufferBefore?: string;
  bufferAfter?: string;
  form?: string;
};

export default function ServiceEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isCreate = id === "new";

  const profileQ = useProfile();
  const role = profileQ.data?.role;
  const isManagerial = role === "admin" || role === "manager";

  // Edit mode loads the service; create mode skips the query entirely.
  const serviceQ = useService(isCreate ? undefined : id);
  const service = serviceQ.data ?? null;

  const createMut = useCreateService();
  const updateMut = useUpdateService(isCreate ? "" : (id ?? ""));
  const deleteMut = useDeleteService(isCreate ? "" : (id ?? ""));
  const saving = createMut.isPending || updateMut.isPending;

  // ── Form state ────────────────────────────────────────────────────
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [duration, setDuration] = React.useState("30"); // minutes
  const [priceDollars, setPriceDollars] = React.useState("0"); // dollars in UI
  const [bufferBefore, setBufferBefore] = React.useState("0");
  const [bufferAfter, setBufferAfter] = React.useState("0");
  const [color, setColor] = React.useState<string>(colors.brand);
  const [active, setActive] = React.useState(true);
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [seeded, setSeeded] = React.useState(false);

  // Seed the form once the service resolves (edit only). Re-seed if the
  // target id changes. Create mode seeds immediately with defaults.
  React.useEffect(() => {
    if (isCreate) {
      if (!seeded) setSeeded(true);
      return;
    }
    if (!service) return;
    setName(service.name ?? "");
    setDescription(service.description ?? "");
    setDuration(String(service.durationMinutes ?? 30));
    setPriceDollars(centsToDollarsString(service.price));
    setBufferBefore(String(service.bufferBefore ?? 0));
    setBufferAfter(String(service.bufferAfter ?? 0));
    setColor(
      service.color && /^#[0-9a-fA-F]{6}$/.test(service.color)
        ? service.color
        : colors.brand,
    );
    setActive(isActiveTrue(service));
    setSeeded(true);
  }, [isCreate, service, seeded]);

  function validate(): boolean {
    const next: FormErrors = {};
    if (!name.trim()) next.name = "Name is required";
    else if (name.trim().length > 120) next.name = "Keep it under 120 characters";

    const dur = Number(duration);
    if (!Number.isInteger(dur) || dur < 5 || dur > 480) {
      next.duration = "5–480 minutes";
    }

    const price = parseDollarsToCents(priceDollars);
    if (price === null || price < 0) next.price = "Enter a valid price";

    const bb = Number(bufferBefore);
    if (!Number.isInteger(bb) || bb < 0 || bb > 240) next.bufferBefore = "0–240";
    const ba = Number(bufferAfter);
    if (!Number.isInteger(ba) || ba < 0 || ba > 240) next.bufferAfter = "0–240";

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSave() {
    if (saving) return;
    if (!validate()) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      return;
    }
    void Haptics.selectionAsync().catch(() => {});

    const durationMinutes = Number(duration);
    const priceCents = parseDollarsToCents(priceDollars) ?? 0;
    const bb = Number(bufferBefore);
    const ba = Number(bufferAfter);

    try {
      if (isCreate) {
        // CREATE: the POST schema does NOT accept `color`, so create
        // first, then patch the color onto the returned id. staffUserIds
        // omitted → backend auto-links the creator (service is bookable).
        const created = await createMut.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
          durationMinutes,
          price: priceCents,
          bufferBefore: bb,
          bufferAfter: ba,
        });
        // Apply the chosen color via PATCH (best-effort — a color failure
        // shouldn't lose the just-created service). We call the api
        // directly because the bound useUpdateService mutation is keyed to
        // the route id ("" in create mode), not the freshly-minted id.
        if (created?.id && color && color !== colors.brand) {
          try {
            await servicesApi.update(created.id, { color });
          } catch {
            /* non-fatal: color can be set again from the edit screen */
          }
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        if (router.canGoBack()) router.back();
        else router.replace("/settings/management/services");
        return;
      }

      // EDIT
      const patch: ServiceUpdateInput = {
        name: name.trim(),
        description: description.trim() || null,
        durationMinutes,
        price: priceCents,
        bufferBefore: bb,
        bufferAfter: ba,
        color,
        isActive: active ? 1 : 0,
      };
      await updateMut.mutateAsync(patch);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      if (router.canGoBack()) router.back();
      else router.replace("/settings/management/services");
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      // Surface the backend message verbatim (plan caps, activation gates,
      // validation). ApiError carries the server's friendly message.
      setErrors({
        form: e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Couldn't save.",
      });
    }
  }

  function onDelete() {
    if (isCreate || !service) return;
    void Haptics.selectionAsync().catch(() => {});
    Alert.alert(
      "Delete service?",
      "If this service has any bookings it will be archived (hidden) to preserve that history. Otherwise it's permanently removed. This can't be undone.",
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
                res.archived ? "Service archived" : "Service deleted",
                res.archived
                  ? "It has bookings, so it was hidden instead of removed."
                  : "The service was removed.",
              );
              if (router.canGoBack()) router.back();
              else router.replace("/settings/management/services");
            } catch (e) {
              void Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Error,
              ).catch(() => {});
              Alert.alert(
                "Couldn't delete",
                e instanceof Error ? e.message : "Please try again.",
              );
            }
          },
        },
      ],
    );
  }

  // ── Loading / not-found (edit mode) ───────────────────────────────
  const showLoading = !isCreate && serviceQ.isLoading;
  const showNotFound = !isCreate && !serviceQ.isLoading && (serviceQ.isError || !service);

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/settings/management/services");
          }}
        />
        <AppText variant="bodyStrong" numberOfLines={1} align="center" style={styles.topTitle}>
          {isCreate ? "New service" : service?.name ?? "Service"}
        </AppText>
        {!isCreate && isManagerial && service ? (
          <IconButton
            icon="trash-outline"
            tone="danger"
            accessibilityLabel="Delete service"
            onPress={onDelete}
          />
        ) : (
          <View style={{ width: 36 }} />
        )}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        {showLoading ? (
          <View style={styles.scroll}>
            <View style={{ gap: spacing.lg }}>
              <Shimmer.Card height={120} />
              <Shimmer.Card height={88} />
              <Shimmer.Card height={120} />
            </View>
          </View>
        ) : showNotFound ? (
          <View style={styles.scroll}>
            <ErrorState
              kind={serviceQ.error instanceof ApiError ? serviceQ.error.kind : "unknown"}
              title="Service not found"
              description={
                serviceQ.error instanceof Error
                  ? serviceQ.error.message
                  : "It may have been deleted."
              }
              onRetry={() => void serviceQ.refetch()}
            />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Bookability rule banner */}
            <SectionFade>
              <Card variant="outline" style={styles.noteCard}>
                <View style={styles.noteRow}>
                  <Ionicons name="information-circle-outline" size={18} color={colors.brand} />
                  <AppText variant="caption" color="muted" style={{ flex: 1, marginLeft: spacing.sm }}>
                    A service must have at least one assigned staff member to be
                    bookable. New services are linked to you automatically. Manage
                    staff assignments on the web dashboard.
                  </AppText>
                </View>
              </Card>
            </SectionFade>

            {/* Core fields */}
            <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
              <Card>
                <Input
                  label="Name"
                  placeholder="e.g. 30-minute consultation"
                  value={name}
                  onChangeText={setName}
                  error={errors.name}
                  autoCapitalize="sentences"
                  editable={isManagerial}
                />
                <Input
                  label="Description"
                  placeholder="What this service includes…"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  editable={isManagerial}
                  containerStyle={{ marginTop: spacing.md }}
                />
              </Card>
            </SectionFade>

            {/* Duration + price */}
            <SectionFade delay={100} style={{ marginTop: spacing.lg }}>
              <Card>
                <View style={styles.twoCol}>
                  <Input
                    label="Duration (min)"
                    placeholder="30"
                    value={duration}
                    onChangeText={(t) => setDuration(t.replace(/[^0-9]/g, ""))}
                    keyboardType="number-pad"
                    error={errors.duration}
                    editable={isManagerial}
                    containerStyle={styles.colItem}
                  />
                  <Input
                    label="Price ($)"
                    placeholder="0"
                    value={priceDollars}
                    onChangeText={(t) => setPriceDollars(t.replace(/[^0-9.]/g, ""))}
                    keyboardType="decimal-pad"
                    error={errors.price}
                    editable={isManagerial}
                    hint="0 = free"
                    containerStyle={styles.colItem}
                  />
                </View>
              </Card>
            </SectionFade>

            {/* Buffers */}
            <SectionFade delay={140} style={{ marginTop: spacing.lg }}>
              <Card>
                <AppText variant="smallStrong" color="muted" style={{ marginBottom: spacing.sm }}>
                  Buffers (minutes)
                </AppText>
                <View style={styles.twoCol}>
                  <Input
                    label="Before"
                    placeholder="0"
                    value={bufferBefore}
                    onChangeText={(t) => setBufferBefore(t.replace(/[^0-9]/g, ""))}
                    keyboardType="number-pad"
                    error={errors.bufferBefore}
                    editable={isManagerial}
                    containerStyle={styles.colItem}
                  />
                  <Input
                    label="After"
                    placeholder="0"
                    value={bufferAfter}
                    onChangeText={(t) => setBufferAfter(t.replace(/[^0-9]/g, ""))}
                    keyboardType="number-pad"
                    error={errors.bufferAfter}
                    editable={isManagerial}
                    containerStyle={styles.colItem}
                  />
                </View>
                <AppText variant="micro" color="subtle" style={{ marginTop: spacing.sm }}>
                  Padding added before and after each booking so back-to-back
                  appointments leave breathing room.
                </AppText>
              </Card>
            </SectionFade>

            {/* Color */}
            <SectionFade delay={180} style={{ marginTop: spacing.lg }}>
              <Card>
                <AppText variant="smallStrong" color="muted" style={{ marginBottom: spacing.sm }}>
                  Color
                </AppText>
                <View style={styles.chipRow}>
                  {COLOR_CHIPS.map((c) => {
                    const selected = c.toLowerCase() === color.toLowerCase();
                    return (
                      <Pressable
                        key={c}
                        disabled={!isManagerial}
                        onPress={() => {
                          void Haptics.selectionAsync().catch(() => {});
                          setColor(c);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Color ${c}`}
                        accessibilityState={{ selected }}
                        style={[
                          styles.colorChip,
                          { backgroundColor: c },
                          selected && styles.colorChipSelected,
                        ]}
                      >
                        {selected ? (
                          <Ionicons name="checkmark" size={16} color={colors.inkOnBrand} />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              </Card>
            </SectionFade>

            {/* Active toggle (edit only) */}
            {!isCreate ? (
              <SectionFade delay={220} style={{ marginTop: spacing.lg }}>
                <Card>
                  <Pressable
                    disabled={!isManagerial}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      setActive((a) => !a);
                    }}
                    style={styles.toggleRow}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: active }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <AppText variant="bodyStrong">Bookable</AppText>
                      <AppText variant="caption" color="muted" style={{ marginTop: 2 }}>
                        {active
                          ? "Customers can book this service."
                          : "Hidden from your booking page."}
                      </AppText>
                    </View>
                    <Pill tone={active ? "success" : "neutral"}>
                      {active ? "Active" : "Paused"}
                    </Pill>
                  </Pressable>
                </Card>
              </SectionFade>
            ) : null}

            {/* Booking-rule note (no write path on mobile) */}
            <SectionFade delay={260} style={{ marginTop: spacing.lg }}>
              <AppText variant="micro" color="subtle" style={{ paddingHorizontal: spacing.xs }}>
                Minimum notice and booking-horizon limits are managed on the web
                dashboard.
              </AppText>
            </SectionFade>

            {errors.form ? (
              <View style={styles.formError}>
                <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
                <AppText variant="caption" style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}>
                  {errors.form}
                </AppText>
              </View>
            ) : null}

            {isManagerial ? (
              <Button
                label={isCreate ? "Create service" : "Save changes"}
                size="lg"
                fullWidth
                loading={saving}
                disabled={saving}
                onPress={onSave}
                style={{ marginTop: spacing.xl }}
              />
            ) : (
              <AppText
                variant="caption"
                color="subtle"
                align="center"
                style={{ marginTop: spacing.xl }}
              >
                Only admins and managers can edit services.
              </AppText>
            )}

            <View style={{ height: spacing["3xl"] }} />
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

function centsToDollarsString(cents: number | null | undefined): string {
  if (typeof cents !== "number" || Number.isNaN(cents)) return "0";
  const d = cents / 100;
  return d % 1 === 0 ? String(d) : d.toFixed(2);
}

/** Parse a dollars string into integer cents. Returns null on garbage. */
function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
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
  noteCard: { borderRadius: radius.xl },
  noteRow: { flexDirection: "row", alignItems: "flex-start" },
  twoCol: { flexDirection: "row", gap: spacing.md },
  colItem: { flex: 1 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  colorChip: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorChipSelected: {
    borderColor: colors.ink,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  formError: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
  },
});
