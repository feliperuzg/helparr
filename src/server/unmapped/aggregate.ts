import 'server-only';

import type { UnmappedFolderRow, UnmappedInstance, UnmappedRead, UnmappedRoot } from '@/lib/unmapped';
import {
  countsAsBreakerFailure,
  isRootFolderClient,
  type ArrRootFolder,
  type ClientResult,
  type RootFolderClient,
} from '@/server/clients/types';
import { enabledClients } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen, type CircuitOpen } from '@/server/resilience/breaker';

/**
 * The unmapped-folders fan-out (ADR-9, REQ-GAPS-022, -026; T10).
 *
 * Structurally the same contract as `queue/aggregate.ts` and `gaps/aggregate.ts`
 * and for the same reason (NFR1): every instance is read independently through
 * its own breaker, and one instance timing out or refusing never costs the
 * operator the root folders an instance that answered is holding. This
 * function has no failure mode of its own — every outcome, including a thrown
 * error, becomes a per-instance `UnmappedInstance` entry.
 */

/** Same budget as the queue's fan-out: `/rootfolder` is a cheap, non-paged read. */
const FANOUT_DEADLINE_MS = 8_000;

interface Target {
  id: string;
  kind: 'sonarr' | 'radarr';
  label: string;
  client: RootFolderClient;
}

function deadlineFor(external?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(FANOUT_DEADLINE_MS);
  return external ? AbortSignal.any([external, own]) : own;
}

/**
 * Runs one instance's `/rootfolder` read through its breaker and normalises
 * every way it can come back — success, a typed client failure, an open
 * circuit, or a thrown error — into one settled shape. Mirrors `readFrom` in
 * `queue/aggregate.ts` and `gaps/aggregate.ts`.
 */
async function readFrom(
  target: Target,
  deadline: AbortSignal,
): Promise<{ value: ArrRootFolder[] | null; reason: string | null }> {
  let outcome: ClientResult<ArrRootFolder[]> | CircuitOpen;
  try {
    outcome = await fireOn(target.id, () => target.client.rootFolders(deadline), {
      isFailure: countsAsBreakerFailure,
    });
  } catch (error) {
    logger.warn('unmapped read threw', { instanceId: target.id, error });
    return { value: null, reason: 'The read did not complete.' };
  }

  if (isCircuitOpen(outcome)) {
    return { value: null, reason: outcome.reason };
  }
  if (!outcome.ok) {
    return { value: null, reason: outcome.error.reason };
  }
  return { value: outcome.value, reason: null };
}

/**
 * One root folder's unmapped set, resolved into the three states ADR-9
 * requires. `unmappedFolders === null` is the upstream omitting the key
 * entirely — unknown, never empty (REQ-GAPS-023) — and is the whole reason
 * `ArrRootFolder.unmappedFolders` is typed `[] | null` rather than always `[]`.
 */
function attribute(target: Target, folder: ArrRootFolder): UnmappedRoot {
  if (folder.unmappedFolders === null) {
    return {
      rootPath: folder.path,
      accessible: folder.accessible,
      freeSpace: folder.freeSpace,
      state: 'unknown',
      count: null,
      folders: [],
    };
  }

  const rows: UnmappedFolderRow[] = folder.unmappedFolders.map((entry) => ({
    instanceId: target.id,
    instanceLabel: target.label,
    instanceKind: target.kind,
    rootPath: folder.path,
    name: entry.name,
    path: entry.path,
    // Cross-link only, into helparr's own search screen — never the
    // instance's add-new UI (ADR-9, REQ-GAPS-025; same mechanism as
    // `GapInspector`'s "⌕ Indexers" link).
    searchUrl: `/search?q=${encodeURIComponent(entry.name)}`,
  }));

  return {
    rootPath: folder.path,
    accessible: folder.accessible,
    freeSpace: folder.freeSpace,
    state: rows.length === 0 ? 'none' : 'listed',
    count: rows.length,
    folders: rows,
  };
}

export async function readUnmapped(signal?: AbortSignal): Promise<UnmappedRead> {
  const readAt = new Date().toISOString();
  const deadline = deadlineFor(signal);

  // flatMap rather than filter so the capability guard actually narrows the
  // client type — see `queue/aggregate.ts` for why a filter does not. Only
  // Sonarr and Radarr carry `/rootfolder`; every other kind is simply absent
  // from the result rather than reported `unsupported` (ADR-9 — this screen
  // never lists Prowlarr or the download client at all).
  const targets: Target[] = enabledClients().flatMap((t) => (
    isRootFolderClient(t.client) && (t.kind === 'sonarr' || t.kind === 'radarr')
      ? [{ id: t.id, kind: t.kind, label: t.label, client: t.client }]
      : []
  ));

  const instances = await Promise.all(targets.map(async (target): Promise<UnmappedInstance> => {
    const read = await readFrom(target, deadline);

    if (read.reason !== null) {
      return {
        instanceId: target.id,
        label: target.label,
        kind: target.kind,
        status: 'unreachable',
        error: read.reason,
        roots: [],
      };
    }

    return {
      instanceId: target.id,
      label: target.label,
      kind: target.kind,
      status: 'ok',
      error: null,
      roots: (read.value ?? []).map((folder) => attribute(target, folder)),
    };
  }));

  return { instances, readAt };
}
