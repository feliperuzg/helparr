import 'server-only';

import CircuitBreaker from 'opossum';

import { logger } from '@/server/logging/redact';
import type { InstanceClient, ProbeResult } from '@/server/clients/types';

/**
 * Per-instance circuit breakers (ADR-8, REQ-INST-010 / FR10, FR13).
 *
 * One breaker per registered instance, owned here and shared by the health
 * poller and the request path. Because breakers are per-instance, Prowlarr's
 * opening has no reachable effect on Sonarr's — which is what `project.md`
 * means by "Prowlarr down must not break the Gaps or Rename screens".
 *
 * Backoff lives in this breaker's `resetTimeout`, not in the client's
 * `refetchInterval` (ADR-6). The UI keeps asking every 60s and an open breaker
 * answers from `fallback` without a network call: state stays fresh within a
 * minute while upstream traffic for a down host collapses to nearly zero.
 */

const BASE_RESET_MS = 60_000;
const MAX_RESET_MS = 10 * 60_000;

export interface BreakerOptions {
  timeoutMs?: number;
}

interface Entry {
  breaker: CircuitBreaker<[AbortSignal | undefined], ProbeResult>;
  /** Consecutive open cycles, used to grow `resetTimeout` exponentially. */
  openCycles: number;
  nextRetryAt: number | null;
}

const registry = new Map<string, Entry>();

/**
 * Jitter prevents four instances from synchronising into bursts against a NAS
 * after a restart or a shared outage. ±20% is enough to desynchronise without
 * making the schedule unpredictable for the operator.
 */
function jitter(ms: number): number {
  const spread = ms * 0.2;
  return Math.round(ms - spread + Math.random() * spread * 2);
}

/**
 * Opossum keeps its live options on the instance and re-reads `resetTimeout`
 * every time it schedules the half-open timer, which is what makes growing the
 * backoff a matter of assigning to it. `@types/opossum` does not declare the
 * property, so the narrowing happens here once rather than at each call site.
 */
function mutableOptions(breaker: object): { resetTimeout: number } {
  return (breaker as { options: { resetTimeout: number } }).options;
}

function backoffFor(openCycles: number): number {
  const growth = BASE_RESET_MS * 2 ** Math.max(0, openCycles - 1);
  return jitter(Math.min(growth, MAX_RESET_MS));
}

export function getBreaker(
  instanceId: string,
  client: InstanceClient,
  options: BreakerOptions = {},
): CircuitBreaker<[AbortSignal | undefined], ProbeResult> {
  const existing = registry.get(instanceId);
  if (existing) return existing.breaker;

  const breaker = new CircuitBreaker<[AbortSignal | undefined], ProbeResult>(
    (signal?: AbortSignal) => client.probe(signal),
    {
      name: instanceId,
      timeout: options.timeoutMs ?? 10_000,
      errorThresholdPercentage: 50,
      resetTimeout: BASE_RESET_MS,
      // Without a volume threshold a single failed probe on a freshly-started
      // helparr is 100% failure and opens the breaker immediately.
      volumeThreshold: 2,
      rollingCountTimeout: 120_000,
      rollingCountBuckets: 12,
    },
  );

  // The fallback *returns* rather than throws. Callers fan out with
  // `Promise.allSettled` and need a complete per-instance picture; a throwing
  // fallback would make "host is down" an exception in the common case.
  breaker.fallback((): ProbeResult => ({
    state: 'unreachable',
    reason: 'Not contacted — helparr has stopped probing this instance until the retry window elapses.',
  }));

  const entry: Entry = { breaker, openCycles: 0, nextRetryAt: null };

  // `prependListener`, not `on`: opossum registers its own 'open' handler in the
  // constructor, and that handler reads `options.resetTimeout` to schedule the
  // half-open timer. Listeners fire in registration order, so appending here
  // would apply each new backoff one cycle late.
  breaker.prependListener('open', () => {
    entry.openCycles += 1;
    const reset = backoffFor(entry.openCycles);
    entry.nextRetryAt = Date.now() + reset;
    mutableOptions(breaker).resetTimeout = reset;
    logger.warn('circuit opened', {
      instanceId,
      openCycles: entry.openCycles,
      retryInSeconds: Math.round(reset / 1000),
    });
  });

  breaker.on('close', () => {
    entry.openCycles = 0;
    entry.nextRetryAt = null;
    mutableOptions(breaker).resetTimeout = BASE_RESET_MS;
    logger.info('circuit closed', { instanceId });
  });

  registry.set(instanceId, entry);
  return breaker;
}

/** ISO timestamp of the next allowed probe, or null when the breaker is closed. */
export function retryAt(instanceId: string): string | null {
  const entry = registry.get(instanceId);
  if (!entry || entry.breaker.closed || entry.nextRetryAt === null) return null;
  return new Date(entry.nextRetryAt).toISOString();
}

/** Called when an instance is edited, disabled or removed. */
export function disposeBreaker(instanceId: string): void {
  const entry = registry.get(instanceId);
  if (!entry) return;
  entry.breaker.shutdown();
  registry.delete(instanceId);
}

export function disposeAllBreakers(): void {
  for (const id of [...registry.keys()]) disposeBreaker(id);
}
