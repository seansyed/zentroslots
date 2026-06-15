/**
 * /settings/management/departments — departments management surface.
 *
 * Backed by the production departments APIs:
 *   GET  /api/departments   — list with per-department counts
 *   POST /api/departments   — create (admin|manager only)
 *
 * Capabilities on mobile:
 *   • List every department (name + brand color dot + staff/service counts),
 *     searchable by name.
 *   • Tap a row → read-only detail sheet (counts + assigned service names +
 *     description). Edit/delete are NOT available on mobile because the
 *     backend has no /api/departments/[id] route yet — the detail sheet
 *     surfaces a clear "Manage on the web" note instead.
 *   • Managers/admins get a FAB that opens a create Modal (name, brand-color
 *     chips, optional description) with validation + 4xx/error handling.
 *
 * States: loading (Shimmer), empty (EmptyState), error+retry (ErrorState),
 * success (Haptics + close + invalidate). RBAC gating is UX-only — the
 * backend enforces admin|manager on writes regardless.
 */

import * as React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import type { Department } from "@/api/departments";
import { Button } from "@/components/ui/Button";
import { Card, PressableCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FAB } from "@/components/ui/FAB";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Pill } from "@/components/ui/Pill";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { SectionFade } from "@/components/ui/SectionFade";
import { Shimmer } from "@/components/ui/Shimmer";
import { AppText } from "@/components/ui/Text";
import { useCreateDepartment, useDepartments } from "@/hooks/useDepartments";
import { useProfile } from "@/hooks/useProfile";
import { colors, layout, radius, shadows, spacing } from "@/theme";

/** Brand palette for the color picker — there is no native color picker,
 *  so we offer a curated set of theme hexes as tappable chips. */
const COLOR_CHOICES: { hex: string; label: string }[] = [
  { hex: colors.brand, label: "Brand blue" },
  { hex: colors.violet, label: "Violet" },
  { hex: colors.emerald, label: "Emerald" },
  { hex: colors.amber, label: "Amber" },
  { hex: colors.rose, label: "Rose" },
  { hex: colors.sky, label: "Sky" },
  { hex: colors.slate, label: "Slate" },
];

export default function DepartmentsScreen() {
  const router = useRouter();
  const profileQ = useProfile();
  const role = profileQ.data?.role;
  const isManagerial = role === "admin" || role === "manager";

  const q = useDepartments();
  const departments = q.data ?? [];

  const [search, setSearch] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<Department | null>(null);

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return departments;
    return departments.filter((d) => d.name.toLowerCase().includes(needle));
  }, [departments, search]);

  const onRefresh = React.useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    return q.refetch();
  }, [q]);

  return (
    <ScreenContainer padding={false} edges={["top"]}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <IconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            if (router.canGoBack()) router.back();
            else router.replace("/(tabs)/settings");
          }}
        />
        <AppText variant="bodyStrong" align="center" style={styles.topTitle}>
          Departments
        </AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching && !q.isLoading}
            onRefresh={onRefresh}
            tintColor={colors.brand}
          />
        }
      >
        <SectionFade>
          <AppText variant="caption" color="muted" style={styles.intro}>
            Organize staff and services into departments. Counts update
            automatically as you assign people and services.
          </AppText>
        </SectionFade>

        {/* Search */}
        <SectionFade delay={60} style={{ marginTop: spacing.lg }}>
          <Input
            placeholder="Search departments…"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon={
              <Ionicons name="search-outline" size={18} color={colors.inkSubtle} />
            }
            containerStyle={{ marginBottom: 0 }}
          />
        </SectionFade>

        {/* List */}
        <SectionFade delay={100} style={{ marginTop: spacing.lg }}>
          {q.isError ? (
            <Card style={styles.stateCard}>
              <ErrorState
                kind={q.error instanceof ApiError ? q.error.kind : "unknown"}
                description={q.error instanceof Error ? q.error.message : undefined}
                onRetry={() => {
                  void Haptics.impactAsync(
                    Haptics.ImpactFeedbackStyle.Light,
                  ).catch(() => {});
                  void q.refetch();
                }}
              />
            </Card>
          ) : q.isLoading ? (
            <View style={{ gap: spacing.md }}>
              <Shimmer.Card height={84} />
              <Shimmer.Card height={84} />
              <Shimmer.Card height={84} />
              <Shimmer.Card height={84} />
            </View>
          ) : filtered.length === 0 ? (
            <Card variant="outline" style={{ borderRadius: radius["2xl"] }}>
              <EmptyState
                icon={
                  <Ionicons name="git-branch-outline" size={26} color={colors.brand} />
                }
                title={search.trim() ? "No matches" : "No departments yet"}
                body={
                  search.trim()
                    ? "Try a different name."
                    : isManagerial
                      ? "Create your first department with the + button to group staff and services."
                      : "Departments group staff and services. A manager can create them."
                }
              />
            </Card>
          ) : (
            <View style={{ gap: 12 }}>
              {filtered.map((d, i) => (
                <SectionFade key={d.id} delay={100 + Math.min(i, 8) * 30}>
                  <DepartmentRow
                    department={d}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      setDetail(d);
                    }}
                  />
                </SectionFade>
              ))}
            </View>
          )}
        </SectionFade>

        <View style={{ height: spacing["3xl"] }} />
      </ScrollView>

      {/* Create FAB — managerial only (backend enforces it too) */}
      {isManagerial ? (
        <FAB
          icon="add"
          accessibilityLabel="New department"
          onPress={() => {
            void Haptics.selectionAsync().catch(() => {});
            setCreateOpen(true);
          }}
        />
      ) : null}

      <DepartmentCreateModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => setCreateOpen(false)}
      />

      <DepartmentDetailSheet
        department={detail}
        onClose={() => setDetail(null)}
      />
    </ScreenContainer>
  );
}

