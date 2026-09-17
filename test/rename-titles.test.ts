import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { readRenameTitles } from '@/server/rename/titles';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T10 / FR1 — the list the scope picker chooses from.
 *
 * Three claims, and the first is the one that decides whether the screen is
 * usable at all:
 *
 * 1. **Only titles with a file.** A rename moves a file, so a monitored-but-
 *    absent title has nothing to preview. On a library that is still filling
 *    in, that is most of it — leaving them in would make "no changes" the
 *    picker's usual outcome for a reason the operator could have been told
 *    before they selected anything.
 * 2. **A failed instance costs its own titles and nothing else.** The same
 *    fan-out contract `gaps` and `queue` carry, asserted here because a picker
 *    that silently dropped a Radarr would look identical to one whose operator
 *    has no films.
 * 3. **Nothing upstream is touched.** Listing is a read. The first call that
 *    reaches a title is the rescan the *build* starts, and a picker that
 *    rescanned on render would be doing library-wide work for a screen the
 *    operator only opened to look at.
 */

const created: string[] = [];

describe('rename scope titles', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;

  function register(kind: 'sonarr' | 'radarr', label: string, fake: FakeArr): string {
    const id = createInstance({
      kind,
      label,
      baseUrl: fake.url,
      credential: { type: 'api-key', apiKey: `${kind}-key` },
    }).id;
    created.push(id);
    return id;
  }

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    for (const fake of [sonarr, radarr]) {
      fake.hits.length = 0;
      fake.commands.length = 0;
      fake.setSeries([]);
      fake.setMovies([]);
      fake.setMode('ok');
    }
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  it('offers only titles the instance holds a file for', async () => {
    register('sonarr', 'Sonarr', sonarr);
    sonarr.setSeries([
      { id: 1, title: 'Reacher', statistics: { episodeFileCount: 16 } },
      // Monitored, nothing downloaded. This is the row the gaps screen exists
      // for and the one this screen must not offer.
      { id: 2, title: 'Silo', statistics: { episodeFileCount: 0 } },
      // No statistics block at all — treated as uncountable, which is the same
      // answer as zero here, because a count helparr cannot make is not a count
      // it may present.
      { id: 3, title: 'Severance' },
    ]);

    const read = await readRenameTitles();

    expect(read.errors).toEqual([]);
    expect(read.titles.map((title) => title.label)).toEqual(['Reacher']);
    expect(read.titles[0]).toMatchObject({
      kind: 'series', upstreamId: 1, fileCount: 16, instanceLabel: 'Sonarr',
    });
  });

  it('reads films from Radarr and labels them by year', async () => {
    register('radarr', 'Radarr', radarr);
    radarr.setMovies([
      { id: 7, title: 'Dune', year: 2021, hasFile: true },
      { id: 8, title: 'Dune: Part Two', year: 2024, hasFile: false },
      // A film with no year still has to be selectable — the label degrades,
      // the row does not disappear.
      { id: 9, title: 'Untitled Project', hasFile: true },
    ]);

    const read = await readRenameTitles();

    expect(read.titles.map((title) => title.label)).toEqual(['Dune (2021)', 'Untitled Project']);
    expect(read.titles[0]).toMatchObject({ kind: 'movie', upstreamId: 7, fileCount: 1 });
  });

  it('keys a title by instance and upstream id, the way a plan row is keyed', async () => {
    const sonarrId = register('sonarr', 'Sonarr', sonarr);
    sonarr.setSeries([{ id: 1, title: 'Reacher', statistics: { episodeFileCount: 16 } }]);

    const read = await readRenameTitles();

    // Two instances can both hold a series with the same upstream id, so the
    // id the picker selects on has to carry the instance too — otherwise one
    // tick would select two different libraries' titles.
    expect(read.titles[0].id).toBe(`${sonarrId}:series:1`);
  });

  it('attributes a failed instance and keeps the other one whole', async () => {
    register('sonarr', 'Sonarr', sonarr);
    const radarrId = register('radarr', 'Radarr', radarr);

    sonarr.setSeries([{ id: 1, title: 'Reacher', statistics: { episodeFileCount: 16 } }]);
    radarr.setMode('server-error');

    const read = await readRenameTitles();

    // Sonarr's titles survive Radarr's outage. A picker that returned an empty
    // list here would be telling the operator they have nothing to rename.
    expect(read.titles.map((title) => title.label)).toEqual(['Reacher']);
    expect(read.errors).toHaveLength(1);
    expect(read.errors[0]).toMatchObject({ instanceId: radarrId, instanceLabel: 'Radarr' });
    expect(read.errors[0].reason).toBeTruthy();
  });

  it('issues no command while listing', async () => {
    register('sonarr', 'Sonarr', sonarr);
    register('radarr', 'Radarr', radarr);
    sonarr.setSeries([{ id: 1, title: 'Reacher', statistics: { episodeFileCount: 16 } }]);
    radarr.setMovies([{ id: 7, title: 'Dune', year: 2021, hasFile: true }]);

    await readRenameTitles();

    // Counted from what the instances actually received, not from reading the
    // call sites: no rescan, no rename, no command of any kind.
    expect(sonarr.commands).toEqual([]);
    expect(radarr.commands).toEqual([]);
    for (const fake of [sonarr, radarr]) {
      expect(fake.hits.some((hit) => hit.method !== 'GET')).toBe(false);
      expect(fake.hits.some((hit) => hit.path.includes('/rename'))).toBe(false);
    }
  });
});
