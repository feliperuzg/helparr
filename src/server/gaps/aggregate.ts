import 'server-only';

import type {
  Gap,
  GapHistoryRead,
  GapKind,
  GapsResponse,
  InstanceKind,
  InstanceReadError,
  QueueErrorKind,
} from '@/lib/types';
import {
  countsAsBreakerFailure,
  isGapClient,
  type ArrGapRecord,
  type ClientResult,
  type GapClient,
} from '@/server/clients/types';
import { clientFor, enabledClients } from '@/server/instances/registry';
import type { Attempt } from '@/server/search/grab';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen, retryAt, type CircuitOpen } from '@/server/resilience/breaker';
import { inferReason } from './reason';
import { readLibrary, type LibrarySnapshot } from './seriesCache';

/**
 * The gaps fan-out (REQ-GAPS-001, -002, -015; T6).
 *
 * Structurally the same contract as `queue/aggregate.ts` and for the same
 * reason: every instance is read independently and every failure is attributed,
 * so Radarr being down never costs the operator Sonarr's rows. This function
 * has no failure mode of its own.
 */

/**
 * Longer than the queue's 8s. `wanted/missing` is a library-scale read — a
 * Sonarr with a few thousand monitored episodes legitimately takes several
 * seconds and pages more than once — and cutting it off at the queue's budget
 * would report a healthy instance as timed out.
 */
const FANOUT_DEADLINE_MS = 20_000;

/** Radarr has no per-series grouping, so every film sits under one heading. */
const FILMS_GROUP = 'Films';

/** Per-instance time of the last successful read — see `queue/aggregate.ts`. */
const lastSuccessfulRead = new Map<string, string>();

/**
 * The last read's gaps, by composite id.
 *
 * An attach arrives as `{ gapId, link }` and the title it pushes must be built
 * from fields *the instance* returned — not from anything the browser sends
 * back, which would let the client decide what the operation is recorded as.
 * Since an attach always follows a read of the same screen, keeping that read's
 * result is enough; `findGap` falls back to a fresh read when it is not.
 *
 * Refreshed per instance rather than wholesale, so an instance that failed this
 * round keeps the entries from the round where it worked.
 */
const gapIndex = new Map<string, Gap>();

/** Test seam — the module-level maps are process-lifetime state. */
export function resetGapsReadState(): void {
  lastSuccessfulRead.clear();
  gapIndex.clear();
}

/**
 * The gap behind an id, re-reading only when the index cannot answer — after a
 * restart, or when the operator left the screen open across one.
 */
export async function findGap(gapId: string, signal?: AbortSignal): Promise<Gap | null> {
  const known = gapIndex.get(gapId);
  if (known) return known;

  const fresh = await readGaps({ signal });
  return fresh.gaps.find((gap) => gap.id === gapId) ?? null;
}

/**
 * The same lookup for a selection, resolved in **one** re-read rather than one
 * per id — a bulk search of forty gaps after a restart would otherwise mean
 * forty full library reads.
 *
 * Ids the index and the re-read both miss are dropped from the result: the
 * caller is told how many it got back and decides what that means.
 */
export async function findGaps(gapIds: string[], signal?: AbortSignal): Promise<Gap[]> {
  const wanted = new Set(gapIds);
  const found = new Map<string, Gap>();
  for (const id of wanted) {
    const known = gapIndex.get(id);
    if (known) found.set(id, known);
  }
  if (found.size === wanted.size) return [...found.values()];

  const fresh = await readGaps({ signal });
  for (const gap of fresh.gaps) {
    if (wanted.has(gap.id)) found.set(gap.id, gap);
  }
  return [...found.values()];
}

interface Target {
  id: string;
  kind: InstanceKind;
  label: string;
  client: GapClient;
}

