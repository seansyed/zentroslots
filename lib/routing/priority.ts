/**
 * Priority mode.
 *
 * Iterate the configured priority list IN ORDER and pick the first
 * staff who is currently eligible. If none of the priority list is
 * eligible, returns null (the orchestrator emits "no_available_staff"
 * and the caller decides what to surface to the customer).
 *
 * Pure — no DB. Tests drive it directly.
 */

export function pickPriority(args: {
  /** Ordered staff ids from the rule's priorityOrder. */
  priorityOrder: string[];
  /** Currently eligible staff for the requested window. */
  eligible: string[];
}): string | null {
  if (args.priorityOrder.length === 0) return null;
  const eligibleSet = new Set(args.eligible);
  for (const id of args.priorityOrder) {
    if (eligibleSet.has(id)) return id;
  }
  return null;
}
