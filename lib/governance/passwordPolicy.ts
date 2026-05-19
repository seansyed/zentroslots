/**
 * Per-tenant password policy validator.
 *
 * Used by the password-reset endpoint + future password-change flow.
 * Backward-compatible: when a tenant has no governance row, falls back
 * to the platform default (10-char minimum, no complexity) — identical
 * to what the codebase enforced before this module existed.
 *
 * Pure — never throws, returns structured results.
 */

import type { EffectiveGovernancePolicy } from "./types";
import { PLATFORM_DEFAULTS } from "./types";

export type PolicyValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Validate a CANDIDATE password against the tenant's policy. */
export function validatePasswordAgainstPolicy(
  password: string,
  policy: EffectiveGovernancePolicy["password"]
): PolicyValidationResult {
  if (typeof password !== "string") return { ok: false, reason: "Invalid password." };
  if (password.length < policy.minLength) {
    return { ok: false, reason: `Password must be at least ${policy.minLength} characters.` };
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    return { ok: false, reason: "Password must include at least one uppercase letter." };
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    return { ok: false, reason: "Password must include at least one lowercase letter." };
  }
  if (policy.requireDigit && !/\d/.test(password)) {
    return { ok: false, reason: "Password must include at least one digit." };
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, reason: "Password must include at least one symbol." };
  }
  return { ok: true };
}

/** Reject a CANDIDATE policy update (the inputs an admin would PATCH).
 *  Prevents an admin from accidentally locking the workspace into an
 *  unsafe config (e.g. minLength < 8 or requiring a symbol AND digit
 *  with minLength = 8 = barely usable). */
export function validatePolicyUpdate(input: {
  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireLowercase?: boolean;
  passwordRequireDigit?: boolean;
  passwordRequireSymbol?: boolean;
  passwordMaxAgeDays?: number;
  sessionMaxAgeDays?: number;
  suspiciousLoginSensitivity?: string;
}): PolicyValidationResult {
  if (input.passwordMinLength !== undefined) {
    if (!Number.isInteger(input.passwordMinLength)) {
      return { ok: false, reason: "passwordMinLength must be an integer." };
    }
    if (input.passwordMinLength < 8) {
      return { ok: false, reason: "passwordMinLength must be at least 8 (industry minimum)." };
    }
    if (input.passwordMinLength > 128) {
      return { ok: false, reason: "passwordMinLength must be at most 128." };
    }
  }
  if (input.passwordMaxAgeDays !== undefined) {
    if (!Number.isInteger(input.passwordMaxAgeDays)) {
      return { ok: false, reason: "passwordMaxAgeDays must be an integer." };
    }
    if (
      input.passwordMaxAgeDays !== 0 &&
      (input.passwordMaxAgeDays < 30 || input.passwordMaxAgeDays > 365)
    ) {
      return { ok: false, reason: "passwordMaxAgeDays must be 0 (disabled) or 30..365." };
    }
  }
  if (input.sessionMaxAgeDays !== undefined) {
    if (!Number.isInteger(input.sessionMaxAgeDays)) {
      return { ok: false, reason: "sessionMaxAgeDays must be an integer." };
    }
    if (
      input.sessionMaxAgeDays !== 0 &&
      (input.sessionMaxAgeDays < 1 || input.sessionMaxAgeDays > 30)
    ) {
      return { ok: false, reason: "sessionMaxAgeDays must be 0 (platform default) or 1..30." };
    }
  }
  if (
    input.suspiciousLoginSensitivity !== undefined &&
    !["low", "medium", "high"].includes(input.suspiciousLoginSensitivity)
  ) {
    return { ok: false, reason: "suspiciousLoginSensitivity must be low | medium | high." };
  }
  return { ok: true };
}

/** Build the password-policy slice from raw fields. Used by the
 *  reset-password route to enforce the tenant policy at consume time. */
export function defaultPasswordPolicy(): EffectiveGovernancePolicy["password"] {
  return {
    minLength: PLATFORM_DEFAULTS.passwordMinLength,
    requireUppercase: PLATFORM_DEFAULTS.passwordRequireUppercase,
    requireLowercase: PLATFORM_DEFAULTS.passwordRequireLowercase,
    requireDigit: PLATFORM_DEFAULTS.passwordRequireDigit,
    requireSymbol: PLATFORM_DEFAULTS.passwordRequireSymbol,
    maxAgeDays: PLATFORM_DEFAULTS.passwordMaxAgeDays,
  };
}
