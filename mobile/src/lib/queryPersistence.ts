/**
 * queryPersistence — minimal AsyncStorage-backed snapshot of the
 * TanStack Query cache.
 *
 * What it does:
 *   • On hydrate(): reads a JSON blob, replays each entry into the
 *     queryClient as a "stale-but-shown" cached value. The UI paints
 *     instantly with last-known data; refetch happens on mount.
 *   • On wireUpPersistence(): subscribes to the query cache and writes
 *     a debounced snapshot back to storage. Only successful queries
 *     are persisted (we never serialize errors).
 *
 * What it deliberately does NOT do:
 *   • No mutation persistence — mutations should be re-driven by the
 *     user, not silently retried from a saved queue. Offline-first
 *     write semantics live in a separate file when we need them.
 *   • No persistence of auth-coupled queries while logged out — the
 *     queryClient is cleared on signOut so there's nothing to write.
 *
 * Why hand-rolled instead of @tanstack/query-async-storage-persister:
 *   • Two extra npm deps for ~80 lines of work we can read at a glance.
 *   • The official plugin assumes a single hydrate-on-boot lifecycle;
 *     ours runs cleanly inside the existing AuthBoot flow without
 *     blocking the first paint.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QueryClient } from "@tanstack/react-query";

const STORAGE_KEY = "zentromeet:query-cache:v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — older snapshots get discarded
const WRITE_DEBOUNCE_MS = 1500;

type Snapshot = {
  ts: number;
  entries: Array<{
    queryKey: unknown;
    queryHash: string;
    state: {
      data: unknown;
      dataUpdatedAt: number;
      status: "success";
    };
  }>;
};

// Only persist queries that returned data successfully. We deliberately
// skip:
//   • "me"            — auth-coupled; must always reflect live profile/role.
//   • "notifications" — already-read state should never paint from disk.
//   • "services"      — tenant config metadata. Operators expect a
//                       service edit (duration, name, price, color,
//                       isActive) to show up the next time mobile reads
//                       services. Persisting + staleTime would let a
//                       4-minute-old snapshot of `durationMinutes=30`
//                       hide the operator's new `durationMinutes=60`
//                       on the next cold start. Services are small and
//                       fast to refetch — freshness wins.
function shouldPersist(queryKey: unknown): boolean {
  const head = Array.isArray(queryKey) ? queryKey[0] : null;
  if (typeof head !== "string") return false;
  if (head === "me" || head === "notifications" || head === "services") return false;
  return true;
}

export async function hydrateQueryCache(client: QueryClient): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return; // storage unavailable — skip silently
  }
  if (!raw) return;

  let snap: Snapshot | null = null;
  try {
    snap = JSON.parse(raw) as Snapshot;
  } catch {
    // Corrupt — drop it.
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    return;
  }
  if (!snap || typeof snap.ts !== "number") return;
  if (Date.now() - snap.ts > MAX_AGE_MS) {
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    return;
  }

  for (const entry of snap.entries ?? []) {
    if (!shouldPersist(entry.queryKey)) continue;
    if (entry.state?.status !== "success") continue;
    client.setQueryData(entry.queryKey as readonly unknown[], entry.state.data);
    // Backdate dataUpdatedAt so the UI's "X ago" pill reads right and
    // react-query treats the row as stale (triggering a background
    // refetch when the screen mounts).
    const q = client.getQueryCache().find({ queryKey: entry.queryKey as readonly unknown[] });
    if (q && entry.state.dataUpdatedAt) {
      q.state.dataUpdatedAt = entry.state.dataUpdatedAt;
    }
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function wireUpPersistence(client: QueryClient): () => void {
  const queue = () => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      const entries = client
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.status === "success" && shouldPersist(q.queryKey))
        .map((q) => ({
          queryKey: q.queryKey,
          queryHash: q.queryHash,
          state: {
            data: q.state.data,
            dataUpdatedAt: q.state.dataUpdatedAt,
            status: "success" as const,
          },
        }));
      const snap: Snapshot = { ts: Date.now(), entries };
      // Fire-and-forget — never block the UI.
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snap)).catch(() => {});
    }, WRITE_DEBOUNCE_MS);
  };

  const unsub = client.getQueryCache().subscribe((event) => {
    // Only persist on data-bearing transitions; skip "observerAdded"
    // and other read-only events.
    if (event.type === "added" || event.type === "removed" || event.type === "updated") {
      queue();
    }
  });

  return () => {
    unsub();
    if (writeTimer) clearTimeout(writeTimer);
  };
}

export async function clearPersistedQueryCache(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}
