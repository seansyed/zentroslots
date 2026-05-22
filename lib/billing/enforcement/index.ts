/**
 * Public barrel for the downgrade enforcement orchestrator.
 * Consumers (CLI scripts, future admin UI, future webhook auto-fire)
 * should import from here rather than reaching into the individual
 * modules.
 */
export { planDowngrade } from "./actionPlan";
export { executeDowngradePlan, type ExecutorOptions } from "./executor";
export { planRecovery, executeRecoveryPlan, type RecoveryExecutorOptions } from "./recovery";
export {
  resolvePolicy,
  resolveAllPolicies,
  DEFAULT_ENFORCEMENT_POLICY,
  type ResolvedPolicy,
} from "./policies";
export type {
  EnforcementMode,
  DowngradeActionKind,
  RecoveryActionKind,
  DowngradeAction,
  RecoveryAction,
  DowngradePlan,
  RecoveryPlan,
  ActionStatus,
  ActionResult,
  ExecutionResult,
} from "./types";
export { ENFORCEMENT_MODES, isEnforcementMode } from "./types";
