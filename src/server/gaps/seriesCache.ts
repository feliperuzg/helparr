import 'server-only';

import type { SeriesSummary } from '@/lib/types';
import type { ClientResult, GapClient } from '@/server/clients/types';

/**
 * The library join, cached per instance (ADR-3, REQ-GAPS-016).
 *
 * A Sonarr missing-episode record carries `seriesId` and nothing else — no
 * series title, no root path — and neither *arr returns a quality profile
 * *name* anywhere on a missing record. Both are needed on every row, so
 * without a cache the grid would either re-read the whole library on every
 * refresh or show a wall of bare ids.
 *
 * Three rules, and the third is the one that matters:
 *
 * 1. A ten-minute TTL, because a library changes slowly.
 * 2. An explicit refresh, because the operator who just added a series should
 *    not have to wait out a TTL to see it.
 * 3. Invalidation on *write*, because helparr itself is the one thing that can
 *    make this cache wrong without warning. An attach that lands changes what
 *    the library contains; serving the pre-attach snapshot afterwards would be
 *    showing the operator the state their own action just invalidated.
 */

const TTL_MS = 10 * 60_000;

export interface LibrarySnapshot {
  /** Sonarr only — empty on Radarr, whose missing records are self-contained. */
  series: Map<number, SeriesSummary>;
  /** Quality profile id → display name, for the `Wanted` column. */
  profiles: Map<number, string>;
  /** When this snapshot was read, for the "cached Nm ago" line. */
  readAt: string;
}

interface Entry {
  snapshot: LibrarySnapshot;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/** The cached snapshot, or null when absent or past its TTL. */
export function getCachedLibrary(instanceId: string, now = Date.now()): LibrarySnapshot | null {
  const entry = cache.get(instanceId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    // Dropped rather than returned-and-marked-stale: a caller that has to
    // remember to check an `isStale` flag will eventually forget to.
    cache.delete(instanceId);
    return null;
  }
  return entry.snapshot;
}

export function setCachedLibrary(
  instanceId: string,
  snapshot: LibrarySnapshot,
  now = Date.now(),
): void {
  cache.set(instanceId, { snapshot, expiresAt: now + TTL_MS });
}

/**
 * Called after every successful write to this instance (rule 3 above), never
 * on a read. Dropping the entry costs one library re-read; serving a snapshot
 * the operator's own attach has already invalidated costs their trust in the
 * screen.
 */
export function invalidateLibrary(instanceId: string): void {
  cache.delete(instanceId);
}

/** Test seam — the cache is process-lifetime state, like `lastSuccessfulRead`. */
export function resetLibraryCache(): void {
  cache.clear();
}

/**
 * The cached library for one instance, reading it only when the cache misses
 * or the caller explicitly asks for a refresh.
 *
 * The two reads run together: they are independent, and a Sonarr with a
 * thousand series is slow enough that serialising them would be felt.
 */
export async function readLibrary(
  instanceId: string,
  client: GapClient,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ClientResult<LibrarySnapshot>> {
  if (!options.force) {
    const cached = getCachedLibrary(instanceId);
    if (cached) return { ok: true, value: cached };
  }

  const [series, profiles] = await Promise.all([
    client.series(options.signal),
    client.qualityProfiles(options.signal),
  ]);

  // The series read is load-bearing — without it a Sonarr grid has no group
  // headings at all. A failed *profile* read only costs one column, so it
  // degrades to an empty map rather than failing the whole snapshot.
  if (!series.ok) return series;

  const snapshot: LibrarySnapshot = {
    series: new Map(series.value.map((entry) => [entry.id, entry])),
    profiles: new Map(
      profiles.ok ? profiles.value.map((profile) => [profile.id, profile.name]) : [],
    ),
    readAt: new Date().toISOString(),
  };

  setCachedLibrary(instanceId, snapshot);
  return { ok: true, value: snapshot };
}
