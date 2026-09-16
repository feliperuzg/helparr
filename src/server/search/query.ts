import 'server-only';

import { SEARCH_RESULT_CAP } from '@/lib/types';
import type {
  IndexerError,
  IndexerRead,
  ReleaseRead,
  SearchAvailability,
  SearchCriteria,
  SearchRead,
} from '@/lib/types';
import {
  countsAsBreakerFailure,
  isSearchClient,
  type ClientFailure,
  type ClientResult,
  type SearchClient,
  type SearchScope,
} from '@/server/clients/types';
import { enabledClients, getInstance } from '@/server/instances/registry';
import { registerSecret, logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen, type CircuitOpen } from '@/server/resilience/breaker';

/**
 * The Prowlarr fan-out (REQ-SEARCH-001..004, -007, -008; ADR-4, ADR-8).
 *
 * One scoped request per indexer, all in flight together, inside a single
 * breaker call. Prowlarr's aggregate response is a flat array with no
 * per-indexer error envelope, and zero results is not evidence of failure — so
 * naming the indexer that went quiet is only possible when it had a request of
 * its own.
 *
 * Like the queue aggregate, this module has no failure mode of its own. An
 * indexer that times out becomes an entry in `errors`; only Prowlarr itself
 * being unreachable produces the outage branch, and even that is a returned
 * value rather than a throw.
 */

/**
 * Deviation from ADR-4, recorded deliberately.
 *
 * ADR-4 says the `All` case "needs no attribution" and can collapse to one
 * unscoped request. Both design artifacts disagree with that clause —
 * `wireframes/screen-search.md` draws the `All` chip selected *while* naming
 * LimeTorrents as the indexer that did not respond, and `sequence-search.md`
 * shows `indexerIds: []` fanning out to three scoped requests. REQ-SEARCH-007
 * sides with the artifacts: the failing indexer has to be named, and `All` is
 * the default scope, so the one case that needs attribution most is the one
 * that clause would deny it to.
 *
 * ADR-4's actual decision — one scoped request per indexer, concurrently,
 * inside one `fireOn` call — is preserved unchanged. What changes is only where
 * the id list comes from when the operator selected none: the enabled roster
 * rather than nothing. ADR-4 already answers the cost objection — Prowlarr
 * performs the same N indexer queries either way.
 */
const ALL_MEANS_THE_ROSTER = true;

/**
 * helparr's own ceiling (ADR-8, NFR6). It cannot save any network or indexer
 * work — Prowlarr accepts `limit` and ignores it, measured at `limit=25`
 * returning 570 — so it buys render cost only, and it is always disclosed.
 *
 * Defined in `@/lib/types` and re-exported here: the browser has to render the
 * same number this module cuts at, or the disclosure is a second, wrong claim.
 */
export { SEARCH_RESULT_CAP };

/** Per-indexer budget. The client's own search deadline is the longer backstop. */
const INDEXER_DEADLINE_MS = 30_000;

interface Target {
  id: string;
  label: string;
  baseUrl: string;
  client: SearchClient;
}

/**
 * The Prowlarr instance, or null when none is registered or all are disabled.
 *
 * Search is single-instance by design: Prowlarr is itself an aggregator, so a
 * second one would mean two rosters with colliding indexer ids and no way to
 * tell the operator which `4` a result came from. The first enabled one wins
 * and the rest are ignored rather than silently merged.
 */
function prowlarrTarget(): Target | null {
  for (const entry of enabledClients()) {
    if (!isSearchClient(entry.client)) continue;
    return {
      id: entry.id,
      label: entry.label,
      baseUrl: entry.client.baseUrl,
      client: entry.client,
    };
  }
  return null;
}

function unavailable(
  target: Target | null,
  reason: string,
): SearchAvailability {
  return {
    available: false,
    instanceId: target?.id ?? null,
    instanceLabel: target?.label ?? null,
    baseUrl: target?.baseUrl ?? null,
    reason,
    // Straight from the health poller's own record, so the outage callout can
    // say how long ago the instance last answered anything at all.
    lastSeen: target ? getInstance(target.id)?.lastCheckedAt ?? null : null,
    indexers: [],
  };
}