/* ───────────────────────────── Row ───────────────────────────── */

function DepartmentRow({
  department,
  onPress,
}: {
  department: Department;
  onPress: () => void;
}) {
  const dot = department.color ?? colors.inkSubtle;
  return (
    <PressableCard
      onPress={onPress}
      style={styles.rowCard}
      accessibilityRole="button"
      accessibilityLabel={`${department.name}, ${department.staffCount} staff, ${department.serviceCount} services`}
    >
      <View style={styles.rowInner}>
        <View style={[styles.colorDot, { backgroundColor: dot }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {department.name}
          </AppText>
          <View style={styles.rowMetaRow}>
            <View style={styles.metaItem}>
              <Ionicons name="people-outline" size={13} color={colors.inkSubtle} />
              <AppText variant="micro" color="muted" style={styles.metaText}>
                {department.staffCount} staff
              </AppText>
            </View>
            <View style={styles.metaItem}>
              <Ionicons name="briefcase-outline" size={13} color={colors.inkSubtle} />
              <AppText variant="micro" color="muted" style={styles.metaText}>
                {department.serviceCount} service
                {department.serviceCount === 1 ? "" : "s"}
              </AppText>
            </View>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.inkSubtle} />
      </View>
    </PressableCard>
  );
}

/* ─────────────────────────── Detail ─────────────────────────── */

function DepartmentDetailSheet({
  department,
  onClose,
}: {
  department: Department | null;
  onClose: () => void;
}) {
  const d = department;
  return (
    <Modal
      visible={Boolean(d)}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheetFlex}>
        <View style={styles.sheetHeader}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <AppText variant="body" color="muted">
              Close
            </AppText>
          </Pressable>
          <AppText variant="bodyStrong">Department</AppText>
          <View style={{ width: 52 }} />
        </View>

        {d ? (
          <ScrollView
            contentContainerStyle={styles.sheetBody}
            showsVerticalScrollIndicator={false}
          >
            {/* Title + color */}
            <View style={styles.detailTitleRow}>
              <View
                style={[
                  styles.detailDot,
                  { backgroundColor: d.color ?? colors.inkSubtle },
                ]}
              />
              <AppText variant="h2" style={{ flex: 1 }} numberOfLines={2}>
                {d.name}
              </AppText>
            </View>

            {/* Counts */}
            <Card style={{ marginTop: spacing.lg }}>
              <View style={styles.statsGrid}>
                <StatCell label="Staff" value={d.staffCount} />
                <View style={styles.statDivider} />
                <StatCell label="Services" value={d.serviceCount} />
                <View style={styles.statDivider} />
                <StatCell label="Bookings 30d" value={d.bookingsLast30d} />
              </View>
            </Card>

            {/* Assigned services */}
            <View style={{ marginTop: spacing.lg }}>
              <AppText variant="smallStrong" color="muted" style={styles.detailLabel}>
                ASSIGNED SERVICES
              </AppText>
              {d.assignedServiceNames.length > 0 ? (
                <View style={styles.serviceChips}>
                  {d.assignedServiceNames.map((name) => (
                    <Pill key={name} tone="brand">
                      {name}
                    </Pill>
                  ))}
                  {d.serviceCount > d.assignedServiceNames.length ? (
                    <Pill tone="neutral">
                      +{d.serviceCount - d.assignedServiceNames.length} more
                    </Pill>
                  ) : null}
                </View>
              ) : (
                <AppText variant="small" color="subtle" style={{ marginTop: 6 }}>
                  No services assigned to this department yet.
                </AppText>
              )}
            </View>

            {/* Description */}
            {d.description ? (
              <View style={{ marginTop: spacing.lg }}>
                <AppText
                  variant="smallStrong"
                  color="muted"
                  style={styles.detailLabel}
                >
                  DESCRIPTION
                </AppText>
                <AppText variant="body" color="muted" style={{ marginTop: 6 }}>
                  {d.description}
                </AppText>
              </View>
            ) : null}

            {/* Edit/delete handoff note — no backend route on mobile yet. */}
            <Card variant="outline" style={styles.handoffCard}>
              <View style={styles.handoffRow}>
                <Ionicons
                  name="information-circle-outline"
                  size={18}
                  color={colors.inkMuted}
                />
                <AppText
                  variant="caption"
                  color="muted"
                  style={{ flex: 1, marginLeft: spacing.sm }}
                >
                  Editing and deleting departments is coming soon to mobile.
                  For now, manage those on the web dashboard.
                </AppText>
              </View>
            </Card>

            <View style={{ height: spacing["3xl"] }} />
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.statCell}>
      <AppText variant="h2" style={{ fontVariant: ["tabular-nums"] }}>
        {value}
      </AppText>
      <AppText
        variant="micro"
        color="subtle"
        align="center"
        style={{ marginTop: 2, letterSpacing: 0.3 }}
      >
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}

/* ─────────────────────────── Create ─────────────────────────── */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function DepartmentCreateModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (d: Department) => void;
}) {
  const createMut = useCreateDepartment();
  const saving = createMut.isPending;

  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string | null>(COLOR_CHOICES[0]!.hex);
  const [description, setDescription] = React.useState("");
  const [errors, setErrors] = React.useState<{ name?: string; form?: string }>({});

  React.useEffect(() => {
    if (!visible) return;
    setName("");
    setColor(COLOR_CHOICES[0]!.hex);
    setDescription("");
    setErrors({});
  }, [visible]);

  function validate(): boolean {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name is required";
    else if (name.trim().length > 120) next.name = "Keep it under 120 characters";
    if (color && !HEX_RE.test(color)) next.form = "Pick a valid color";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit() {
    if (saving) return;
    if (!validate()) return;
    void Haptics.selectionAsync().catch(() => {});
    try {
      const created = await createMut.mutateAsync({
        name: name.trim(),
        color: color ?? null,
        description: description.trim() || null,
      });
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
      onCreated(created);
    } catch (e) {
      setErrors({
        form:
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Couldn't create the department. Please try again.",
      });
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Error,
      ).catch(() => {});
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetFlex}
      >
        <View style={styles.sheetHeader}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <AppText variant="body" color="muted">
              Cancel
            </AppText>
          </Pressable>
          <AppText variant="bodyStrong">New department</AppText>
          <View style={{ width: 52 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.sheetBody}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Input
            label="Name"
            placeholder="e.g. Hair & Styling"
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            returnKeyType="next"
            maxLength={120}
          />

          {/* Color chips — no native color picker; curated brand palette. */}
          <View style={{ marginTop: spacing.md }}>
            <AppText
              variant="smallStrong"
              color="muted"
              style={{ marginBottom: spacing.xs }}
            >
              Color
            </AppText>
            <View style={styles.colorRow}>
              {COLOR_CHOICES.map((c) => {
                const selected = color === c.hex;
                return (
                  <Pressable
                    key={c.hex}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      setColor(c.hex);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={c.label}
                    accessibilityState={{ selected }}
                    style={[
                      styles.colorChip,
                      { backgroundColor: c.hex },
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
          </View>

          <Input
            label="Description"
            placeholder="What this department covers (optional)"
            value={description}
            onChangeText={setDescription}
            multiline
            containerStyle={{ marginTop: spacing.md }}
            maxLength={2000}
          />

          {errors.form ? (
            <View style={styles.formError}>
              <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
              <AppText
                variant="caption"
                style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}
              >
                {errors.form}
              </AppText>
            </View>
          ) : null}

          <Button
            label="Create department"
            size="lg"
            fullWidth
            loading={saving}
            disabled={saving}
            onPress={onSubmit}
            style={{ marginTop: spacing.xl }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
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
  topTitle: { flex: 1 },
  scroll: {
    paddingHorizontal: layout.screenPaddingX,
    paddingTop: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  intro: { paddingHorizontal: spacing.xs, lineHeight: 18 },
  stateCard: { borderRadius: radius["2xl"], ...shadows.ambient },

  // Row
  rowCard: { borderRadius: radius["2xl"], ...shadows.floating },
  rowInner: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  colorDot: { width: 14, height: 14, borderRadius: 7 },
  rowMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: 4,
  },
  metaItem: { flexDirection: "row", alignItems: "center" },
  metaText: { marginLeft: 4 },

  // Sheets (detail + create share the chrome)
  sheetFlex: { flex: 1, backgroundColor: colors.surfaceSubtle },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  sheetBody: { padding: spacing.lg, paddingBottom: spacing["3xl"] },

  // Detail
  detailTitleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  detailDot: { width: 18, height: 18, borderRadius: 9 },
  detailLabel: { letterSpacing: 0.4 },
  statsGrid: { flexDirection: "row", alignItems: "stretch", paddingVertical: spacing.xs },
  statCell: { flex: 1, alignItems: "center", paddingVertical: spacing.xs },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginVertical: spacing.xs,
  },
  serviceChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.sm,
  },
  handoffCard: { marginTop: spacing.xl, borderRadius: radius["2xl"] },
  handoffRow: { flexDirection: "row", alignItems: "flex-start" },

  // Create
  colorRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
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
  formError: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
  },
});
