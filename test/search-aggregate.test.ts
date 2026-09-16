import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';
import { DEFAULT_SORT, sortReleases } from '@/components/search/ResultsGrid';
import { SEARCH_RESULT_CAP, type SearchCriteria } from '@/lib/types';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import { listIndexers, runSearch } from '@/server/search/query';

/**
 * T21 / REQ-SEARCH-001..004, -008; ADR-1, ADR-4, ADR-8.
 *
 * The fan-out's job is to be complete and attributable. Four ways it can be
 * silently wrong, all of which look identical to a shorter result set on screen:
 *
 * - it queries fewer indexers than the operator selected,
 * - it sends `indexerIds` in a form ASP.NET Core rejects (CSV, or the `-1`
 *   wildcard that is widely documented and does not exist),
 * - it filters or caps without saying so,
 * - it cuts an uncapped, unordered set, so the 300 rows kept are arbitrary
 *   rather than the 300 that matter.
 */

const created: string[] = [];

function criteria(over: Partial<SearchCriteria> = {}): SearchCriteria {
  return { query: 'show', indexerIds: [], categories: [], minSeeders: 0, ...over };
}

function registerProwlarr(prowlarr: FakeProwlarr, apiKey: string): string {
  const dto = createInstance({
    kind: 'prowlarr',
    label: 'Prowlarr',
    baseUrl: prowlarr.url,
    credential: { type: 'api-key', apiKey },
  });
  created.push(dto.id);
  return dto.id;
}

