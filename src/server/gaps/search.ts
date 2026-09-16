import 'server-only';

import type { BulkSearchOutcome, Gap } from '@/lib/types';
import { countsAsBreakerFailure, isGapClient } from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { recordOperation } from '@/server/operations/log';
import { fireOn, isCircuitOpen } from '@/server/resilience/breaker';
import type { Attempt } from '@/server/search/grab';
import { findGaps } from './aggregate';

/**
 * Bulk automatic search (FR9, REQ-GAPS-008, -009, -014; ADR-7).
 *
 * The instance searches, not helparr: this asks Sonarr and Radarr to run their
 * own indexer search against a set of items, which is why the answer is
 * `queued` and never `found`. Nothing on the screen changes as a result — the
 * gaps stay listed until a later library read says otherwise (deviation D4).
 *
 * Never implicit. This function is reached only from a confirmed dialog that
 * showed the operator the exact count and warned about indexer quota, and it
 * issues **one command per instance** carrying every id for that instance —
 * five separate commands would be five queue entries for what was asked once.
 */

/**
 * Shorter than the library fan-out's 20s. `POST /command` only enqueues — it
 * returns as soon as the instance has accepted the job, and a command that has
 * not been acknowledged in this long is not going to be.
 */
const COMMAND_DEADLINE_MS = 15_000;

/** Grouped by instance, because that is the unit a command is issued in. */
function groupByInstance(gaps: Gap[]): Map<string, Gap[]> {
  const groups = new Map<string, Gap[]>();
  for (const gap of gaps) {
    const existing = groups.get(gap.instanceId);
    if (existing) existing.push(gap);
    else groups.set(gap.instanceId, [gap]);
  }
  return groups;
}

function failure(gaps: Gap[], reason: string): BulkSearchOutcome {
  return {
    instanceId: gaps[0].instanceId,
    instanceLabel: gaps[0].instanceLabel,
    count: gaps.length,
    status: 'failed',
    reason,
  };
}

/**
 * One row per instance, written from the answer — the same rule the grab and
 * the attach follow (AC12). A queued search is a thing helparr did on the
 * operator's behalf against their indexer quota, so it belongs in the trail
 * whether or not it ever produces a file.
 *
 * `urlSha256` and `urlHost` are null because a command carries no link at all;
 * there is nothing to fingerprint and nothing to redact.
 */
function record(outcome: BulkSearchOutcome, instanceKind: string): void {
  const queued = outcome.status === 'queued';
  recordOperation({
    kind: 'search',
    summary: queued
      ? `Search queued on ${outcome.instanceLabel} — ${outcome.count} missing item${outcome.count === 1 ? '' : 's'}`
      : `Search on ${outcome.instanceLabel} — ${outcome.count} missing item${outcome.count === 1 ? '' : 's'}`,
    instanceId: outcome.instanceId,
    instanceLabel: outcome.instanceLabel,
    instanceKind,
    entityTitle: `${outcome.count} missing item${outcome.count === 1 ? '' : 's'}`,
    entityRef: null,
    indexer: null,
    urlSha256: null,
    urlHost: null,
    outcome: queued ? 'succeeded' : 'failed',
    // Not a rejection. An instance either accepts a command or it does not —
    // there is no "your quality profile said no" for a search request.
    rejected: false,
    detail: outcome.reason ? [outcome.reason] : [],
  });
}

async function searchOne(gaps: Gap[]): Promise<BulkSearchOutcome> {
  const instanceId = gaps[0].instanceId;
  const entry = clientFor(instanceId);
  if (!entry) {
    // Disabled between the dialog opening and the confirm. Attributed rather
    // than thrown: the other instances' commands still go out.
    return failure(gaps, 'That instance is not registered, or it is disabled in Settings.');
  }
  if (!isGapClient(entry.client)) {
    return failure(gaps, `${entry.label} is a ${entry.kind} — only Sonarr and Radarr can search for missing items.`);
  }

  const client = entry.client;
  // Every gap on one instance has that instance's kind — `attribute()` takes it
  // from the client, never from the record — so one command covers the group.
  const kind = gaps[0].kind;
  const ids = [...new Set(gaps.map((gap) => gap.upstreamId))];

  const base: BulkSearchOutcome = {
    instanceId: entry.id,
    instanceLabel: entry.label,
    count: gaps.length,
    status: 'queued',
    reason: null,
  };

  try {
    const sent = await fireOn(
      entry.id,
      () => client.searchCommand({ kind, ids }, AbortSignal.timeout(COMMAND_DEADLINE_MS)),
      { isFailure: countsAsBreakerFailure },
    );
    if (isCircuitOpen(sent)) return failure(gaps, sent.reason);
    if (!sent.ok) return failure(gaps, sent.error.reason);
    return base;
  } catch (error) {
    logger.warn('search command threw', { instanceId: entry.id, error });
    return failure(gaps, 'The command did not complete.');
  }
}

export async function bulkSearch(
  gapIds: string[],
  signal?: AbortSignal,
): Promise<Attempt<BulkSearchOutcome[]>> {
  const gaps = await findGaps(gapIds, signal);
  if (gaps.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: 'no-instance',
        reason: 'None of those gaps are in the current library read — refresh the screen and try again.',
      },
    };
  }

  const groups = [...groupByInstance(gaps).values()];
  // In parallel across instances, one command within each. A Sonarr that is
  // slow to accept its command must not delay Radarr's.
  const outcomes = await Promise.all(groups.map(async (group) => {
    const outcome = await searchOne(group);
    record(outcome, group[0].instanceKind);
    return outcome;
  }));

  return { ok: true, value: outcomes };
}
