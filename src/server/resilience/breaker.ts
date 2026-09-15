import 'server-only';

import CircuitBreaker from 'opossum';

import { logger } from '@/server/logging/redact';

/**
 * Per-instance circuit breakers (ADR-8 of instance-connections, ADR-1 of
 * unified-queue-overview; REQ-INST-010, REQ-QUEUE-008).
 *
 * One breaker per registered instance, owned here and shared by every operation
 * against that instance — health probes, queue reads, queue removals. The
 * sharing is the point: a queue endpoint that keeps failing has to open the
 * same breaker the health rail reads, otherwise `REQ-QUEUE-008` ("no request
 * SHALL be issued") and the modified `REQ-INST-009` ("an open circuit reports
 * unreachable") can never hold for queue traffic.
 *
 * Because breakers are per-instance, Prowlarr's opening has no reachable effect
 * on Sonarr's — which is what `project.md` means by "Prowlarr down must not
 * break the Gaps or Rename screens".
 *
 * Backoff lives in this breaker's `resetTimeout`, not in the client's
 * `refetchInterval` (ADR-6). The UI keeps asking on its own interval and an
 * open breaker answers without a network call: state stays fresh while
 * upstream traffic for a down host collapses to nearly zero.
 */

const BASE_RESET_MS = 60_000;
const MAX_RESET_MS = 10 * 60_000;

/**
 * A hard backstop, not the operation's deadline. Every operation carries its
 * own `AbortSignal` — 8s for a probe, a shared budget for a paginated queue
 * read — and those are what actually bound a call. opossum's timeout is a
 * single fixed value per breaker, so setting it tight enough for a probe would
 * kill a legitimate multi-page queue read against the same instance.
 */
const ACTION_TIMEOUT_MS = 60_000;

export interface BreakerOptions {
  timeoutMs?: number;
}

/** What a caller gets instead of a result when the breaker is open. */
export interface CircuitOpen {
  kind: 'circuit-open';
  reason: string;
  /** ISO timestamp of the next allowed attempt, when one is scheduled. */
  retryAt: string | null;
}

export function isCircuitOpen(value: unknown): value is CircuitOpen {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'circuit-open';
}

type Operation = () => Promise<unknown>;

interface Entry {
  breaker: CircuitBreaker<[Operation], unknown>;
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

/**
 * Carries a resolved-but-failed value out through opossum.
 *
 * Our clients deliberately never throw for an expected upstream condition — a
 * probe against a dead host *returns* `{state: 'unreachable'}`. To opossum a
 * resolved promise is a success, so without this wrapper a permanently
 * unreachable instance would never open its breaker. `fireOn` throws this from
 * inside the action so the failure is counted, catches it on the way out, and
 * hands the caller back the original value.
 */
class OperationFailure extends Error {
  constructor(readonly value: unknown) {
    super('operation reported failure');
    this.name = 'OperationFailure';
  }
}

export function getBreaker(
  instanceId: string,
  options: BreakerOptions = {},
): CircuitBreaker<[Operation], unknown> {
  const existing = registry.get(instanceId);
  if (existing) return existing.breaker;

  // The action is a dispatcher, not a fixed operation: callers pass the work.
  const breaker = new CircuitBreaker<[Operation], unknown>(
    (operation: Operation) => operation(),
    {
      name: instanceId,
      timeout: options.timeoutMs ?? ACTION_TIMEOUT_MS,
      errorThresholdPercentage: 50,
      resetTimeout: BASE_RESET_MS,
      // Without a volume threshold a single failed probe on a freshly-started
      // helparr is 100% failure and opens the breaker immediately.
      volumeThreshold: 2,
      rollingCountTimeout: 120_000,
      rollingCountBuckets: 12,
    },
  );

  // Deliberately no `breaker.fallback`. opossum runs the fallback for *every*
  // failure, not just an open circuit, which would make "this call failed" and
  // "we are no longer calling" indistinguishable — and those are two different
  // rows in the health rail. `fireOn` distinguishes them by catching
  // opossum's `EOPENBREAKER` instead, and still returns rather than throws for
  // every expected condition, which is the property callers depend on when
  // they fan out with `Promise.allSettled`.

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

export interface FireOptions<T> {
  /**
   * Marks a *resolved* value as a failure for breaker-accounting purposes. The
   * value is still returned to the caller unchanged; only the breaker's view of
   * it changes. Omit for operations that signal failure by throwing.
   */
  isFailure?: (value: T) => boolean;
  timeoutMs?: number;
}

/**
 * Runs one operation against an instance through that instance's breaker.
 *
 * Returns `CircuitOpen` when the breaker is open — no socket is opened in that
 * case, which is exactly what REQ-QUEUE-008 requires. Anything the operation
 * throws propagates: a caller that wants a per-instance error entry rather than
 * a rejection should catch it, or fan out with `Promise.allSettled`.
 */
export async function fireOn<T>(
  instanceId: string,
  operation: () => Promise<T>,
  options: FireOptions<T> = {},
): Promise<T | CircuitOpen> {
  const breaker = getBreaker(instanceId, { timeoutMs: options.timeoutMs });

  try {
    return await breaker.fire(async () => {
      const value = await operation();
      if (options.isFailure?.(value)) throw new OperationFailure(value);
      return value;
    }) as T;
  } catch (error) {
    if (error instanceof OperationFailure) return error.value as T;

    if ((error as { code?: string } | undefined)?.code === 'EOPENBREAKER') {
      return {
        kind: 'circuit-open',
        reason: 'Not contacted — helparr has stopped calling this instance until the retry window elapses.',
        retryAt: retryAt(instanceId),
      };
    }

    throw error;
  }
}

/** ISO timestamp of the next allowed attempt, or null when the breaker is closed. */
export function retryAt(instanceId: string): string | null {
  const entry = registry.get(instanceId);
  if (!entry || entry.breaker.closed || entry.nextRetryAt === null) return null;
  return new Date(entry.nextRetryAt).toISOString();
}

/** True while the breaker is refusing calls. Drives the health rail's distinct
 *  "not contacted" state, which the operator needs to tell apart from "we tried
 *  and it failed". */
export function isOpen(instanceId: string): boolean {
  const entry = registry.get(instanceId);
  return entry ? entry.breaker.opened : false;
}

/**
 * Forces the next call to be attempted regardless of the retry window — the
 * operator's [Retry now]. Half-open lets exactly one request through; if it
 * fails the breaker re-opens with the backoff already grown (ADR-5).
 */
export function halfOpen(instanceId: string): void {
  const entry = registry.get(instanceId);
  if (!entry || entry.breaker.closed) return;
  entry.nextRetryAt = Date.now();
  // `close()` would discard the failure history along with the backoff growth.
  // Opossum exposes no public half-open trigger, so the reset timer is pulled
  // forward instead by re-arming it at zero.
  mutableOptions(entry.breaker).resetTimeout = 1;
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
