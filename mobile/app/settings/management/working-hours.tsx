/**
 * /settings/management/working-hours — weekly working-hours editor.
 *
 * Lets a user set their bookable weekly schedule: a per-day enable
 * toggle plus a start/end time (HH:MM). Managerial roles (admin |
 * manager) get a staff picker to edit anyone in the workspace; staff
 * edit only their own (the picker is hidden + the backend enforces it).
 *
 * Backend contract (see app/api/availability/route.ts):
 *   GET /api/availability?userId=  → [{ id, userId, dayOfWeek 0-6,
 *                                       startTime "HH:MM", endTime "HH:MM" }]
 *   PUT /api/availability?userId=  → body { rules: [{ dayOfWeek,
 *                                       startTime, endTime }] } bulk-replaces.
 *
 * The editor models ONE bookable window per day (the common case). The
 * weekly rules array is collapsed to a per-day row on load; on save we
 * emit one rule per enabled day. (Multiple windows per day, lunch
 * breaks, etc. live as availability overrides on the desktop dashboard.)
 *
 * DST-safe: every time is a literal "HH:MM" string. We never construct a
 * Date from device-local time to derive hours — only string comparison
 * for end>start validation. The backend column is a plain time-of-day.
 *
 * States: loading (Shimmer), error+retry (ErrorState), empty is N/A here
 * (the 7-day grid always renders), success (Haptics + nav back).
 */

import * as React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { ApiError } from "@/api/client";
import { type AvailabilityRuleInput } from "@/api/availability";
import { type Staff } from "@/api/staff";
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
import { useAvailability, useSetWeeklySchedule } from "@/hooks/useAvailability";
import { useProfile } from "@/hooks/useProfile";
import { useStaff } from "@/hooks/useStaff";
import { colors, layout, radius, shadows, spacing } from "@/theme";

// ─── Day model ──────────────────────────────────────────────────────
//
// Backend dayOfWeek: 0 = Sunday … 6 = Saturday. We DISPLAY Monday-first
// (the workforce-scheduling convention) but always read/write the
// backend's 0-6 index so nothing is mistranslated on the wire.

type DayState = {
  dayOfWeek: number; // 0-6 backend index
  label: string;
  short: string;
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
};

const DAY_META: { dayOfWeek: number; label: string; short: string }[] = [
  { dayOfWeek: 1, label: "Monday", short: "Mon" },
  { dayOfWeek: 2, label: "Tuesday", short: "Tue" },
  { dayOfWeek: 3, label: "Wednesday", short: "Wed" },
  { dayOfWeek: 4, label: "Thursday", short: "Thu" },
  { dayOfWeek: 5, label: "Friday", short: "Fri" },
  { dayOfWeek: 6, label: "Saturday", short: "Sat" },
  { dayOfWeek: 0, label: "Sunday", short: "Sun" },
];

const DEFAULT_START = "09:00";
const DEFAULT_END = "17:00";

function blankWeek(): DayState[] {
  return DAY_META.map((d) => ({
    dayOfWeek: d.dayOfWeek,
    label: d.label,
    short: d.short,
    // Default the 5-day work week on so a brand-new schedule is useful
    // out of the box; weekend off.
    enabled: d.dayOfWeek >= 1 && d.dayOfWeek <= 5,
    start: DEFAULT_START,
    end: DEFAULT_END,
  }));
}

