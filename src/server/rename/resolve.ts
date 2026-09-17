import 'server-only';

import type {
  RenamePlanRow,
  RenameScopeEntry,
  RenameTitleStatus,
  RenameWarning,
} from '@/lib/types';
import {
  isRenameClient,
  type ArrRenameRow,
  type RenameClient,
} from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';

/**
 * The one resolution preview and apply share (NFR2, REQ-RENAME-012).
 *
 * This is the whole of the dry-run guarantee. If the build computed its rows
 * here and the apply re-derived them somewhere else, the two could drift in a
 * way no test would catch, and a dry run that takes a parallel path is not a
 * dry run — it is a second implementation that happens to agree today. So
 * `buildPlan()` calls this to produce what the operator reads, and
 * `applyPlan()` calls it again to check that what they read is still true.
 *
 * It performs no writes and issues no commands: a rescan and a `GET /rename`
 * per title, and arithmetic on what comes back.
 */

/** How long one title's rescan is waited on before the preview goes ahead. */
const RESCAN_DEADLINE_MS = 30_000;
const RESCAN_POLL_MS = 500;

export interface ResolvedTitle {
  status: RenameTitleStatus;
  /** Empty when the title has nothing pending — which is an answer, not a gap. */
  rows: Array<Omit<RenamePlanRow, 'id' | 'excluded' | 'outcome' | 'outcomeDetail'>>;
  /** Paths that already exist under this title's destinations (ADR-9). */
  occupied: string[];
}

/* ── Derived warnings (ADR-9) ─────────────────────────────────────────────── */

/**
 * Neither Sonarr nor Radarr returns a warning field — the spike printed the
 * complete key union of both and there is none. Everything below is helparr's
 * own assertion about rows it already holds, which is why no copy anywhere may
 * attribute these to the instance: a derived warning that is wrong is helparr's
 * bug, not the *arr's.
 */

/** Trailing separators stripped so `/a/b` and `/a/b/` are the same directory. */
function directoryOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? '' : normalized.slice(0, cut);
}

export interface WarningInput {
  /** `instanceId:kind:upstreamId` — scopes path comparisons to one title. */
  titleKey: string;
  fileId: number;
  existingPath: string;
  proposedPath: string;
  episodeCount: number | null;
}

/** Per title: the relative paths that already exist on the instance's disk. */
export type TitleOccupancy = Map<string, Set<string>>;

/**
 * Four properties, computed across the *whole* plan rather than per title,
 * because a collision is only visible from both rows at once.
 *
 * `moves-directory` is the one the spike found in the operator's own library: a
 * file lifted out of the series root into `Season 1/`. That is a move, being
 * approved under a screen labelled "rename".
 *
 * `destination-exists` was found the hard way, by the R1 verification actually
 * renaming a file: Sonarr proposed a destination another file already held,
 * accepted the command, reported it completed and successful, and moved
 * nothing. The occupant is invisible to the plan — it has no rename pending, so
 * it is not in the preview, and in the observed case it was not an imported
 * file either, so it was not in `/episodefile`. Only `occupancy`, read from the
 * instance's own filesystem endpoint, can see it.
 */