const NO_PROWLARR =
  'No Prowlarr instance is registered and enabled. Add one in Settings — '
  + 'searching needs an indexer manager, and helparr ships none.';

function deadlineFor(external?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(INDEXER_DEADLINE_MS);
  return external ? AbortSignal.any([external, own]) : own;
}

/** Runs one Prowlarr read through the breaker, flattening every outcome. */
async function readThrough<T>(
  target: Target,
  operation: () => Promise<ClientResult<T>>,
): Promise<ClientResult<T>> {
  let outcome: ClientResult<T> | CircuitOpen;
  try {
    outcome = await fireOn(target.id, operation, { isFailure: countsAsBreakerFailure });
  } catch (error) {
    logger.warn('prowlarr read threw', { instanceId: target.id, error });
    return {
      ok: false,
      error: { kind: 'upstream-error', reason: 'The read did not complete.' },
    };
  }

  if (isCircuitOpen(outcome)) {
    return { ok: false, error: { kind: 'unreachable', reason: outcome.reason } };
  }
  return outcome;
}

/**
 * The indexer roster, for the toolbar chips and for resolving `All`.
 *
 * Reported as availability rather than as a bare list because the mount call is
 * also how the screen learns Prowlarr is down: a 200 describing an outage, not
 * a 5xx (ADR-9). The request was well-formed and it was answered.
 */
export async function listIndexers(signal?: AbortSignal): Promise<SearchAvailability> {
  const target = prowlarrTarget();
  if (!target) return unavailable(null, NO_PROWLARR);

  const roster = await readThrough(target, () => target.client.indexers(signal));
  if (!roster.ok) return unavailable(target, roster.error.reason);

  return {
    available: true,
    instanceId: target.id,
    instanceLabel: target.label,
    baseUrl: target.baseUrl,
    reason: null,
    lastSeen: getInstance(target.id)?.lastCheckedAt ?? null,
    indexers: roster.value,
  };
}

export type SearchOutcome =
  | { available: true; read: SearchRead }
  /** Same DTO the mount call returns, so the screen has one outage renderer. */
  | { available: false; outage: SearchAvailability };

/**
 * A transport failure is the upstream not answering. An HTTP 400 from one
 * indexer's query is Prowlarr working correctly and saying no, and must not
 * count towards opening its breaker — otherwise one malformed tracker takes
 * the whole search surface down with it.
 */
function isTransportFailure(error: ClientFailure): boolean {
  return error.kind === 'unreachable' || error.kind === 'timeout';
}

interface IndexerRun {
  /**
   * The indexer this request was scoped to. Null only for the single unscoped
   * request, which is the one case where no id exists to attribute a failure to.
   *
   * Carried separately from `indexer` because the two are known at different
   * times: an explicitly scoped search never reads the roster, so the id is
   * present while the record is not — and reporting that failure as `-1` would
   * hand REQ-SEARCH-007 an indexer the operator cannot recognise.
   */
  indexerId: number | null;
  /** The roster record, when the roster was read. */
  indexer: IndexerRead | null;
  result: ClientResult<ReleaseRead[]>;
}

function scopeFor(criteria: SearchCriteria, indexerId: number | null): SearchScope {
  return {
    query: criteria.query,
    indexerIds: indexerId === null ? [] : [indexerId],
    categories: criteria.categories,
  };
}

/**
 * Deduped by `guid`, which is the indexer's own identity for a release.
 *
 * Two indexers listing the same torrent produce two guids and stay two rows —
 * that is correct, because the operator is choosing which indexer to grab from.
 * The dedupe only collapses the genuine duplicate: the same guid arriving twice
 * because a scoped and an unscoped request overlapped.
 */
