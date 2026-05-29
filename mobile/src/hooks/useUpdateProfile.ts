/**
 * useUpdateProfile — mutation hook for self-service profile editing.
 *
 * Wraps `profileApi.update()` with:
 *   • Optimistic cache writes so the UI snaps to the new value as soon
 *     as the user taps Save, instead of waiting a network round-trip.
 *   • Rollback on error — if the PATCH fails (network, validation,
 *     auth), we restore the previous cache snapshot so the form
 *     doesn't drift out of sync with reality.
 *   • A telemetry breadcrumb on success/failure so post-hoc debugging
 *     has the story.
 *
 * The shape returned by `mutateAsync` is the canonical re-normalised
 * Profile; callers should await it before navigating away so any
 * server-side coercion (e.g. timezone canonicalisation) is reflected.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { profileApi, type Profile, type ProfileUpdate } from "@/api/profile";
import { queryKeys } from "@/lib/query";
import { track } from "@/lib/telemetry";

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation<Profile, Error, ProfileUpdate, { previous?: Profile }>({
    mutationFn: (patch) => profileApi.update(patch),

    // Optimistic update: snapshot the current cache, then apply the
    // patch optimistically. The mutation result will overwrite this
    // again on success — but the user gets the visual snap.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: queryKeys.me });
      const previous = qc.getQueryData<Profile>(queryKeys.me);
      if (previous) {
        qc.setQueryData<Profile>(queryKeys.me, {
          ...previous,
          ...("name" in patch && patch.name !== undefined ? { name: patch.name } : {}),
          ...("timezone" in patch && patch.timezone !== undefined
            ? { timezone: patch.timezone }
            : {}),
        });
      }
      return { previous };
    },

    onError: (err, _patch, ctx) => {
      // Restore the snapshot so the UI doesn't sit on stale optimistic
      // data after a failure.
      if (ctx?.previous) qc.setQueryData<Profile>(queryKeys.me, ctx.previous);
      track("mutation", `Profile update failed: ${err.message}`, "warn");
    },

    onSuccess: (profile) => {
      qc.setQueryData<Profile>(queryKeys.me, profile);
      track("mutation", "Profile updated", "info", {
        name: profile.name,
        timezone: profile.timezone,
      });
    },

    // Always refetch on settle so anything we didn't account for above
    // (avatarUrl, tenant changes, etc.) stays in sync.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
