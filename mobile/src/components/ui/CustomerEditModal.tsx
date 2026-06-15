/**
 * CustomerEditModal — create OR edit a customer.
 *
 * Backed by the production customer APIs (POST /api/customers,
 * PATCH /api/customers/:id) via useCreateCustomer / useUpdateCustomer.
 * Tenant isolation + validation are enforced server-side; this form
 * mirrors the backend zod schema for fast client-side feedback.
 *
 * NOTE: the backend PATCH schema does NOT accept `email`, so on EDIT the
 * email field is shown read-only (email is set once, at create time).
 */

import * as React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { ApiError } from "@/api/client";
import type { Customer, CustomerStatus } from "@/api/customers";
import { useCreateCustomer, useUpdateCustomer } from "@/hooks/useCustomers";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AppText } from "@/components/ui/Text";
import { colors, radius, spacing } from "@/theme";

type Props = {
  visible: boolean;
  /** Provide to edit; omit to create. */
  customer?: Customer | null;
  onClose: () => void;
  onSaved?: (customer: Customer) => void;
};

const STATUS_OPTIONS: { value: CustomerStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "vip", label: "VIP" },
  { value: "prospect", label: "Prospect" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CustomerEditModal({ visible, customer, onClose, onSaved }: Props) {
  const isEdit = Boolean(customer);
  const createMut = useCreateCustomer();
  const updateMut = useUpdateCustomer(customer?.id ?? "");
  const saving = createMut.isPending || updateMut.isPending;

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [tagsText, setTagsText] = React.useState("");
  const [status, setStatus] = React.useState<CustomerStatus>("active");
  const [errors, setErrors] = React.useState<{ name?: string; email?: string; form?: string }>({});

  // (Re)seed the form whenever the modal opens or the target changes.
  React.useEffect(() => {
    if (!visible) return;
    setName(customer?.name ?? "");
    setEmail(customer?.email ?? "");
    setPhone(customer?.phone ?? "");
    setNotes((customer as Customer & { notes?: string | null })?.notes ?? "");
    setTagsText((customer?.tags ?? []).join(", "));
    setStatus(
      customer?.status && customer.status !== "archived" ? customer.status : "active",
    );
    setErrors({});
  }, [visible, customer]);

  function validate(): boolean {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name is required";
    if (!isEdit) {
      if (!email.trim()) next.email = "Email is required";
      else if (!EMAIL_RE.test(email.trim())) next.email = "Enter a valid email";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function parseTags(): string[] | undefined {
    const list = tagsText
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return list.length ? list : undefined;
  }

  async function onSubmit() {
    if (saving) return;
    if (!validate()) return;
    void Haptics.selectionAsync().catch(() => {});
    const tags = parseTags();
    try {
      let result: Customer;
      if (isEdit && customer) {
        result = await updateMut.mutateAsync({
          name: name.trim(),
          phone: phone.trim() || null,
          notes: notes.trim() || null,
          status,
          tags,
        });
      } else {
        result = await createMut.mutateAsync({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || null,
          notes: notes.trim() || null,
          status,
          tags,
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSaved?.(result);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErrors({ email: "A customer with this email already exists" });
      } else {
        setErrors({
          form: e instanceof Error ? e.message : "Couldn't save. Please try again.",
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
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
        style={styles.flex}
      >
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Cancel">
            <AppText variant="body" color="muted">
              Cancel
            </AppText>
          </Pressable>
          <AppText variant="bodyStrong">{isEdit ? "Edit customer" : "New customer"}</AppText>
          <View style={{ width: 52 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Input
            label="Full name"
            placeholder="Jane Doe"
            value={name}
            onChangeText={setName}
            error={errors.name}
            autoCapitalize="words"
            returnKeyType="next"
          />
          <Input
            label={isEdit ? "Email (can't be changed)" : "Email"}
            placeholder="jane@example.com"
            value={email}
            onChangeText={setEmail}
            error={errors.email}
            editable={!isEdit}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            containerStyle={styles.gap}
          />
          <Input
            label="Phone"
            placeholder="+1 555 123 4567"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            containerStyle={styles.gap}
          />

          <View style={styles.gap}>
            <AppText variant="smallStrong" color="muted" style={{ marginBottom: spacing.xs }}>
              Status
            </AppText>
            <View style={styles.statusRow}>
              {STATUS_OPTIONS.map((opt) => {
                const selected = status === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => {
                      void Haptics.selectionAsync().catch(() => {});
                      setStatus(opt.value);
                    }}
                    style={[styles.statusChip, selected && styles.statusChipActive]}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <AppText
                      variant="smallStrong"
                      style={{ color: selected ? colors.inkOnBrand : colors.ink }}
                    >
                      {opt.label}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <Input
            label="Tags"
            placeholder="vip, referral (comma separated)"
            value={tagsText}
            onChangeText={setTagsText}
            autoCapitalize="none"
            containerStyle={styles.gap}
            hint="Separate with commas"
          />
          <Input
            label="Notes"
            placeholder="Anything worth remembering…"
            value={notes}
            onChangeText={setNotes}
            multiline
            containerStyle={styles.gap}
          />

          {errors.form ? (
            <View style={styles.formError}>
              <Ionicons name="alert-circle" size={16} color={colors.dangerInk} />
              <AppText variant="caption" style={{ color: colors.dangerInk, marginLeft: 6, flex: 1 }}>
                {errors.form}
              </AppText>
            </View>
          ) : null}

          <Button
            label={isEdit ? "Save changes" : "Create customer"}
            size="lg"
            fullWidth
            loading={saving}
            disabled={saving}
            onPress={onSubmit}
            style={styles.submit}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surfaceSubtle },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  body: {
    padding: spacing.lg,
    paddingBottom: spacing["3xl"],
  },
  gap: { marginTop: spacing.md },
  statusRow: { flexDirection: "row", gap: spacing.sm },
  statusChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceInset,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statusChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  formError: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.dangerSubtle,
    borderRadius: radius.md,
  },
  submit: { marginTop: spacing.xl },
});