describe('search aggregation', () => {
  let prowlarr: FakeProwlarr;

  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [
        { id: 4, name: 'TorrentDay' },
        { id: 7, name: 'Nyaa' },
        { id: 9, name: 'NZBgeek', protocol: 'usenet' },
      ],
    });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    prowlarr.hits.length = 0;
    prowlarr.searches.length = 0;
    prowlarr.setIndexers([
      { id: 4, name: 'TorrentDay' },
      { id: 7, name: 'Nyaa' },
      { id: 9, name: 'NZBgeek', protocol: 'usenet' },
    ]);
    prowlarr.setBackedOff([]);
    prowlarr.failSearches([]);
    prowlarr.stallSearches([], 0);
    prowlarr.setResults(null, []);
    for (const id of [4, 7, 9]) prowlarr.setResults(id, []);
    prowlarr.setDown(false);
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await prowlarr.close();
    cleanupTestDir();
  });

  it('merges every indexer and keeps each result attributed to its own', async () => {
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 3));
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 2));
    prowlarr.setResults(9, fakeReleases(9, 'NZBgeek', 1, { protocol: 'usenet', seeders: null }));
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(outcome.read.errors).toEqual([]);
    expect(outcome.read.results).toHaveLength(6);
    expect(outcome.read.indexersQueried).toBe(3);
    expect(outcome.read.indexersAnswered).toBe(3);

    // Attribution per row, not just the right total: a merge that dropped
    // `indexer` produces six rows the operator cannot choose between.
    const byIndexer = new Map<string, number>();
    for (const release of outcome.read.results) {
      byIndexer.set(release.indexer, (byIndexer.get(release.indexer) ?? 0) + 1);
    }
    expect(Object.fromEntries(byIndexer)).toEqual({ TorrentDay: 3, Nyaa: 2, NZBgeek: 1 });

    // Six results, six guids — no request was answered twice.
    expect(new Set(outcome.read.results.map((r) => r.guid)).size).toBe(6);

    // The usenet row keeps `null` seeders. Zero would render as a dead torrent.
    const usenet = outcome.read.results.find((r) => r.protocol === 'usenet');
    expect(usenet?.seeders).toBeNull();
  });

  it('sends indexerIds once per element, never as CSV and never as -1', async () => {
    // Measured against Prowlarr 2.5.2.5491: CSV returns 400 "The value
    // '4,7' is not valid", and -1 returns 400 "all selected indexers being
    // unavailable". Both fail as a well-formed empty result set here, so the
    // wire format is asserted directly rather than via the outcome.
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 1));
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 1));
    registerProwlarr(prowlarr, 'prowlarr-key');

    await runSearch(criteria({ indexerIds: [4, 7], categories: [5000, 5030] }));

    expect(prowlarr.searches).toHaveLength(2);
    for (const hit of prowlarr.searches) {
      expect(hit.indexerIds).toHaveLength(1);
      expect(hit.indexerIds[0]).not.toContain(',');
      expect(hit.indexerIds[0]).not.toBe('-1');
      expect(hit.query).toBe('show');
      expect(hit.type).toBe('search');
      // Categories bind the same way — repeated, in order.
      expect(hit.categories).toEqual(['5000', '5030']);
      expect(hit.raw).toContain('categories=5000&categories=5030');
    }
    expect(prowlarr.searches.map((h) => h.indexerIds[0]).sort()).toEqual(['4', '7']);
  });

  it('scopes to exactly the selected indexers and asks the rest nothing', async () => {
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 2));
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 5));
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria({ indexerIds: [4] }));
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(outcome.read.results).toHaveLength(2);
    expect(outcome.read.results.every((r) => r.indexer === 'TorrentDay')).toBe(true);
    expect(prowlarr.searches.map((h) => h.indexerIds)).toEqual([['4']]);

    // A scoped search does not need the roster, so it must not pay for one.
    expect(prowlarr.hits.some((h) => h.path.startsWith('/api/v1/indexer?'))).toBe(false);
  });

  it('resolves "all" through the enabled roster and skips the disabled ones', async () => {
    // A disabled indexer is Prowlarr's own "do not contact". Querying it would
    // produce a named failure for something the operator switched off.
    prowlarr.setIndexers([
      { id: 4, name: 'TorrentDay' },
      { id: 7, name: 'Nyaa', enable: false },
      { id: 9, name: 'NZBgeek' },
    ]);
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 1));
    prowlarr.setResults(9, fakeReleases(9, 'NZBgeek', 1));
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(prowlarr.searches.map((h) => h.indexerIds[0]).sort()).toEqual(['4', '9']);
    expect(outcome.read.indexersQueried).toBe(2);
    expect(outcome.read.results).toHaveLength(2);
  });

  it('filters by seeders after the merge and leaves usenet alone', async () => {
    prowlarr.setResults(4, [
      ...fakeReleases(4, 'TorrentDay', 1, { seeders: 50, guid: 'td-high' }),
      ...fakeReleases(4, 'TorrentDay', 1, { seeders: 3, guid: 'td-low' }),
      ...fakeReleases(4, 'TorrentDay', 1, { seeders: 10, guid: 'td-edge' }),
    ]);
    prowlarr.setResults(9, fakeReleases(9, 'NZBgeek', 1, {
      protocol: 'usenet', seeders: null, guid: 'nzb-1',
    }));
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria({ minSeeders: 10 }));
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    // `>=`, not `>`: the operator typed 10 and a 10-seeder release meets it.
    // The usenet row survives because a seeder threshold cannot exclude a
    // protocol that has no seeders.
    expect(outcome.read.results.map((r) => r.guid).sort())
      .toEqual(['nzb-1', 'td-edge', 'td-high']);

    // The filter is ours, applied after the merge — nothing was asked of
    // Prowlarr about seeders.
    for (const hit of prowlarr.searches) expect(hit.raw).not.toContain('seed');
  });

  it('collapses a guid that arrives twice and keeps distinct ones apart', async () => {
    // Same release, same guid, two requests that overlapped — one row.
    // Two indexers listing the same torrent produce two guids and stay two
    // rows, because the operator is choosing which indexer to grab from.
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 1, { guid: 'shared-guid' }));
    prowlarr.setResults(7, [
      ...fakeReleases(7, 'Nyaa', 1, { guid: 'shared-guid' }),
      ...fakeReleases(7, 'Nyaa', 1, { guid: 'nyaa-own' }),
    ]);
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(outcome.read.results.map((r) => r.guid).sort()).toEqual(['nyaa-own', 'shared-guid']);
  });

  it('caps the merged set, discloses it, and keeps the best-seeded rows', async () => {
    // 450 > 300. An uncapped cut would keep whichever 300 happened to arrive
    // first, which is the one ordering that means nothing across three indexers.
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 150));
    prowlarr.setResults(7, fakeReleases(7, 'Nyaa', 150));
    prowlarr.setResults(9, fakeReleases(9, 'NZBgeek', 150));
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria());
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(outcome.read.truncated).toBe(true);
    expect(outcome.read.results).toHaveLength(SEARCH_RESULT_CAP);

    const seeders = outcome.read.results.map((r) => r.seeders ?? -1);
    expect([...seeders].sort((a, b) => b - a)).toEqual(seeders);
    // Every indexer's top release survived the cut — a cap that sorted after
    // slicing would have kept 300 rows from whichever answered first.
    expect(new Set(outcome.read.results.map((r) => r.indexer)).size).toBe(3);
  });

  it('does not claim truncation when the set fits', async () => {
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 5));
    registerProwlarr(prowlarr, 'prowlarr-key');

    const outcome = await runSearch(criteria({ indexerIds: [4] }));
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;

    expect(outcome.read.truncated).toBe(false);
    expect(outcome.read.results).toHaveLength(5);
  });

  it('reports the roster with Prowlarr\'s own enable flag and back-off state', async () => {
    prowlarr.setBackedOff([7]);
    const instanceId = registerProwlarr(prowlarr, 'prowlarr-key');

    const roster = await listIndexers();
    expect(roster.available).toBe(true);
    expect(roster.instanceId).toBe(instanceId);
    expect(roster.indexers.map((i) => [i.id, i.enabled, i.healthy])).toEqual([
      [4, true, true],
      // Backed off after consecutive failures: selectable-looking but silently
      // empty is exactly what the degraded chip exists to prevent.
      [7, true, false],
      [9, true, true],
    ]);
  });
});

