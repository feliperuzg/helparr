import 'server-only';

import type {
  ArrCustomFormatRef,
  ArrQualityProfileDetail,
  ClientFailureKind,
  DecisionsClient,
} from '@/server/clients/types';
import { countsAsBreakerFailure, isDecisionsClient } from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen } from '@/server/resilience/breaker';

/**
 * Decisions config cache (ADR-11, REQ-DEC-007) — `seriesCache.ts`'s terms,
 * applied to custom formats and quality profiles instead of the Sonarr library
 * join:
 *
 * 1. A ten-minute TTL, because custom formats and profiles change rarely.
 * 2. An explicit refresh, bypassing the TTL rather than waiting it out.
 * 3. Invalidation on write — called from force import (T8) and from gaps'
 *    attach (below), because those are the two writes that can change what an
 *    instance's own decision engine does next.
 * 4. Concurrent reads share one upstream fetch (REQ-DEC-007's AC9: twenty
 *    inspector opens cost at most one config read per instance), tracked
 *    separately from the TTL cache so a refresh in flight is still joinable.
 */

const TTL_MS = 10 * 60_000;

export interface DecisionsConfig {
  customFormats: ArrCustomFormatRef[];
  profiles: ArrQualityProfileDetail[];
  /** ISO — when this snapshot was read, so the panel can say how old it is. */
  fetchedAt: string;
}

/**
 * `no-instance` / `not-decisions-client` cover resolution before any request is
 * made; everything else is `ClientFailureKind` — the same vocabulary every
 * other per-instance read in this codebase reports failure in. `circuit-open`
 * is folded into `unreachable` here, as `search/grab.ts`'s `readThrough` does:
 * `ClientFailureKind` itself excludes it (clients/types.ts), because no client
 * can report that condition about itself.
 */
export type DecisionsFailureKind = ClientFailureKind | 'no-instance' | 'not-decisions-client';

export interface DecisionsFailure {
  kind: DecisionsFailureKind;
  reason: string;
}

export type DecisionsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DecisionsFailure };

interface Entry {
  config: DecisionsConfig;
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<DecisionsResult<DecisionsConfig>>>();

/** The cached config, or null when absent or past its TTL. */
export function getCachedDecisionsConfig(instanceId: string, now = Date.now()): DecisionsConfig | null {
  const entry = cache.get(instanceId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    // Dropped rather than returned-and-marked-stale, as `seriesCache` does: a
    // caller that has to remember an `isStale` flag will eventually forget to.
    cache.delete(instanceId);
    return null;
  }
  return entry.config;
}

/**
 * Called after every successful write to this instance — force import (T8)
 * and gaps' attach (`gaps/attach.ts`, below). Dropping the entry costs one
 * config re-read; serving a snapshot the operator's own write just
 * invalidated costs their trust in the comparison.
 */
export function invalidateDecisionsConfig(instanceId: string): void {
  cache.delete(instanceId);
}

/** Test seam — the cache and in-flight map are process-lifetime state. */
export function resetDecisionsConfigCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Resolves one instance's `DecisionsClient`, the one place that lookup
 * happens so `getDecisionsConfig`, `explainCandidate` and `evaluateReleases`
 * (`explain.ts`) all fail the same way for the same reasons.
 */
export function resolveDecisionsClient(
  instanceId: string,
): DecisionsResult<{ id: string; label: string; client: DecisionsClient }> {
  const entry = clientFor(instanceId);
  if (!entry) {
    return {
      ok: false,
      error: { kind: 'no-instance', reason: 'That instance is not registered, or it is disabled in Settings.' },
    };
  }
  if (!isDecisionsClient(entry.client)) {
    return {
      ok: false,
      error: {
        kind: 'not-decisions-client',
        reason: `${entry.label} is a ${entry.kind} — it has no custom formats or quality profiles to compare against.`,
      },
    };
  }
  return { ok: true, value: { id: entry.id, label: entry.label, client: entry.client } };
}

/**
 * Runs one read through the instance's breaker, flattening every outcome into
 * `DecisionsResult` — the same shape `getDecisionsConfig` and
 * `resolveDecisionsClient` already use, so a caller never has to branch on two
 * different failure shapes for one comparison.
 */
export async function readThroughDecisions<T>(
  instanceId: string,
  operation: (signal?: AbortSignal) => Promise<{ ok: true; value: T } | { ok: false; error: { kind: ClientFailureKind; reason: string } }>,
  signal?: AbortSignal,
): Promise<DecisionsResult<T>> {
  try {
    const outcome = await fireOn(instanceId, () => operation(signal), { isFailure: countsAsBreakerFailure });
    if (isCircuitOpen(outcome)) {
      return { ok: false, error: { kind: 'unreachable', reason: outcome.reason } };
    }
    return outcome;
  } catch (error) {
    logger.warn('decisions read threw', { instanceId, error });
    return { ok: false, error: { kind: 'upstream-error', reason: 'The read did not complete.' } };
  }
}

async function fetchAndCache(
  instanceId: string,
  signal?: AbortSignal,
): Promise<DecisionsResult<DecisionsConfig>> {
  const resolved = resolveDecisionsClient(instanceId);
  if (!resolved.ok) return resolved;
  const { client } = resolved.value;

  // Independent and run together, as `seriesCache.readLibrary` runs its two
  // reads together — they answer different questions and neither should wait
  // on the other.
  const [formats, profiles] = await Promise.all([
    readThroughDecisions(instanceId, (s) => client.customFormats(s), signal),
    readThroughDecisions(instanceId, (s) => client.qualityProfileDetails(s), signal),
  ]);

  // The profile read is load-bearing: without it there is no cutoff, no
  // minimum score, and nothing to join a side's custom formats against, so a
  // failure here fails the whole config. A failed catalog read only costs the
  // fallback name lookup `buildComparison` uses for a format id neither side's
  // own list names, so it degrades to an empty list instead.
  if (!profiles.ok) return profiles;

  const config: DecisionsConfig = {
    customFormats: formats.ok ? formats.value : [],
    profiles: profiles.value,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(instanceId, { config, expiresAt: Date.now() + TTL_MS });
  return { ok: true, value: config };
}

/**
 * The cached config for one instance, reading it only when the cache misses,
 * has expired, or the caller explicitly asks for a refresh (`options.refresh`
 * bypasses the TTL check, never the sharing below).
 *
 * Concurrent callers — refreshing or not — join whichever fetch is already in
 * flight for this instance, which is what makes AC9 structural rather than a
 * timing accident: twenty inspector opens inside one fetch's round trip still
 * cost one request.
 */
export async function getDecisionsConfig(
  instanceId: string,
  options: { refresh?: boolean } = {},
  signal?: AbortSignal,
): Promise<DecisionsResult<DecisionsConfig>> {
  if (!options.refresh) {
    const cached = getCachedDecisionsConfig(instanceId);
    if (cached) return { ok: true, value: cached };

    const shared = inflight.get(instanceId);
    if (shared) return shared;
  }

  const promise = fetchAndCache(instanceId, signal);
  inflight.set(instanceId, promise);
  try {
    return await promise;
  } finally {
    // Only clear the entry if it is still the one this call started — a
    // refresh that raced a plain read must not delete the plain read's own
    // in-flight entry out from under it.
    if (inflight.get(instanceId) === promise) inflight.delete(instanceId);
  }
}