export function deriveWarnings(
  rows: WarningInput[],
  occupancy: TitleOccupancy = new Map(),
): RenameWarning[][] {
  const destinationCounts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.titleKey}\0${row.proposedPath}`;
    destinationCounts.set(key, (destinationCounts.get(key) ?? 0) + 1);
  }

  // A path this plan is itself moving away from does not block the destination
  // — flagging that would put a warning on most ordinary batch renames. Keyed
  // by path rather than by file id because the occupant may be a file the
  // instance never imported, and such a file has no id to match against.
  const vacating = new Set(rows.map((row) => `${row.titleKey}\0${row.existingPath}`));

  return rows.map((row) => {
    const warnings: RenameWarning[] = [];

    if (directoryOf(row.existingPath) !== directoryOf(row.proposedPath)) {
      warnings.push('moves-directory');
    }

    if ((destinationCounts.get(`${row.titleKey}\0${row.proposedPath}`) ?? 0) > 1) {
      warnings.push('destination-collision');
    }

    if (row.proposedPath !== row.existingPath
      && occupancy.get(row.titleKey)?.has(row.proposedPath)
      && !vacating.has(`${row.titleKey}\0${row.proposedPath}`)) {
      warnings.push('destination-exists');
    }

    // Sonarr only — Radarr reports `null`, which means "not applicable" and
    // must never be read as "one".
    if (row.episodeCount !== null && row.episodeCount > 1) {
      warnings.push('multi-episode');
    }

    return warnings;
  });
}

export function titleKeyOf(
  instanceId: string | null,
  kind: string,
  upstreamId: number,
): string {
  return `${instanceId ?? ''}:${kind}:${upstreamId}`;
}

/* ── Per-title resolution ─────────────────────────────────────────────────── */

function erroredTitle(entry: RenameScopeEntry, reason: string): ResolvedTitle {
  return {
    status: {
      instanceId: entry.instanceId,
      // The registry could not give us a label, so the id stands in. Inventing
      // a friendly name for an instance helparr cannot reach would make the
      // failure read like it came from somewhere it did not.
      instanceLabel: entry.instanceId,
      kind: entry.kind,
      upstreamId: entry.upstreamId,
      label: entry.label,
      state: 'errored',
      fileCount: 0,
      reason,
    },
    rows: [],
    occupied: [],
  };
}

/**
 * Waits for a rescan to finish.
 *
 * A rescan helparr did not wait for is a rescan it did not do: the preview
 * would be computed against the library as it was before, and the stale
 * mediainfo would be baked into names the operator then approves. On timeout
 * the title is reported errored rather than previewed anyway — the alternative
 * is a plan that looks complete and is silently built on old data.
 */
async function awaitRescan(
  client: RenameClient,
  entry: RenameScopeEntry,
  signal?: AbortSignal,
): Promise<string | null> {
  const started = await client.rescanTitle(
    { kind: entry.kind, upstreamId: entry.upstreamId },
    signal,
  );
  if (!started.ok) return started.error.reason;

  const deadline = Date.now() + RESCAN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const status = await client.commandStatus(started.value, signal);
    if (!status.ok) return status.error.reason;
    if (status.value.state === 'completed') return null;
    if (status.value.state === 'failed') {
      return status.value.message ?? 'The instance reported the rescan failed.';
    }
    await new Promise((done) => setTimeout(done, RESCAN_POLL_MS));
  }
  return 'The rescan did not finish in time, so the preview would have been built on stale data.';
}

/**
 * Resolves one title: rescan, wait, preview.
 *
 * Every failure is attributed to its title and none of them aborts the others
 * — the same contract the queue and gaps fan-outs hold. An operator who picked
 * twelve titles and lost one to a timeout gets eleven titles and a named
 * failure, not an error page.
 */
export async function resolveTitle(
  entry: RenameScopeEntry,
  signal?: AbortSignal,
): Promise<ResolvedTitle> {
  const resolved = clientFor(entry.instanceId);
  if (!resolved) {
    return erroredTitle(entry, 'That instance is no longer configured or is disabled.');
  }
  if (!isRenameClient(resolved.client)) {
    return erroredTitle(entry, `${resolved.label} cannot rename files.`);
  }

  const base = {
    instanceId: resolved.id,
    instanceLabel: resolved.label,
    kind: entry.kind,
    upstreamId: entry.upstreamId,
    label: entry.label,
  } as const;

  const rescanFailure = await awaitRescan(resolved.client, entry, signal);
  if (rescanFailure !== null) {
    return {
      status: { ...base, state: 'errored', fileCount: 0, reason: rescanFailure },
      rows: [],
      occupied: [],
    };
  }

  const preview = await resolved.client.renamePreview(
    { kind: entry.kind, upstreamId: entry.upstreamId },
    signal,
  );
  if (!preview.ok) {
    return {
      status: { ...base, state: 'errored', fileCount: 0, reason: preview.error.reason },
      rows: [],
      occupied: [],
    };
  }

  // An empty preview is "nothing pending" and is recorded as such (FR5,
  // REQ-RENAME-006). Dropping the title would make it indistinguishable from
  // one that was never asked about.
  if (preview.value.length === 0) {
    return {
      status: { ...base, state: 'no-changes', fileCount: 0, reason: null },
      rows: [],
      occupied: [],
    };
  }

  // Only the directories this preview actually proposes writing into, and only
  // once the title has rows at all — one read per distinct destination folder,
  // which for a season-foldered series is a handful, not one per file.
  const destinations = [...new Set(preview.value.map((row) => directoryOf(row.proposedPath)))];
  const existing = await resolved.client.listExistingPaths(
    { kind: entry.kind, upstreamId: entry.upstreamId },
    destinations,
    signal,
  );

  return {
    status: {
      ...base,
      state: 'has-changes',
      fileCount: preview.value.length,
      // Said out loud rather than swallowed. A missing occupancy read costs the
      // `destination-exists` warning for this title, and an operator who is not
      // told that will read its absence as "no collisions here".
      reason: existing.ok
        ? null
        : 'Could not check for occupied destinations on this title.',
    },
    occupied: existing.ok ? existing.value : [],
    rows: preview.value.map((row: ArrRenameRow) => ({
      instanceId: resolved.id,
      instanceLabel: resolved.label,
      instanceKind: resolved.kind,
      titleKind: entry.kind,
      titleUpstreamId: entry.upstreamId,
      titleLabel: entry.label,
      fileId: row.fileId,
      existingPath: row.existingPath,
      proposedPath: row.proposedPath,
      // Filled in by `resolvePlanRows`, which can see every title at once —
      // a collision between two titles is invisible from inside either.
      warnings: [] as RenameWarning[],
      episodeCount: row.episodeCount,
    })),
  };
}

export interface ResolvedPlan {
  titles: RenameTitleStatus[];
  rows: Array<Omit<RenamePlanRow, 'id' | 'excluded' | 'outcome' | 'outcomeDetail'>>;
}

/**
 * Resolves the whole scope, then derives the warnings across it.
 *
 * Titles are resolved sequentially rather than fanned out. Each one queues a
 * rescan on the instance, and the *arr command queue is serialised anyway —
 * twelve parallel rescans against one Sonarr produce twelve queued commands and
 * the same wall-clock, plus a progress model that jumps rather than advances.
 *
 * `onTitle` fires as each title lands so the caller can persist progressively
 * (ADR-5) — the operator watches the plan fill in rather than a spinner.
 */
export async function resolvePlanRows(
  scope: RenameScopeEntry[],
  options: { signal?: AbortSignal; onTitle?: (resolved: ResolvedTitle) => void } = {},
): Promise<ResolvedPlan> {
  const titles: RenameTitleStatus[] = [];
  const carried: Array<
    Omit<RenamePlanRow, 'id' | 'excluded' | 'outcome' | 'outcomeDetail'>
    & { episodeCount: number | null }
  > = [];

  const occupancy: TitleOccupancy = new Map();

  for (const entry of scope) {
    const resolved = await resolveTitle(entry, options.signal);
    titles.push(resolved.status);
    carried.push(...(resolved.rows as typeof carried));

    // Keyed per title because the paths are relative — two different series can
    // legitimately both hold `Season 1/S01E01.mkv`, and comparing them plan-wide
    // would invent collisions that do not exist.
    occupancy.set(
      titleKeyOf(resolved.status.instanceId, resolved.status.kind, resolved.status.upstreamId),
      new Set(resolved.occupied),
    );

    options.onTitle?.(resolved);
  }

  const warnings = deriveWarnings(
    carried.map((row) => ({
      titleKey: titleKeyOf(row.instanceId, row.titleKind, row.titleUpstreamId),
      fileId: row.fileId,
      existingPath: row.existingPath,
      proposedPath: row.proposedPath,
      episodeCount: row.episodeCount,
    })),
    occupancy,
  );

  // `episodeCount` existed only to derive `multi-episode`; it is not part of a
  // plan row and is dropped rather than persisted.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const rows = carried.map(({ episodeCount, ...row }, index) => ({
    ...row,
    warnings: warnings[index],
  }));

  return { titles, rows };
}
