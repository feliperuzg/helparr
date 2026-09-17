import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';
import {
  describeUnresolved, resolveSavedScope, unresolvableScope, SAVED_SEARCH_LIMIT,
} from '@/lib/savedSearch';
import type { IndexerRead, SavedSearchRead } from '@/lib/types';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import { runSavedSearch } from '@/server/search/query';
import {
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  listSavedSearches,
  markSavedSearchRun,
  renameSavedSearch,
  SavedSearchError,
} from '@/server/search/savedSearches';

/**
 * T16 / FR11, FR12; REQ-SEARCH-011, -013, -014, -015; ADR-1, ADR-6.
 *
 * A saved search stores a question, not an answer. The failure modes this
 * guards are the ones that look like ordinary results on screen:
 *
 * - a scope that has gone stale collapses to an empty `indexerIds` list, which
 *   the search route reads as *every* indexer (ADR-1) — the operator asked for
 *   two private trackers and got the whole roster,
 * - an indexer removed and re-added under a new id is reported as gone when it
 *   is sitting right there,
 * - an unreachable Prowlarr is reported as "your indexers are gone",
 * - a rename kills the search, because the reference was a frozen id.
 */

const created: string[] = [];

function indexer(over: Partial<IndexerRead> & { id: number; name: string }): IndexerRead {
  return { protocol: 'torrent', enabled: true, healthy: true, ...over };
}

/** Only the fields the resolver reads — a full row is not needed to resolve. */
function definition(over: Partial<SavedSearchRead> = {}) {
  return {
    query: 'the expanse',
    indexers: [{ indexerId: 4, name: 'TorrentDay' }],
    categories: [5000],
    minSeeders: 0,
    ...over,
  };
}

afterAll(() => {
  closeDb();
  cleanupTestDir();
});

/* ── The store ────────────────────────────────────────────────────────────── */

