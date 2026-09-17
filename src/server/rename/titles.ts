import 'server-only';

import type { InstanceReadError, RenameTitlesRead } from '@/lib/types';
import {
  countsAsBreakerFailure,
  isRenameClient,
  type ArrRenameTitle,
  type ClientResult,
  type RenameClient,
} from '@/server/clients/types';
import { enabledClients } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen, retryAt, type CircuitOpen } from '@/server/resilience/breaker';

/**
 * What the scope picker chooses from (FR1, T10).
 *
 * The same fan-out contract as `gaps/aggregate.ts` and `queue/aggregate.ts`:
 * every instance is read independently and every failure is attributed, so a
 * Radarr that is down costs the operator Radarr's films and nothing else. This
 * function has no failure mode of its own — an operator with two instances and
 * one outage still gets a usable picker and a line saying which half is
 * missing.
 *
 * It is deliberately *not* the gaps read. A gap is a monitored item with no
 * file; a rename target is an item that has one. The two lists are near
 * complements, so reusing the gaps join here would have offered the operator a
 * list of titles with, by definition, nothing to rename.
 */

/**
 * The same budget the gaps fan-out uses. `GET /series` on a large Sonarr is a
 * library-scale read that legitimately takes seconds, and the 8s single-record
 * default would report a healthy instance as timed out.
 */
const FANOUT_DEADLINE_MS = 20_000;

interface Target {
  id: string;
  label: string;
  kind: 'sonarr' | 'radarr';
  client: RenameClient;
}

function readError(
  target: Target,
  kind: InstanceReadError['kind'],
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

export async function readRenameTitles(
  options: { signal?: AbortSignal } = {},
): Promise<RenameTitlesRead> {
  const own = AbortSignal.timeout(FANOUT_DEADLINE_MS);
  const deadline = options.signal ? AbortSignal.any([options.signal, own]) : own;

  const targets: Target[] = [];
  for (const entry of enabledClients()) {
    // Prowlarr and the download client own no files, so they have no titles —
    // the guard is the same kind narrowing `isGapClient` does, for the same
    // reason (every path here would 404 on them).
    if (!isRenameClient(entry.client)) continue;
    targets.push({
      id: entry.id,
      label: entry.label,
      kind: entry.client.kind as 'sonarr' | 'radarr',
      client: entry.client,
    });
  }

  const reads = await Promise.all(targets.map(async (target) => {
    let outcome: ClientResult<ArrRenameTitle[]> | CircuitOpen;
    try {
      outcome = await fireOn(target.id, () => target.client.listTitles(deadline), {
        isFailure: countsAsBreakerFailure,
      });
    } catch (error) {
      logger.warn('rename title read threw', { instanceId: target.id, error });
      return { target, error: readError(target, 'upstream-error', 'The read did not complete.') };
    }

    if (isCircuitOpen(outcome)) {
      return { target, error: readError(target, 'circuit-open', outcome.reason) };
    }
    if (!outcome.ok) {
      return { target, error: readError(target, outcome.error.kind, outcome.error.reason) };
    }
    return { target, value: outcome.value };
  }));

  const titles: RenameTitlesRead['titles'] = [];
  const errors: InstanceReadError[] = [];

  for (const read of reads) {
    if (read.error) {
      errors.push(read.error);
      continue;
    }
    for (const title of read.value ?? []) {
      const kind = read.target.kind === 'sonarr' ? 'series' : 'movie';
      titles.push({
        // The same composite the plan rows are keyed by, so a selection made
        // here and a row that comes back from the build agree on identity
        // without either side re-deriving it.
        id: `${read.target.id}:${kind}:${title.upstreamId}`,
        instanceId: read.target.id,
        instanceLabel: read.target.label,
        instanceKind: read.target.kind,
        kind,
        upstreamId: title.upstreamId,
        label: title.label,
        fileCount: title.fileCount,
      });
    }
  }

  // Across instances as well as within one: two Sonarrs interleave by title
  // rather than arriving as two blocks, because the operator is looking for a
  // name, not for an instance.
  titles.sort((a, b) => a.label.localeCompare(b.label) || a.instanceLabel.localeCompare(b.instanceLabel));

  return { titles, errors };
}