function readError(target: Target, kind: QueueErrorKind, reason: string): InstanceReadError {
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

async function readFrom<T>(
  target: Target,
  operation: (signal: AbortSignal) => Promise<ClientResult<T>>,
  deadline: AbortSignal,
): Promise<{ value: T | null; error: InstanceReadError | null }> {
  let outcome: ClientResult<T> | CircuitOpen;
  try {
    outcome = await fireOn(target.id, () => operation(deadline), {
      isFailure: countsAsBreakerFailure,
    });
  } catch (error) {
    logger.warn('gaps read threw', { instanceId: target.id, error });
    return { value: null, error: readError(target, 'upstream-error', 'The read did not complete.') };
  }

  if (isCircuitOpen(outcome)) {
    return { value: null, error: readError(target, 'circuit-open', outcome.reason) };
  }
  if (!outcome.ok) {
    return { value: null, error: readError(target, outcome.error.kind, outcome.error.reason) };
  }
  return { value: outcome.value, error: null };
}

/**
 * Belt-and-braces (AC4). `wanted/missing` is *supposed* to return only
 * monitored, fileless items, and on Radarr only ones past their availability
 * minimum — but the operator sees this list as "things I could act on", and an
 * unreleased film is a row whose only possible action is a search that cannot
 * find anything.
 *
 * Sonarr needs no date check: an episode that has not aired has no air date in
 * the past, and Sonarr excludes it from `wanted/missing` itself.
 */
function isActionable(record: ArrGapRecord, now: number): boolean {
  if (record.hasFile) return false;
  if (!record.monitored) return false;
  if (record.kind === 'episode') return true;

  // Radarr's own word for it. Trusted when present, because it already folds in
  // the instance's configured availability minimum.
  if (record.releaseStatus === 'released') return true;

  // An `announced` film with no date at all is the case this guard exists for.
  if (record.airDate === null) return false;

  const at = Date.parse(record.airDate);
  return Number.isNaN(at) ? false : at <= now;
}

/**
 * The join (ADR-3). Sonarr's group heading, target path and quality profile all
 * come from the cached series; Radarr's record carries its own.
 *
 * A missing snapshot degrades rather than failing: the series title falls back
 * to the id it was going to be looked up by, which is still more useful than
 * dropping the row.
 */
function attribute(target: Target, record: ArrGapRecord, library: LibrarySnapshot | null): Gap {
  const series = record.seriesId !== null
    ? library?.series.get(record.seriesId) ?? null
    : null;

  const profileId = record.kind === 'episode'
    ? series?.qualityProfileId ?? null
    : record.qualityProfileId;

  return {
    // Composite and three-part: a Sonarr episode id and a Radarr movie id can
    // collide, on the same instance id, across a two-instance setup. This is
    // also the key selection survives a refetch on, so it depends only on
    // identity — never on position.
    id: `${target.id}:${record.kind}:${record.upstreamId}`,
    instanceId: target.id,
    instanceLabel: target.label,
    instanceKind: target.kind,
    kind: record.kind,
    upstreamId: record.upstreamId,
    seriesId: record.seriesId,
    // Never dropped when the join misses (ADR-3): the row keeps its code and
    // title and says the series is unknown, rather than vanishing from a list
    // whose whole purpose is completeness. The id stays in the heading so two
    // uncached series do not collapse into one group.
    groupTitle: record.kind === 'movie'
      ? FILMS_GROUP
      : series?.title ?? `Series ${record.seriesId ?? '?'} (unknown)`,
    itemCode: record.itemCode,
    title: record.title,
    airDate: record.airDate,
    wantedQuality: profileId !== null
      ? library?.profiles.get(profileId) ?? null
      : null,
    targetPath: record.kind === 'movie' ? record.path : series?.path ?? null,
    lastSearchAt: record.lastSearchAt,
    // Never filled here. The inference costs one `/history` request per item
    // (ADR-6) and is read on demand from the inspector, never per row.
    inferred: null,
  };
}

export async function readGaps(
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<GapsResponse> {
  const observedAt = new Date().toISOString();
  const now = Date.parse(observedAt);
  const targets = enabledClients();
  const deadline = deadlineFor(options.signal);

  // flatMap rather than filter so the capability guard actually narrows the
  // client type — see `queue/aggregate.ts` for why a filter does not.
  const gapTargets: Target[] = targets.flatMap(
    (t) => (isGapClient(t.client) ? [{ ...t, client: t.client }] : []),
  );

  const errors: InstanceReadError[] = [];
  const gaps: Gap[] = [];
  const seriesReadAt: Record<string, string> = {};

  // One instance per entry, all in flight together; within an instance the
  // wanted list and the library join also run together, because they are
  // independent and the library is the slower of the two.
  const reads = await Promise.all(gapTargets.map(async (target) => {
    const [wanted, library] = await Promise.all([
      readFrom(target, (d) => target.client.wantedMissing(d), deadline),
      readFrom(
        target,
        (d) => readLibrary(target.id, target.client, { force: options.force, signal: d }),
        deadline,
      ),
    ]);
    return { target, wanted, library };
  }));

  for (const read of reads) {
    const { target } = read;

    if (read.wanted.error) {
      errors.push(read.wanted.error);
      continue;
    }
    if (!read.wanted.value) continue;

    // A failed join is reported but not fatal: the rows still render, just with
    // a fallback heading. Losing an entire Sonarr's gaps because its `/series`
    // read timed out would be the wrong trade.
    if (read.library.error) {
      errors.push({
        ...read.library.error,
        reason: `${read.library.error.reason} Series titles and paths are unavailable for this instance.`,
      });
    }
    if (read.library.value) seriesReadAt[target.id] = read.library.value.readAt;

    lastSuccessfulRead.set(target.id, observedAt);

    // This instance answered, so its previous entries are superseded. Instances
    // that failed keep theirs — dropping them would make an attach impossible
    // for rows the operator can still see on screen.
    for (const key of gapIndex.keys()) {
      if (key.startsWith(`${target.id}:`)) gapIndex.delete(key);
    }

    for (const record of read.wanted.value.records) {
      if (!isActionable(record, now)) continue;
      const gap = attribute(target, record, read.library.value);
      gaps.push(gap);
      gapIndex.set(gap.id, gap);
    }

    if (read.wanted.value.truncated) {
      // Surfaced, never swallowed — a list that is quietly cut off looks
      // identical to a library with fewer gaps than it really has.
      errors.push(readError(
        target,
        'upstream-error',
        `Only the first ${read.wanted.value.records.length} of ${read.wanted.value.totalRecords} missing items were read `
          + '— the page ceiling was reached. The rest of this instance\'s gaps are not shown.',
      ));
    }
  }

  const lastReadAt: Record<string, string> = {};
  for (const target of targets) {
    const at = lastSuccessfulRead.get(target.id);
    if (at) lastReadAt[target.id] = at;
  }

  return { gaps, errors, lastReadAt, seriesReadAt, observedAt };
}

/* ── One item's history, on demand (ADR-6) ───────────────────────────────── */

/**
 * Read only when the operator opens the inspector on a specific gap — never as
 * part of the fan-out. It is one request *per item*, and a grid of four hundred
 * rows would otherwise mean four hundred requests to the slowest participant in
 * the whole system.
 *
 * The events come back verbatim; the sentence composed from them is tagged
 * `source: 'inferred'` so the client cannot render helparr's reading as the
 * instance's own.
 */
export async function readGapHistory(
  instanceId: string,
  item: { kind: GapKind; upstreamId: number },
  signal?: AbortSignal,
): Promise<Attempt<GapHistoryRead>> {
  const entry = clientFor(instanceId);
  if (!entry) {
    return {
      ok: false,
      refusal: {
        kind: 'no-instance',
        reason: 'That instance is not registered, or it is disabled in Settings.',
      },
    };
  }
  if (!isGapClient(entry.client)) {
    return {
      ok: false,
      refusal: {
        kind: 'not-grabbable',
        reason: `${entry.label} is a ${entry.kind} — only Sonarr and Radarr track missing items.`,
      },
    };
  }

  const target: Target = {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    client: entry.client,
  };
  const read = await readFrom(
    target,
    (d) => target.client.historyFor(item, d),
    signal ?? AbortSignal.timeout(FANOUT_DEADLINE_MS),
  );

  // A failed history read is an empty inspector panel, not a failed request:
  // the row itself is still valid and the operator can still act on it.
  if (!read.value) return { ok: true, value: { events: [], inferred: null } };

  return { ok: true, value: { events: read.value, inferred: inferReason(read.value) } };
}
