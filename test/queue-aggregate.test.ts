import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { fakeQueue, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { readQueue, resetQueueReadState } from '@/server/queue/aggregate';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T20 / REQ-QUEUE-001, -002 — the fan-out reads everything and says where it
 * came from.
 *
 * Both halves are about silent loss. A queue read that stops at the first page
 * looks exactly like a shorter queue, and a merged queue that drops attribution
 * looks exactly like one instance's queue — in both cases the screen is wrong in
 * a way the operator cannot see.
 */

const created: string[] = [];

function register(kind: 'sonarr' | 'radarr', label: string, arr: FakeArr, apiKey: string) {
  const dto = createInstance({
    kind,
    label,
    baseUrl: arr.url,
    credential: { type: 'api-key', apiKey },
  });
  created.push(dto.id);
  return dto;
}

describe('queue aggregation', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    sonarr.hits.length = 0;
    radarr.hits.length = 0;
    sonarr.setQueue([]);
    radarr.setQueue([]);
    sonarr.setTotalRecords(null);
    radarr.setTotalRecords(null);
    resetQueueReadState();
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  it('retrieves a queue larger than one page in full', async () => {
    // 450 > the forced page size of 200, so the read only completes if the
    // client pages. Sonarr's own default is 10 — a client that accepted it
    // would return 10 of these and report success.
    sonarr.setQueue(fakeQueue(450));
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const result = await readQueue();

    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(450);

    // Every record, not just the right count: a paging bug that re-reads page 1
    // three times also produces 450 rows if you only count the concatenation.
    const ids = new Set(result.records.map((r) => r.recordId));
    expect(ids.size).toBe(450);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBe(450);

    const pages = sonarr.hits.filter((h) => h.path.startsWith('/api/v3/queue'));
    expect(pages).toHaveLength(3);
    for (const page of pages) expect(page.path).toContain('pageSize=200');
    expect(pages.map((p) => new URL(p.path, 'http://x').searchParams.get('page')))
      .toEqual(['1', '2', '3']);
  });

  it('stops paging when the upstream runs out of records', async () => {
    // A queue that shrinks mid-read leaves `totalRecords` above what the pages
    // can supply. The loop has to end on the empty page rather than trust the
    // count and spin to the 25-page ceiling.
    sonarr.setQueue(fakeQueue(200));
    sonarr.setTotalRecords(5_000);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const result = await readQueue();

    expect(result.records).toHaveLength(200);
    expect(sonarr.hits.filter((h) => h.path.startsWith('/api/v3/queue'))).toHaveLength(2);
  });

  it('merges two instances and attributes every row to the one it came from', async () => {
    // Deliberately colliding record ids: both instances number their queues
    // from 1, which is what a real pair does.
    sonarr.setQueue(fakeQueue(3));
    radarr.setQueue([
      { id: 1, title: 'Film.2019.2160p', movie: { title: 'Film', year: 2019 } },
      { id: 2, title: 'Other.Film.1080p', movie: { title: 'Other Film', year: 2021 } },
    ]);
    const sonarrDto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const radarrDto = register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readQueue();

    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(5);

    // Five rows, five ids. A bare `recordId` key would have collapsed this to
    // three and removed rows the operator can still see.
    expect(new Set(result.records.map((r) => r.id)).size).toBe(5);

    const fromSonarr = result.records.filter((r) => r.instanceId === sonarrDto.id);
    const fromRadarr = result.records.filter((r) => r.instanceId === radarrDto.id);
    expect(fromSonarr).toHaveLength(3);
    expect(fromRadarr).toHaveLength(2);

    expect(fromSonarr.every((r) => r.instanceLabel === 'Sonarr' && r.instanceKind === 'sonarr'))
      .toBe(true);
    expect(fromRadarr.every((r) => r.instanceLabel === 'Radarr' && r.instanceKind === 'radarr'))
      .toBe(true);

    expect(fromSonarr.map((r) => r.id)).toEqual([1, 2, 3].map((n) => `${sonarrDto.id}:${n}`));
    expect(fromRadarr.map((r) => r.id)).toEqual([1, 2].map((n) => `${radarrDto.id}:${n}`));

    // Attribution is not only the instance: the per-kind label is what makes a
    // row identifiable as a thing rather than as a release string.
    expect(fromSonarr[0].targetLabel).toBe('Show — S01E01');
    expect(fromRadarr[0].targetLabel).toBe('Film (2019)');

    // Both instances answered, so both carry a freshness stamp — that is what
    // the rail renders as "read 12s ago".
    expect(Object.keys(result.lastReadAt).sort())
      .toEqual([sonarrDto.id, radarrDto.id].sort());
  });
});