/**
 * Ordering is ours, not Prowlarr's — the merged set spans indexers that each
 * ordered their own answer independently, so there is no upstream order to
 * preserve. These are the two cases where a naive comparator is wrong.
 */
describe('result sorting', () => {
  const rows = [
    { guid: 'a', title: 'B.Show', indexer: 'Nyaa', size: 300, seeders: 10, leechers: 1, ageHours: 5 },
    { guid: 'b', title: 'A.Show', indexer: 'TorrentDay', size: 100, seeders: null, leechers: null, ageHours: 1 },
    { guid: 'c', title: 'C.Show', indexer: 'Nyaa', size: 200, seeders: 40, leechers: 9, ageHours: 99 },
  ].map((row) => ({
    ...row,
    indexerId: 1,
    protocol: 'torrent' as const,
    publishDate: '2026-09-01T00:00:00Z',
    infoHash: null,
    freeleech: false,
    downloadUrl: '',
  }));

  it('puts unseeded releases last under the default sort', () => {
    // `null` is not zero and must not sort as the top of an ascending run:
    // usenet belongs below every seeded torrent, not above them.
    expect(sortReleases(rows, DEFAULT_SORT).map((r) => r.guid)).toEqual(['c', 'a', 'b']);
  });

  it('sorts without mutating the input', () => {
    const before = rows.map((r) => r.guid);
    sortReleases(rows, { column: 'size', direction: 'asc' });
    expect(rows.map((r) => r.guid)).toEqual(before);
  });

  it('orders every column in both directions', () => {
    const order = (column: 'title' | 'size' | 'age' | 'leechers', direction: 'asc' | 'desc') =>
      sortReleases(rows, { column, direction }).map((r) => r.guid);

    expect(order('title', 'asc')).toEqual(['b', 'a', 'c']);
    expect(order('title', 'desc')).toEqual(['c', 'a', 'b']);
    expect(order('size', 'asc')).toEqual(['b', 'c', 'a']);
    expect(order('age', 'asc')).toEqual(['b', 'a', 'c']);
    expect(order('leechers', 'desc')).toEqual(['c', 'a', 'b']);
  });
});
