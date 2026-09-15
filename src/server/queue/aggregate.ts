import 'server-only';

import type {
  InstanceKind,
  InstanceReadError,
  QueueErrorKind,
  QueueRecord,
  QueueResponse,
  TorrentState,
} from '@/lib/types';
import {
  countsAsBreakerFailure,
  isArrQueueClient,
  isTorrentClient,
  type ArrQueueRead,
  type ClientResult,
  type InstanceClient,
} from '@/server/clients/types';
import { enabledClients } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen, retryAt, type CircuitOpen } from '@/server/resilience/breaker';
import { enrichRecords } from './enrich';

/**
 * The fan-out (REQ-QUEUE-002, -007, -009; T6).
 *
 * Every instance is read independently and every failure is attributed. The
 * function has no failure mode of its own: an instance that is down, slow,
 * unauthorized or circuit-broken becomes an entry in `errors`, never an
 * exception, because the whole point of the screen is that Radarr being down
 * must not cost the operator Sonarr's rows.
 */

/**
 * Matches the bounded-read flow in `wireframes/user-flow.md` — at t=8.0s a slow
 * instance is abandoned and the response returns with everyone else's rows. The
 * clients carry their own, longer backstop for the case where no caller supplies
 * a deadline at all.
 */
const FANOUT_DEADLINE_MS = 8_000;

/**
 * Per-instance time of the last *successful* read, surviving across refreshes.
 *
 * Kept here rather than derived per request because its entire purpose is to
 * describe instances that just failed: "Radarr — last read 4m ago" is the
 * sentence that tells the operator how stale the rows they are still looking at
 * have become. A per-request value would be empty exactly when it matters.
 */
const lastSuccessfulRead = new Map<string, string>();

/** Test seam — the module-level freshness map is process-lifetime state. */
export function resetQueueReadState(): void {
  lastSuccessfulRead.clear();
}

interface Target {
  id: string;
  kind: InstanceKind;
  label: string;
  client: InstanceClient;
}

function readError(
  target: Target,
  kind: QueueErrorKind,
  reason: string,
): InstanceReadError {
  return {
    instanceId: target.id,
    instanceLabel: target.label,
    instanceKind: target.kind,
    kind,
    reason,
    retryAt: kind === 'circuit-open' ? retryAt(target.id) : null,
  };
}

function deadlineFor(external?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(FANOUT_DEADLINE_MS);
  return external ? AbortSignal.any([external, own]) : own;
}

/**
 * Runs one instance's read through its breaker and normalises everything that
 * can come back — success, a typed client failure, an open circuit, or a thrown
 * error — into one settled shape.
 */
async function readFrom<T>(
  target: Target,
  operation: (signal: AbortSignal) => Promise<ClientResult<T>>,
  deadline: AbortSignal,
): Promise<{ target: Target; value: T | null; error: InstanceReadError | null }> {
  let outcome: ClientResult<T> | CircuitOpen;
  try {
    outcome = await fireOn(target.id, () => operation(deadline), {
      isFailure: countsAsBreakerFailure,
    });
  } catch (error) {
    // Nothing in the client layer is supposed to throw; if something does, the
    // instance is reported unreadable rather than taking the response with it.
    logger.warn('queue read threw', { instanceId: target.id, error });
    return {
      target,
      value: null,
      error: readError(target, 'upstream-error', 'The read did not complete.'),
    };
  }

  if (isCircuitOpen(outcome)) {
    return { target, value: null, error: readError(target, 'circuit-open', outcome.reason) };
  }
  if (!outcome.ok) {
    return { target, value: null, error: readError(target, outcome.error.kind, outcome.error.reason) };
  }

  lastSuccessfulRead.set(target.id, new Date().toISOString());
  return { target, value: outcome.value, error: null };
}

function attribute(target: Target, read: ArrQueueRead): QueueRecord[] {
  return read.records.map((record) => ({
    ...record,
    // Composite, because two instances can and do hand out the same record id.
    // This is also the key selection survives a refetch on, so it must depend
    // only on identity — never on position or on any field that changes as the
    // download progresses.
    id: `${target.id}:${record.recordId}`,
    instanceId: target.id,
    instanceLabel: target.label,
    instanceKind: target.kind,
    torrent: null,
    stall: { stalled: false, evidence: '' },
  }));
}

export async function readQueue(signal?: AbortSignal): Promise<QueueResponse> {
  const observedAt = new Date().toISOString();
  const targets = enabledClients();
  const deadline = deadlineFor(signal);

  // flatMap rather than filter so the capability guard actually narrows the
  // client type — a filtered array would still be typed as bare `InstanceClient`
  // and force a cast back at the call.
  const queueTargets = targets.flatMap(
    (t) => (isArrQueueClient(t.client) ? [{ ...t, client: t.client }] : []),
  );
  const torrentTargets = targets.flatMap(
    (t) => (isTorrentClient(t.client) ? [{ ...t, client: t.client }] : []),
  );

  // One round trip per instance, all in flight together. Sequential reads would
  // make the slowest instance define the latency of every other one.
  const [queueReads, torrentReads] = await Promise.all([
    Promise.all(queueTargets.map(
      (target) => readFrom(target, (d) => target.client.queue(d), deadline),
    )),
    Promise.all(torrentTargets.map(
      (target) => readFrom(target, (d) => target.client.torrents(d), deadline),
    )),
  ]);

  const errors: InstanceReadError[] = [];
  const records: QueueRecord[] = [];

  for (const read of queueReads) {
    if (read.error) {
      errors.push(read.error);
      continue;
    }
    if (!read.value) continue;

    records.push(...attribute(read.target, read.value));

    if (read.value.truncated) {
      // Surfaced, never swallowed. A queue that is quietly cut off looks
      // identical to a queue that is simply shorter, and that is the exact
      // failure this screen exists to prevent.
      errors.push(readError(
        read.target,
        'upstream-error',
        `Only the first ${read.value.records.length} of ${read.value.totalRecords} queue items were read `
          + '— the page ceiling was reached. The rest of this instance\'s queue is not shown.',
      ));
    }
  }

  const torrents: TorrentState[] = [];
  for (const read of torrentReads) {
    if (read.error) {
      // Not fatal to the table: the *arr rows still render, just un-enriched.
      // The banner names the download client so the operator knows why the
      // stall column went quiet rather than concluding nothing is stuck.
      errors.push(read.error);
      continue;
    }
    if (read.value) torrents.push(...read.value);
  }

  const lastReadAt: Record<string, string> = {};
  for (const target of targets) {
    const at = lastSuccessfulRead.get(target.id);
    if (at) lastReadAt[target.id] = at;
  }

  return {
    records: enrichRecords(records, torrents),
    errors,
    lastReadAt,
    observedAt,
  };
}
