/**
 * Notification-response (tap) de-duplication.
 *
 * Process each tapped notification AT MOST ONCE across all three app states —
 * closed (cold start), backgrounded, foregrounded.
 *
 * Why: `getLastNotificationResponseAsync()` persistently returns the LAST
 * tapped notification, so a plain cold launch (app killed → opened from the
 * icon, no new tap) re-reads it and would re-navigate every time. On some
 * platforms the tap that launched the app is also delivered to the response
 * listener, so the same tap can fire twice in one session. We dedup on the OS
 * notification identifier:
 *   • an in-memory Set guards within a single app session (cold-start read vs
 *     the foreground listener firing for the same tap);
 *   • a persisted "last handled id" guards ACROSS cold starts (the re-fire bug).
 *
 * Pure + dependency-free so it is unit-testable.
 */
export function shouldProcessResponse(
  identifier: string | null | undefined,
  handledThisSession: ReadonlySet<string>,
  lastPersistedId: string | null | undefined,
): boolean {
  // No id to dedup on → process. Rare, and dropping a real tap is worse than a
  // (theoretical) duplicate when the OS gives us no identifier.
  if (!identifier) return true;
  if (handledThisSession.has(identifier)) return false; // already handled this session
  if (identifier === lastPersistedId) return false; // already handled in a prior session (cold-start re-fire)
  return true;
}
