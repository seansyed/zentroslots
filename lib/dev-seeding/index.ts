/**
 * Dev-seeding public API surface. Import from here, not from
 * sub-modules — keeps the entry point stable and lets us refactor
 * internals without touching call sites.
 */

export {
  runSimulation,
  resetSimulation,
  getSimulationStatus,
  type SeedReport,
  type SimulationMode,
} from "./seeder";
export {
  injectFailure,
  injectChurnSpike,
  injectBookingSpike,
  injectReminderFailures,
  injectOauthFailures,
  injectWebhookFlood,
  type InjectorKind,
} from "./injectors";
export { isSeedingEnabled, SEEDED_BY_MARKER } from "./guards";
export { ARCHETYPES, type Archetype } from "./archetypes";