function dedupe(releases: ReleaseRead[]): ReleaseRead[] {
  const seen = new Set<string>();
  const out: ReleaseRead[] = [];
  for (const release of releases) {
    const key = release.guid || `${release.indexerId}:${release.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(release);
  }
  return out;
}

/** Seeders descending, nulls last — a usenet release has none, not zero of them. */
function bySeedersDesc(a: ReleaseRead, b: ReleaseRead): number {
  if (a.seeders === b.seeders) return 0;
  if (a.seeders === null) return 1;
  if (b.seeders === null) return -1;
  return b.seeders - a.seeders;
}

export async function runSearch(
  criteria: SearchCriteria,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const target = prowlarrTarget();
  if (!target) return { available: false, outage: unavailable(null, NO_PROWLARR) };

  // The roster is read first because `All` resolves through it (see
  // ALL_MEANS_THE_ROSTER). A roster read that fails is Prowlarr itself being
  // unreachable, not an indexer problem, so it is the outage branch.
  let roster: IndexerRead[] = [];
  if (criteria.indexerIds.length === 0 && ALL_MEANS_THE_ROSTER) {
    const read = await readThrough(target, () => target.client.indexers(signal));
    if (!read.ok) return { available: false, outage: unavailable(target, read.error.reason) };
    roster = read.value;
  }

  const byId = new Map(roster.map((indexer) => [indexer.id, indexer]));
  const scoped = criteria.indexerIds.length > 0
    ? criteria.indexerIds
    // Disabled indexers are Prowlarr's own "do not contact"; querying them
    // would produce a named failure for something the operator switched off.
    : roster.filter((indexer) => indexer.enabled).map((indexer) => indexer.id);

  const deadline = deadlineFor(signal);

  // One breaker call around the whole fan-out. Firing each sub-request through
  // the breaker separately would let a single sick indexer contribute N
  // failures and open Prowlarr's circuit on its own (ADR-4).
  let runs: IndexerRun[];
  try {
    const outcome = await fireOn(
      target.id,
      async (): Promise<IndexerRun[]> => {
        const ids: Array<number | null> = scoped.length > 0 ? scoped : [null];
        return Promise.all(ids.map(async (id) => ({
          indexerId: id,
          indexer: id === null ? null : byId.get(id) ?? null,
          result: await target.client.search(scopeFor(criteria, id), deadline),
        })));
      },
      {
        // Only a total transport failure is Prowlarr's fault. One indexer
        // timing out is the normal case this whole screen is built around.
        isFailure: (value) => value.length > 0
          && value.every((run) => !run.result.ok && isTransportFailure(run.result.error)),
      },
    );

    if (isCircuitOpen(outcome)) {
      return { available: false, outage: unavailable(target, outcome.reason) };
    }
    runs = outcome;
  } catch (error) {
    logger.warn('prowlarr search threw', { instanceId: target.id, error });
    return {
      available: false,
      outage: unavailable(target, 'The search did not complete.'),
    };
  }

  const errors: IndexerError[] = [];
  const merged: ReleaseRead[] = [];
  let answered = 0;

  for (const run of runs) {
    if (!run.result.ok) {
      errors.push({
        indexerId: run.indexerId ?? -1,
        // The roster name when we have it, the id when we do not, and only the
        // instance label for the unscoped request — where the failure really is
        // Prowlarr's and not any one indexer's.
        indexer: run.indexer?.name
          ?? (run.indexerId === null ? target.label : `Indexer ${run.indexerId}`),
        reason: run.result.error.reason,
      });
      continue;
    }
    answered += 1;
    merged.push(...run.result.value);
  }

  // Every download URL carries Prowlarr's own API key. Registering here — the
  // moment the value enters the process — means it is scrubbed from any log
  // line written downstream, including an upstream error that echoes it back
  // (NFR2, ADR-7).
  for (const release of merged) {
    if (release.downloadUrl) registerSecret(release.downloadUrl);
  }

  const filtered = dedupe(merged).filter(
    // `null` seeders are usenet, which the filter has no opinion about: a
    // seeder threshold cannot exclude a protocol that has no seeders.
    (release) => release.seeders === null || release.seeders >= criteria.minSeeders,
  );

  const truncated = filtered.length > SEARCH_RESULT_CAP;
  const results = truncated
    ? [...filtered].sort(bySeedersDesc).slice(0, SEARCH_RESULT_CAP)
    : filtered;

  return {
    available: true,
    read: {
      results,
      errors,
      indexersQueried: runs.length,
      indexersAnswered: answered,
      truncated,
    },
  };
}
