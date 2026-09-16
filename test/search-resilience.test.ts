import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { deadPort, fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';
import type { SearchCriteria } from '@/lib/types';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { readQueue, resetQueueReadState } from '@/server/queue/aggregate';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import { listIndexers, runSearch } from '@/server/search/query';

/**
 * T22 / REQ-SEARCH-007, FR10; ADR-4, ADR-9.
 *
 * Prowlarr's aggregate response is a flat array with no per-indexer error
 * envelope, and zero results is not evidence of failure. So the only thing
 * standing between "LimeTorrents timed out" and "there is nothing to download"
 * is that helparr gave each indexer a request of its own and kept the answer.
 *
 * Three failures, three different reports, and the whole point is that they
 * stay distinguishable:
 *
 * - one indexer fails → results, plus that indexer by name
 * - every indexer fails → no results, and it is *not* an empty search
 * - Prowlarr itself is unreachable → an outage, scoped to this screen only
 */

const created: string[] = [];

function criteria(over: Partial<SearchCriteria> = {}): SearchCriteria {
  return { query: 'show', indexerIds: [], categories: [], minSeeders: 0, ...over };
}

function register(kind: 'prowlarr' | 'sonarr', label: string, baseUrl: string, apiKey: string) {
  const dto = createInstance({
    kind,
    label,
    baseUrl,
    credential: { type: 'api-key', apiKey },
  });
  created.push(dto.id);
  return dto;
}

describe('search degradation', () => {
  let prowlarr: FakeProwlarr;

  const ROSTER = [
    { id: 4, name: 'TorrentDay' },
    { id: 7, name: 'Nyaa' },
    { id: 9, name: 'LimeTorrents' },
  ];

  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({ apiKey: 'prowlarr-key', indexers: ROSTER });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    prowlarr.hits.length = 0;
    prowlarr.searches.length = 0;
    prowlarr.setIndexers(ROSTER);
    prowlarr.failSearches([]);
    prowlarr.setDown(false);
    for (const id of [4, 7, 9]) prowlarr.setResults(id, []);
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await prowlarr.close();
    cleanupTestDir();
  });

  it('names the indexer that failed and keeps the ones that answered', async () => {
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 2));
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 1));
    prowlarr.failSearches([9], 500);
    register('prowlarr', 'Prowlarr', prowlarr.url, 'prowlarr-key');

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    // The results are not withheld because one indexer went quiet.
    expect(outcome.read.results).toHaveLength(3);
    expect(outcome.read.indexersQueried).toBe(3);
    expect(outcome.read.indexersAnswered).toBe(2);

    expect(outcome.read.errors).toHaveLength(1);
    const [error] = outcome.read.errors;
    // By name and by id — "one indexer failed" is not an answer the operator
    // can act on, and the id is what the retry has to be scoped to.
    expect(error.indexer).toBe('LimeTorrents');
    expect(error.indexerId).toBe(9);
    expect(error.reason.length).toBeGreaterThan(0);
  });

  it('reports every indexer failing as a failure, not as an empty search', async () => {
    prowlarr.failSearches([4, 7, 9], 500);
    register('prowlarr', 'Prowlarr', prowlarr.url, 'prowlarr-key');

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(outcome.read.results).toEqual([]);
    // The distinguishing pair. A genuine no-results search has
    // `indexersAnswered === indexersQueried` and no errors; this has neither,
    // which is what stops the screen rendering "No results found".
    expect(outcome.read.indexersAnswered).toBe(0);
    expect(outcome.read.indexersQueried).toBe(3);
    expect(outcome.read.errors.map((e) => e.indexer).sort())
      .toEqual(['LimeTorrents', 'Nyaa', 'TorrentDay']);
    expect(outcome.read.truncated).toBe(false);
  });

  it('does not let one indexer answering 400 take the search surface down', async () => {
    // An HTTP 400 from one indexer's query is Prowlarr working correctly and
    // saying no. Counting it against the breaker would let a single malformed
    // tracker close the whole screen after two searches.
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 1));
    prowlarr.failSearches([4], 400);
    register('prowlarr', 'Prowlarr', prowlarr.url, 'prowlarr-key');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const outcome = await runSearch(criteria({ indexerIds: [4, 7] }));
      expect(outcome.available).toBe(true);
      if (!outcome.available) return;
      expect(outcome.read.results).toHaveLength(1);
      // The id survives an explicitly scoped search, which never reads the
      // roster — attributing this to Prowlarr itself would name the one party
      // that did answer.
      expect(outcome.read.errors.map((e) => e.indexerId)).toEqual([4]);
      expect(outcome.read.errors[0].indexer).toBe('Indexer 4');
    }

    // Every attempt reached the upstream — the circuit never opened.
    expect(prowlarr.searches).toHaveLength(8);
  });

  it('opens the circuit once every request is a transport failure', async () => {
    // Nothing listening: not "the tracker said no" but "Prowlarr is not there".
    const port = await deadPort();
    register('prowlarr', 'Prowlarr', `http://127.0.0.1:${port}`, 'prowlarr-key');

    // Scoped, so the roster read is skipped and the fan-out is what fails.
    const first = await runSearch(criteria({ indexerIds: [4, 7] }));
    expect(first.available).toBe(true);
    if (first.available) expect(first.read.indexersAnswered).toBe(0);

    await runSearch(criteria({ indexerIds: [4, 7] }));
    const third = await runSearch(criteria({ indexerIds: [4, 7] }));

    // The breaker is now the thing answering, and it says so as an outage —
    // the same DTO the mount call returns, so the screen has one renderer.
    expect(third.available).toBe(false);
    if (third.available) return;
    expect(third.outage.available).toBe(false);
    expect(third.outage.instanceLabel).toBe('Prowlarr');
    expect(third.outage.reason ?? '').not.toBe('');
    expect(third.outage.indexers).toEqual([]);
  });

  it('reports a Prowlarr outage as a 200-shaped answer, not an exception', async () => {
    prowlarr.setDown(true);
    const dto = register('prowlarr', 'Prowlarr', prowlarr.url, 'prowlarr-key');

    // The mount call is also how the screen learns Prowlarr is down: a
    // description of an outage, not a thrown error and not a 5xx (ADR-9).
    const roster = await listIndexers();
    expect(roster.available).toBe(false);
    expect(roster.instanceId).toBe(dto.id);
    expect(roster.instanceLabel).toBe('Prowlarr');
    expect(roster.baseUrl).toBe(prowlarr.url);
    expect(roster.reason ?? '').not.toBe('');
    expect(roster.indexers).toEqual([]);

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(false);
    if (outcome.available) return;
    expect(outcome.outage.instanceLabel).toBe('Prowlarr');
  });

  it('says so plainly when no Prowlarr is registered at all', async () => {
    const roster = await listIndexers();
    expect(roster.available).toBe(false);
    expect(roster.instanceId).toBeNull();
    // helparr ships no indexers, and the message has to point at the fix
    // rather than reading as a fault.
    expect(roster.reason).toContain('Settings');
  });

  it('keeps a Prowlarr outage off every other screen', async () => {
    // FR10: a degraded instance never blocks a screen that does not depend on
    // it. The queue is read from Sonarr and has nothing to do with Prowlarr.
    const sonarr: FakeArr = await startFakeArr({ apiKey: 'sonarr-key' });
    try {
      sonarr.setQueue(fakeQueue(4));
      prowlarr.setDown(true);
      register('prowlarr', 'Prowlarr', prowlarr.url, 'prowlarr-key');
      register('sonarr', 'Sonarr', sonarr.url, 'sonarr-key');

      const search = await runSearch(criteria());
      expect(search.available).toBe(false);

      const queue = await readQueue();
      expect(queue.errors).toEqual([]);
      expect(queue.records).toHaveLength(4);
      expect(queue.records.every((r) => r.instanceLabel === 'Sonarr')).toBe(true);
    } finally {
      resetQueueReadState();
      await sonarr.close();
    }
  });
});