/** Strict "HH:MM" 00:00–23:59 validator. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function isValidHHMM(v: string): boolean {
  return HHMM_RE.test(v);
}
/** Minutes since midnight, for end>start comparison. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

type RowError = { start?: string; end?: string; range?: string };

const isManagerialRole = (role?: string) => role === "admin" || role === "manager";

export default function WorkingHoursScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const profile = profileQ.data;
  const isManagerial = isManagerialRole(profile?.role);

  // Staff picker (managerial only). undefined target = "self".
  const [targetUserId, setTargetUserId] = React.useState<string | undefined>(undefined);
  const staffQ = useStaff();

  const availabilityQ = useAvailability(targetUserId);
  const saveMut = useSetWeeklySchedule(targetUserId);

  const [week, setWeek] = React.useState<DayState[]>(blankWeek);
  const [errors, setErrors] = React.useState<Record<number, RowError>>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  // The week we hydrated from the server — drives the dirty check so we
  // never PUT an unchanged schedule and can warn on unsaved back-nav.
  const baselineRef = React.useRef<string>("");

  // Hydrate the editor whenever availability lands/refreshes. We collapse
  // the rules array to one row per day (first rule wins if the backend
  // ever stored multiple windows — the desktop handles split windows).
  React.useEffect(() => {
    if (!availabilityQ.data) return;
    const next = blankWeek().map((d) => {
      const rule = availabilityQ.data!.find((r) => r.dayOfWeek === d.dayOfWeek);
      if (rule) {
        return { ...d, enabled: true, start: rule.startTime, end: rule.endTime };
      }
      // No rule for this day → day is off. Keep sensible default times
      // so re-enabling pre-fills a usable window.
      return { ...d, enabled: false };
    });
    setWeek(next);
    baselineRef.current = serialize(next);
    setErrors({});
    setSubmitError(null);
    // Reset dirty baseline each time we switch target user or refetch.
  }, [availabilityQ.data]);

  const dirty = serialize(week) !== baselineRef.current && baselineRef.current !== "";

  function updateDay(dayOfWeek: number, patch: Partial<DayState>) {
    setWeek((prev) =>
      prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)),
    );
    setSubmitError(null);
  }

  function toggleDay(dayOfWeek: number, enabled: boolean) {
    void Haptics.selectionAsync().catch(() => {});
    setWeek((prev) =>
      prev.map((d) => {
        if (d.dayOfWeek !== dayOfWeek) return d;
        // Re-enabling a day with blank times → restore defaults.
        const start = enabled && !d.start ? DEFAULT_START : d.start;
        const end = enabled && !d.end ? DEFAULT_END : d.end;
        return { ...d, enabled, start, end };
      }),
    );
    // Clear any stale error for a day being turned off.
    if (!enabled) {
      setErrors((prev) => {
        const { [dayOfWeek]: _omit, ...rest } = prev;
        return rest;
      });
    }
    setSubmitError(null);
  }

  /** Copy the first enabled day's window to every enabled day. */
  function copyToAll() {
    const source = week.find((d) => d.enabled);
    if (!source) {
      Alert.alert("Nothing to copy", "Enable at least one day first.");
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setWeek((prev) =>
      prev.map((d) =>
        d.enabled ? { ...d, start: source.start, end: source.end } : d,
      ),
    );
    setErrors({});
    setSubmitError(null);
  }

  /** Validate enabled rows; returns the rule payload when valid. */
  function validate(): AvailabilityRuleInput[] | null {
    const nextErrors: Record<number, RowError> = {};
    const rules: AvailabilityRuleInput[] = [];

    for (const d of week) {
      if (!d.enabled) continue;
      const rowErr: RowError = {};
      const startOk = isValidHHMM(d.start);
      const endOk = isValidHHMM(d.end);
      if (!startOk) rowErr.start = "Use HH:MM (00:00–23:59)";
      if (!endOk) rowErr.end = "Use HH:MM (00:00–23:59)";
      if (startOk && endOk && toMinutes(d.end) <= toMinutes(d.start)) {
        rowErr.range = "End must be after start";
      }
      if (rowErr.start || rowErr.end || rowErr.range) {
        nextErrors[d.dayOfWeek] = rowErr;
      } else {
        rules.push({
          dayOfWeek: d.dayOfWeek,
          startTime: d.start,
          endTime: d.end,
        });
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return null;
    return rules;
  }

  async function onSave() {
    setSubmitError(null);
    const rules = validate();
    if (rules === null) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
        () => {},
      );
      return;
    }
    void Haptics.selectionAsync().catch(() => {});
    try {
      await saveMut.mutateAsync(rules);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => {},
      );
      // Sync the dirty baseline so the unsaved-changes guard clears.
      baselineRef.current = serialize(week);
      goBack();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Couldn't save your hours. Try again.";
      setSubmitError(message);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
        () => {},
      );
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/settings");
  }

  function confirmBack() {
    void Haptics.selectionAsync().catch(() => {});
    if (!dirty) return goBack();
    Alert.alert(
      "Discard changes?",
      "You have unsaved changes to your working hours.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: goBack },
      ],
      { cancelable: true },
    );
  }

  // Switching the staff target mid-edit would silently drop changes —
  // confirm first.
  function selectStaff(id: string | undefined) {
    if (id === targetUserId) return;
    const apply = () => {
      void Haptics.selectionAsync().catch(() => {});
      setTargetUserId(id);
      // Force a clean reload of the new target's schedule.
      baselineRef.current = "";
      setErrors({});
      setSubmitError(null);
    };
    if (dirty) {
      Alert.alert(
        "Discard changes?",
        "Switching staff will discard your unsaved working-hours changes.",
        [
          { text: "Keep editing", style: "cancel" },
          { text: "Discard", style: "destructive", onPress: apply },
        ],
        { cancelable: true },
      );
    } else {
      apply();
    }
  }

  const staffList: Staff[] = staffQ.data ?? [];
  const selectedStaffName = targetUserId
    ? staffList.find((s) => s.id === targetUserId)?.name ?? "Selected staff"
    : profile?.name ?? "You";

  const loading = availabilityQ.isLoading && !availabilityQ.data;

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Topbar */}
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="Back" onPress={confirmBack} />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          Working hours
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SectionFade>
          <AppText variant="caption" color="muted" style={styles.intro}>
            Set the weekly hours you accept bookings. Times use your
            workspace timezone — new bookings only land inside these
            windows.
          </AppText>
        </SectionFade>

        {/* Timezone + (managerial) staff picker */}
        <SectionFade delay={40} style={{ marginTop: spacing.lg }}>
          <Card style={styles.metaCard} padding={spacing.lg}>
            <View style={styles.metaRow}>
              <Ionicons name="time-outline" size={16} color={colors.inkMuted} />
              <AppText variant="small" color="muted" style={{ marginLeft: 6 }}>
                Timezone
              </AppText>
              <View style={{ flex: 1 }} />
              <Pill tone="neutral">{profile?.timezone ?? "UTC"}</Pill>
            </View>

            {isManagerial ? (
              <View style={{ marginTop: spacing.md }}>
                <AppText variant="smallStrong" color="muted" style={{ marginBottom: spacing.sm }}>
                  Editing schedule for
                </AppText>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.staffChips}
                >
                  <StaffChip
                    label={`${profile?.name ?? "You"} (you)`}
                    active={targetUserId === undefined}
                    onPress={() => selectStaff(undefined)}
                  />
                  {staffQ.isLoading ? (
                    <Shimmer width={120} height={36} style={{ borderRadius: radius.full }} />
                  ) : (
                    staffList
                      .filter((s) => s.id !== profile?.id)
                      .map((s) => (
                        <StaffChip
                          key={s.id}
                          label={s.name}
                          active={targetUserId === s.id}
                          onPress={() => selectStaff(s.id)}
                        />
                      ))
                  )}
                </ScrollView>
                {staffQ.isError ? (
                  <AppText variant="caption" color="danger" style={{ marginTop: spacing.sm }}>
                    Couldn't load staff — you can still edit your own hours.
                  </AppText>
                ) : null}
              </View>
            ) : null}
          </Card>
        </SectionFade>

        {/* Day grid */}
        <SectionFade delay={80} style={{ marginTop: spacing.lg }}>
          {loading ? (
            <View style={{ gap: spacing.sm }}>
              {DAY_META.map((d) => (
                <Shimmer.Card key={d.dayOfWeek} height={64} />
              ))}
            </View>
          ) : availabilityQ.isError ? (
            <Card style={styles.errorCard}>
              <ErrorState
                kind={
                  availabilityQ.error instanceof ApiError
                    ? availabilityQ.error.kind
                    : "unknown"
                }
                description={
                  availabilityQ.error instanceof Error
                    ? availabilityQ.error.message
                    : undefined
                }
                onRetry={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                  void availabilityQ.refetch();
                }}
              />
            </Card>
          ) : (
            <>
              <View style={styles.copyRow}>
                <AppText variant="eyebrow" color="muted">
                  {selectedStaffName.toUpperCase()}'S WEEK
                </AppText>
                <Pressable
                  onPress={copyToAll}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Copy first day's hours to all enabled days"
                >
                  <View style={styles.copyChip}>
                    <Ionicons name="copy-outline" size={13} color={colors.brand} />
                    <AppText variant="smallStrong" style={{ color: colors.brand, marginLeft: 4 }}>
                      Copy to all
                    </AppText>
                  </View>
                </Pressable>
              </View>

              <View style={{ gap: spacing.sm }}>
                {week.map((d) => (
                  <DayRow
                    key={d.dayOfWeek}
                    day={d}
                    error={errors[d.dayOfWeek]}
                    onToggle={(v) => toggleDay(d.dayOfWeek, v)}
                    onChangeStart={(v) => {
                      updateDay(d.dayOfWeek, { start: v });
                      clearRowError(setErrors, d.dayOfWeek);
                    }}
                    onChangeEnd={(v) => {
                      updateDay(d.dayOfWeek, { end: v });
                      clearRowError(setErrors, d.dayOfWeek);
                    }}
                  />
                ))}
              </View>
            </>
          )}
        </SectionFade>

        {submitError ? (
          <SectionFade delay={20} style={{ marginTop: spacing.lg }}>
            <View style={styles.submitError}>
              <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
              <AppText
                variant="small"
                style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}
              >
                {submitError}
              </AppText>
            </View>
          </SectionFade>
        ) : null}

        <View style={{ height: spacing["4xl"] }} />
      </ScrollView>

      {/* Sticky save bar */}
      {!loading && !availabilityQ.isError ? (
        <View style={styles.saveBar}>
          <Button
            label={saveMut.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            variant="primary"
            size="lg"
            fullWidth
            loading={saveMut.isPending}
            disabled={saveMut.isPending || !dirty}
            onPress={onSave}
          />
        </View>
      ) : null}
    </ScreenContainer>
  );
}