describe('saved search store', () => {
  afterEach(() => {
    for (const saved of listSavedSearches()) deleteSavedSearch(saved.id);
  });

  it('round-trips the definition it was given', () => {
    const saved = createSavedSearch({
      name: '  Weekly sweep  ',
      query: 'the expanse 1080p',
      indexers: [{ indexerId: 4, name: 'TorrentDay' }, { indexerId: 9, name: 'NZBgeek' }],
      categories: [5000, 5040],
      minSeeders: 3,
    });

    // Trimmed on the way in, so the list sorts and the delete sentence reads
    // the way the operator typed it rather than the way they pasted it.
    expect(saved.name).toBe('Weekly sweep');
    expect(saved.query).toBe('the expanse 1080p');
    expect(saved.indexers).toEqual([
      { indexerId: 4, name: 'TorrentDay' },
      { indexerId: 9, name: 'NZBgeek' },
    ]);
    expect(saved.categories).toEqual([5000, 5040]);
    expect(saved.minSeeders).toBe(3);
    expect(saved.lastRunAt).toBeNull();

    expect(getSavedSearch(saved.id)).toEqual(saved);
  });

  it('refuses a duplicate name regardless of case, as a 409 rather than a 500', () => {
    createSavedSearch({
      name: 'Weekly sweep', query: 'q', indexers: [], categories: [], minSeeders: 0,
    });

    // The delete confirmation names the search being deleted (REQ-SEARCH-015),
    // and two rows called "weekly sweep" make that sentence a guess.
    let thrown: unknown;
    try {
      createSavedSearch({
        name: 'weekly SWEEP', query: 'other', indexers: [], categories: [], minSeeders: 0,
      });
    } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(SavedSearchError);
    expect((thrown as SavedSearchError).status).toBe(409);
    expect(listSavedSearches()).toHaveLength(1);
  });

  it('renames without touching the definition, and refuses an empty name', () => {
    const saved = createSavedSearch({
      name: 'First', query: 'the expanse', indexers: [{ indexerId: 4, name: 'TorrentDay' }],
      categories: [5000], minSeeders: 2,
    });

    const renamed = renameSavedSearch(saved.id, 'Second');
    expect(renamed.name).toBe('Second');
    // Rename only. A saved search whose query can be rewritten under its own
    // name is one the operator can no longer trust to be what they saved.
    expect(renamed.query).toBe('the expanse');
    expect(renamed.indexers).toEqual(saved.indexers);
    expect(renamed.minSeeders).toBe(2);

    expect(() => renameSavedSearch(saved.id, '   ')).toThrow(SavedSearchError);
    expect(getSavedSearch(saved.id)?.name).toBe('Second');
  });

  it('reports a repeat delete as already gone rather than as a success', () => {
    const saved = createSavedSearch({
      name: 'Gone', query: 'q', indexers: [], categories: [], minSeeders: 0,
    });

    expect(deleteSavedSearch(saved.id)).toBe(true);
    expect(deleteSavedSearch(saved.id)).toBe(false);
    expect(getSavedSearch(saved.id)).toBeNull();
  });

  it('sorts the list by name, case-insensitively', () => {
    for (const name of ['zeta', 'Alpha', 'beta']) {
      createSavedSearch({ name, query: 'q', indexers: [], categories: [], minSeeders: 0 });
    }
    // A menu that reorders itself every time something is saved is a menu the
    // operator has to re-read.
    expect(listSavedSearches().map((s) => s.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('caps the list rather than letting it grow past what can be scanned', () => {
    for (let i = 0; i < SAVED_SEARCH_LIMIT; i += 1) {
      createSavedSearch({
        name: `search ${i}`, query: 'q', indexers: [], categories: [], minSeeders: 0,
      });
    }

    let thrown: unknown;
    try {
      createSavedSearch({
        name: 'one too many', query: 'q', indexers: [], categories: [], minSeeders: 0,
      });
    } catch (error) { thrown = error; }

    expect((thrown as SavedSearchError).status).toBe(409);
    expect(listSavedSearches()).toHaveLength(SAVED_SEARCH_LIMIT);
  });

  it('stamps a run without disturbing the definition', () => {
    const saved = createSavedSearch({
      name: 'Stamped', query: 'q', indexers: [], categories: [], minSeeders: 0,
    });

    markSavedSearchRun(saved.id);

    const after = getSavedSearch(saved.id) as SavedSearchRead;
    expect(after.lastRunAt).not.toBeNull();
    expect(after.query).toBe('q');
    // Audit only. Nothing schedules off this — every run spends indexer quota.
    expect(after.updatedAt).toBe(saved.updatedAt);
  });
});

/* ── The resolution rule ──────────────────────────────────────────────────── */

describe('saved scope resolution', () => {
  it('follows an indexer across a rename, because the id is what Prowlarr keeps', () => {
    const resolution = resolveSavedScope(
      definition(),
      [indexer({ id: 4, name: 'TorrentDay (private)' })],
    );

    expect(resolution.criteria.indexerIds).toEqual([4]);
    expect(resolution.unresolved).toEqual([]);
    expect(resolution.resolved[0]).toMatchObject({
      indexerId: 4, name: 'TorrentDay', currentName: 'TorrentDay (private)', rematchedByName: false,
    });
    expect(describeUnresolved(resolution)).toBeNull();
  });

  it('follows an indexer across a remove-and-re-add, because the name survives it', () => {
    // Prowlarr hands out a new id when an indexer is added back. Refusing to
    // follow that would be permanent death by a slower route.
    const resolution = resolveSavedScope(
      definition(),
      [indexer({ id: 41, name: 'torrentday' })],
    );

    expect(resolution.criteria.indexerIds).toEqual([41]);
    expect(resolution.resolved[0]).toMatchObject({ indexerId: 41, rematchedByName: true });
    expect(resolution.runnable).toBe(true);
  });

  it('does not let a name match steal a reference an id match already holds', () => {
    const resolution = resolveSavedScope(
      definition({ indexers: [{ indexerId: 4, name: 'TorrentDay' }] }),
      [
        indexer({ id: 4, name: 'Nyaa' }),
        indexer({ id: 7, name: 'TorrentDay' }),
      ],
    );

    // The id is consulted first and wins outright: id 4 is still there, so the
    // saved reference is id 4's, whatever it is called now.
    expect(resolution.criteria.indexerIds).toEqual([4]);
    expect(resolution.resolved[0]).toMatchObject({ currentName: 'Nyaa', rematchedByName: false });
  });

  it('names what is missing and still runs on what is left', () => {
    const resolution = resolveSavedScope(
      definition({
        indexers: [{ indexerId: 4, name: 'TorrentDay' }, { indexerId: 9, name: 'NZBgeek' }],
      }),
      [indexer({ id: 4, name: 'TorrentDay' })],
    );

    expect(resolution.runnable).toBe(true);
    expect(resolution.criteria.indexerIds).toEqual([4]);
    expect(resolution.unresolved).toEqual([{ indexerId: 9, name: 'NZBgeek' }]);
    // Named, not counted: "1 indexer is gone" only tells the operator to go and
    // find out which, which is the work this sentence exists to save.
    expect(describeUnresolved(resolution))
      .toBe('NZBgeek is no longer in Prowlarr. This search will run without it.');
  });

  it('pluralizes the missing-indexer sentence rather than saying "it" about three', () => {
    const resolution = resolveSavedScope(
      definition({
        indexers: [
          { indexerId: 4, name: 'TorrentDay' },
          { indexerId: 9, name: 'NZBgeek' },
          { indexerId: 11, name: 'Nyaa' },
        ],
      }),
      [indexer({ id: 4, name: 'TorrentDay' })],
    );

    expect(describeUnresolved(resolution))
      .toBe('NZBgeek, Nyaa are no longer in Prowlarr. This search will run without them.');
  });

  it('refuses a scope that resolved to nothing instead of widening it to all', () => {
    const resolution = resolveSavedScope(
      definition({ indexers: [{ indexerId: 7, name: 'Nyaa' }] }),
      [indexer({ id: 4, name: 'TorrentDay' })],
    );

    // This is the whole point. `indexerIds: []` reads as *every* indexer to the
    // search route (ADR-1), so the emptiness must never be the signal — the
    // refusal is carried by `runnable`.
    expect(resolution.criteria.indexerIds).toEqual([]);
    expect(resolution.runnable).toBe(false);
    expect(describeUnresolved(resolution))
      .toBe('Nyaa is no longer in Prowlarr, and this search was scoped to nothing else.');
  });

  it('leaves an unscoped saved search unscoped, which is the one scope that cannot go stale', () => {
    const resolution = resolveSavedScope(definition({ indexers: [] }), []);

    expect(resolution.criteria.indexerIds).toEqual([]);
    expect(resolution.runnable).toBe(true);
    expect(resolution.unresolved).toEqual([]);
  });

  it('claims nothing missing when the roster could not be read at all', () => {
    const resolution = unresolvableScope(definition({
      indexers: [{ indexerId: 4, name: 'TorrentDay' }, { indexerId: 9, name: 'NZBgeek' }],
    }));

    expect(resolution.rosterAvailable).toBe(false);
    // An unreachable Prowlarr is not evidence that any indexer is gone.
    expect(resolution.unresolved).toEqual([]);
    expect(resolution.runnable).toBe(false);
    expect(describeUnresolved(resolution)).toBeNull();
  });
});

/* ── Running one, end to end ──────────────────────────────────────────────── */

describe('running a saved search', () => {
  let prowlarr: FakeProwlarr;

  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'TorrentDay' }, { id: 9, name: 'NZBgeek', protocol: 'usenet' }],
    });
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 3));
    prowlarr.setResults(9, fakeReleases(9, 'NZBgeek', 2));
    prowlarr.setResults(null, fakeReleases(4, 'TorrentDay', 3));

    const dto = createInstance({
      kind: 'prowlarr',
      label: 'Prowlarr',
      baseUrl: prowlarr.url,
      credential: { type: 'api-key', apiKey: 'prowlarr-key' },
    });
    created.push(dto.id);
  });

  afterEach(() => {
    prowlarr.setIndexers([{ id: 4, name: 'TorrentDay' }, { id: 9, name: 'NZBgeek', protocol: 'usenet' }]);
    prowlarr.setDown(false);
    prowlarr.searches.length = 0;
    prowlarr.hits.length = 0;
    disposeAllBreakers();
    for (const saved of listSavedSearches()) deleteSavedSearch(saved.id);
  });

  afterAll(async () => {
    for (const id of created.splice(0)) deleteInstance(id);
    await prowlarr.close();
  });

  it('runs against the roster as it is now, not as it was when saved', async () => {
    const saved = createSavedSearch({
      name: 'Both', query: 'the expanse',
      indexers: [{ indexerId: 4, name: 'TorrentDay' }, { indexerId: 9, name: 'NZBgeek' }],
      categories: [], minSeeders: 0,
    });

    prowlarr.setIndexers([{ id: 4, name: 'TorrentDay' }]);

    const outcome = await runSavedSearch(saved);

    expect(outcome.resolution.unresolved).toEqual([{ indexerId: 9, name: 'NZBgeek' }]);
    expect(outcome.search?.available).toBe(true);
    // The search really was narrowed — the indexer that is gone was not asked.
    expect(prowlarr.searches.at(-1)?.indexerIds).toEqual(['4']);
  });

  it('refuses rather than searching every indexer when the whole scope is gone', async () => {
    const saved = createSavedSearch({
      name: 'All gone', query: 'the expanse',
      indexers: [{ indexerId: 9, name: 'NZBgeek' }],
      categories: [], minSeeders: 0,
    });

    prowlarr.setIndexers([{ id: 4, name: 'TorrentDay' }]);

    const outcome = await runSavedSearch(saved);

    expect(outcome.resolution.runnable).toBe(false);
    // No results *and* no search: the refusal has to reach the operator as a
    // refusal, not as an empty result set they would read as "nothing found".
    expect(outcome.search).toBeNull();
    expect(prowlarr.searches).toHaveLength(0);
  });

  it('says Prowlarr is unreachable without naming any indexer as gone', async () => {
    const saved = createSavedSearch({
      name: 'Down', query: 'the expanse',
      indexers: [{ indexerId: 4, name: 'TorrentDay' }],
      categories: [], minSeeders: 0,
    });

    prowlarr.setDown(true);

    const outcome = await runSavedSearch(saved);

    expect(outcome.resolution.rosterAvailable).toBe(false);
    expect(outcome.resolution.unresolved).toEqual([]);
    expect(outcome.search?.available).toBe(false);
  });

  it('reads the roster once for an unscoped search, because the fan-out reads it too', async () => {
    const saved = createSavedSearch({
      name: 'Everything', query: 'the expanse',
      indexers: [], categories: [], minSeeders: 0,
    });

    const outcome = await runSavedSearch(saved);

    expect(outcome.resolution.runnable).toBe(true);
    expect(outcome.search?.available).toBe(true);
    // Exactly one roster read. `runSearch` reads it itself to expand "all", so
    // resolving first would make an unscoped saved search cost two.
    const rosterReads = prowlarr.hits.filter((hit) => hit.path.split('?')[0] === '/api/v1/indexer');
    expect(rosterReads).toHaveLength(1);
  });
});