// ─── Serialization helper (dirty check) ─────────────────────────────

function serialize(week: DayState[]): string {
  return week
    .map((d) => `${d.dayOfWeek}:${d.enabled ? 1 : 0}:${d.start}:${d.end}`)
    .join("|");
}

function clearRowError(
  setErrors: React.Dispatch<React.SetStateAction<Record<number, RowError>>>,
  dayOfWeek: number,
) {
  setErrors((prev) => {
    if (!prev[dayOfWeek]) return prev;
    const { [dayOfWeek]: _omit, ...rest } = prev;
    return rest;
  });
}

// ─── Day row ────────────────────────────────────────────────────────

type DayRowProps = {
  day: DayState;
  error?: RowError;
  onToggle: (enabled: boolean) => void;
  onChangeStart: (v: string) => void;
  onChangeEnd: (v: string) => void;
};

function DayRow({ day, error, onToggle, onChangeStart, onChangeEnd }: DayRowProps) {
  return (
    <Card style={styles.dayCard} padding={spacing.md}>
      <View style={styles.dayHeader}>
        <AppText
          variant="bodyStrong"
          style={{ color: day.enabled ? colors.ink : colors.inkSubtle }}
        >
          {day.label}
        </AppText>
        <View style={{ flex: 1 }} />
        {!day.enabled ? (
          <AppText variant="caption" color="subtle" style={{ marginRight: spacing.sm }}>
            Off
          </AppText>
        ) : null}
        <Switch
          value={day.enabled}
          onValueChange={onToggle}
          trackColor={{ false: colors.surfaceInset, true: colors.brand }}
          thumbColor={colors.surface}
          ios_backgroundColor={colors.surfaceInset}
          accessibilityLabel={`Toggle ${day.label}`}
        />
      </View>

      {day.enabled ? (
        <>
          <View style={styles.timeRow}>
            <Input
              label="Start"
              value={day.start}
              onChangeText={onChangeStart}
              error={error?.start}
              placeholder="09:00"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={5}
              containerStyle={styles.timeInput}
            />
            <View style={styles.timeDash}>
              <Ionicons name="arrow-forward" size={16} color={colors.inkSubtle} />
            </View>
            <Input
              label="End"
              value={day.end}
              onChangeText={onChangeEnd}
              error={error?.end}
              placeholder="17:00"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={5}
              containerStyle={styles.timeInput}
            />
          </View>
          {error?.range ? (
            <AppText variant="caption" color="danger" style={{ marginTop: spacing.xs }}>
              {error.range}
            </AppText>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

// ─── Staff chip ─────────────────────────────────────────────────────

function StaffChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.staffChip, active && styles.staffChipActive]}
    >
      <AppText
        variant="smallStrong"
        numberOfLines={1}
        style={{ color: active ? colors.inkOnBrand : colors.inkMuted }}
      >
        {label}
      </AppText>
    </Pressable>
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
  },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  intro: {
    paddingHorizontal: spacing.xs,
    lineHeight: 18,
  },
  metaCard: {
    borderRadius: radius["2xl"],
    ...shadows.ambient,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  staffChips: {
    gap: spacing.sm,
    paddingVertical: 2,
    paddingRight: spacing.sm,
  },
  staffChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceInset,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    maxWidth: 200,
  },
  staffChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  copyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
  },
  copyChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.brandSubtle,
  },
  dayCard: {
    borderRadius: radius.xl,
    ...shadows.ambient,
  },
  dayHeader: {
    flexDirection: "row",
    alignItems: "center",
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  timeInput: {
    flex: 1,
  },
  timeDash: {
    height: 48,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 22, // align with input field (below the label)
  },
  errorCard: {
    borderRadius: radius["2xl"],
    ...shadows.ambient,
  },
  submitError: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
  },
  saveBar: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surfaceSubtle,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
