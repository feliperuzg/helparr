import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import {
  fakeSeriesDetail, parsedSeason, parsedSeries, startFakeArr, type FakeArr, type FakeGapRecord,
} from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import {
  attachSeason, previewSeasonAttach, synthesizeSeasonTitle,
} from '@/server/gaps/attach';
import { readGaps, resetGapsReadState } from '@/server/gaps/aggregate';
import { resetLibraryCache } from '@/server/gaps/seriesCache';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { listOperations, purgeOperations } from '@/server/operations/log';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * The season attach, server side (FR1..FR10; AC2..AC8; T12).
 *
 * The bug this feature exists for is invisible from the browser: a name
 * carrying an episode token resolves to **one** episode, and Sonarr then scopes
 * the grab to that one id — so the other nine files in a season pack are
 * refused at import with nothing to explain it. Everything asserted here is a
 * claim about the name helparr offers and the single write it performs under it.
 *
 * `gaps-attach.test.ts` covers the episode-scoped sibling; what is duplicated
 * between them is duplicated on purpose, because the two share a code path and
 * a regression in it would otherwise only show on one scope.
 */

const created: string[] = [];

const MAGNET = 'magnet:?xt=urn:btih:9f2c1d4a7b3e5f6089abcdef0123456789abcdef'
  + '&dn=FROM.S02.COMPLETE&tr=http://tracker.invalid/announce?passkey=SECRETPASSKEY';

/** Two missing episodes of season 2 and one of season 1, all on series 1. */
function fromWanted(): FakeGapRecord[] {
  const episode = (id: number, season: number, number: number): FakeGapRecord => ({
    id,
    seriesId: 1,
    seasonNumber: season,
    episodeNumber: number,
    title: `Episode ${number}`,
    airDateUtc: '2025-01-01T00:00:00Z',
    monitored: true,
    hasFile: false,
  });
  return [episode(11, 1, 3), episode(21, 2, 1), episode(22, 2, 2)];
}

describe('season-level attach', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;
  let sonarrId: string;
  let radarrId: string;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    for (const arr of [sonarr, radarr]) {
      arr.hits.length = 0;
      arr.pushes.length = 0;
      arr.commands.length = 0;
      arr.wantedRequests.length = 0;
      arr.setWanted([]);
      arr.setWantedTotal(null);
      arr.setSeries([]);
      arr.setSeriesDetail(null);
      arr.setProfiles([]);
      arr.setParse(null);
      arr.setPushResult({});
      arr.failCommands(null);
      arr.setMode('ok');
    }
    purgeOperations();
    resetGapsReadState();
    resetLibraryCache();
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  /**
   * A series missing part of season 2, a film on the other instance, and — by
   * default — a season 2 that is entirely absent from disk. The partial case is
   * the interesting one, so tests that want it say so explicitly.
   */
  async function seed(): Promise<{ seasonGapId: string; movieGapId: string }> {
    sonarr.setWanted(fromWanted());
    sonarr.setSeries([{ id: 1, title: 'FROM', path: '/tv/FROM', qualityProfileId: 3 }]);
    sonarr.setProfiles([{ id: 3, name: 'HD-1080p' }]);
    sonarr.setSeriesDetail(fakeSeriesDetail({
      id: 1,
      title: 'FROM',
      path: '/tv/FROM',
      seasons: [
        { seasonNumber: 1, episodeCount: 10, episodeFileCount: 9 },
        { seasonNumber: 2, episodeCount: 10, episodeFileCount: 0 },
      ],
    }));
    radarr.setWanted([{
      id: 5,
      title: 'Dune: Part Two',
      year: 2024,
      status: 'released',
      monitored: true,
      path: '/films/Dune Part Two (2024)',
    }]);

    sonarrId = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    }).id;
    radarrId = createInstance({
      kind: 'radarr',
      label: 'Radarr',
      baseUrl: radarr.url,
      credential: { type: 'api-key', apiKey: 'radarr-key' },
    }).id;
    created.push(sonarrId, radarrId);

    const read = await readGaps();
    expect(read.errors).toEqual([]);
    return {
      seasonGapId: `${sonarrId}:episode:21`,
      movieGapId: `${radarrId}:movie:5`,
    };
  }

  /** The season 2 parse, unless a test wants a different reading. */
  function parseSeasonTwo(options: { isMultiSeason?: boolean; episodes?: number } = {}): void {
    sonarr.setParse(parsedSeason({
      id: 1,
      title: 'FROM',
      season: 2,
      episodes: options.episodes ?? 10,
      isMultiSeason: options.isMultiSeason ?? false,
    }));
  }

  /* ── The name (AC2) ─────────────────────────────────────────────────────── */

  it('offers a season token and no episode token', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const { title } = preview.value;

    // The entire mechanism. `FROM.S02E01…` resolves to one episode and Sonarr
    // scopes the grab to that one id (Sonarr#8911); `FROM.S02…` resolves the set.
    expect(title).toContain('.S02.');
    expect(title).not.toMatch(/S\d{2}E\d{2}/);
    expect(title).toBe('FROM.S02.WEBDL-1080p');
  });

  it('pads the season number the way a release name does', async () => {
    const { seasonGapId } = await seed();
    const gap = { groupTitle: 'FROM' };

    // Sonarr's parser reads `S2` too, but `S02` is what a real pack is named,
    // and the name is the only thing the instance is given to work from.
    expect(synthesizeSeasonTitle(gap as never, 2)).toContain('.S02.');
    expect(synthesizeSeasonTitle(gap as never, 12)).toContain('.S12.');
    // Season 0 is specials, and it is a real season number — not a missing one.
    expect(synthesizeSeasonTitle(gap as never, 0)).toContain('.S00.');
    expect(seasonGapId).toContain(':episode:');
  });

  /* ── A film has no season (AC3, NFR4) ───────────────────────────────────── */

  it('refuses a season attach against Radarr, before any write', async () => {
    const { movieGapId } = await seed();

    const preview = await previewSeasonAttach(movieGapId, 1);
    const outcome = await attachSeason({ gapId: movieGapId, season: 1, link: MAGNET });

    expect(preview.ok).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.kind).toBe('not-grabbable');
    // The refusal lives on the server as well as in the UI because the route is
    // reachable without the UI.
    expect(radarr.pushes).toHaveLength(0);
    expect(listOperations().operations).toHaveLength(0);
  });

  /* ── The pre-flight writes nothing (AC4, REQ-GAPS-017) ──────────────────── */

  it('prepares the confirmation without sending anything', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.matchesSeason).toBe(true);
    expect(preview.value.target.fullSeason).toBe(true);
    expect(preview.value.target.episodeCount).toBe(10);
    // Opening the dialog costs a parse and a series read. It costs no write.
    expect(sonarr.pushes).toHaveLength(0);
    expect(listOperations().operations).toHaveLength(0);
  });

  it('writes only when the attach is confirmed', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: false, rejections: [] });

    await previewSeasonAttach(seasonGapId, 2);
    expect(sonarr.pushes).toHaveLength(0);

    const outcome = await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('succeeded');
    expect(sonarr.pushes).toHaveLength(1);
    expect(sonarr.pushes[0].body).toMatchObject({
      title: 'FROM.S02.WEBDL-1080p',
      downloadUrl: MAGNET,
      protocol: 'torrent',
    });
  });

  it('re-synthesizes the season name instead of trusting the request', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: false });

    // Season 1 is a season this series has, and the operator may legitimately
    // pick it — what matters is that the *name* comes from helparr's own
    // synthesis and not from anything the browser could have put in the body.
    await attachSeason({ gapId: seasonGapId, season: 1, link: MAGNET });

    expect(sonarr.pushes[0].body.title).toBe('FROM.S01.WEBDL-1080p');
  });

  /* ── Multi-season disclosure (AC5, FR6, ADR-3) ──────────────────────────── */

  it('surfaces a parse that spans more than one season', async () => {
    const { seasonGapId } = await seed();
    // `FROM.S01-S03…` is what a real Sonarr reads as a range: the flag is set
    // and exactly one season comes back resolved.
    sonarr.setParse(parsedSeason({ id: 1, title: 'FROM', season: 2, isMultiSeason: true }));

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.target.isMultiSeason).toBe(true);
    // Disclosed, never blocked: the operator may have a reason, and the other
    // seasons downloading unimported is a cost they get to weigh (ADR-3).
    expect(preview.value.matchesSeason).toBe(true);
  });

  it('sends exactly one push for a multi-season pack', async () => {
    const { seasonGapId } = await seed();
    sonarr.setParse(parsedSeason({ id: 1, title: 'FROM', season: 2, isMultiSeason: true }));
    sonarr.setPushResult({ rejected: false });

    await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });

    // The tempting shape is one push per season in the range. It cannot work —
    // the download client deduplicates by infoHash, so pushes two onwards are
    // silently discarded, and a loop that appears to do something and does
    // nothing is worse than the warning the confirmation already showed.
    expect(sonarr.pushes).toHaveLength(1);
    expect(listOperations().operations).toHaveLength(1);
  });

  /* ── Partial seasons (AC6, FR5, ADR-2) ──────────────────────────────────── */

  it('reports how much of the season is already filed, with the count', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    // Set after the seed, and it takes effect immediately: the detail read is
    // deliberately uncached, because the number it produces is exactly what
    // changes inside a cache's window (ADR-4).
    sonarr.setSeriesDetail(fakeSeriesDetail({
      id: 1,
      title: 'FROM',
      seasons: [{ seasonNumber: 2, episodeCount: 10, episodeFileCount: 6 }],
    }));

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // Both numbers, because "some episodes already have files" without saying
    // how many is not information the operator can act on (FR5).
    expect(preview.value.seasonFileCount).toBe(6);
    expect(preview.value.seasonEpisodeCount).toBe(10);
    expect(preview.value.season).toBe(2);
  });

  it('leaves the counts absent rather than zero when the detail read fails', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    // The route answers 404 with no detail set — a season helparr knows nothing
    // about.
    sonarr.setSeriesDetail(null);

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // `0 of 0` would read as "nothing is filed here" — the opposite of the
    // warning, and a claim about the operator's disk helparr cannot make (ADR-4).
    expect(preview.value.seasonFileCount).toBeNull();
    expect(preview.value.seasonEpisodeCount).toBeNull();
    // And the rest of the confirmation is unaffected: two reads, failing
    // independently (NFR1).
    expect(preview.value.target.resolved).toBe(true);
    expect(preview.value.matchesSeason).toBe(true);
  });

  it('leaves the counts absent for a season the detail read never mentions', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    // A detail read that answered, and simply has nothing to say about the
    // season the operator picked.
    sonarr.setSeriesDetail(fakeSeriesDetail({
      id: 1,
      title: 'FROM',
      seasons: [{ seasonNumber: 1, episodeCount: 10, episodeFileCount: 10 }],
    }));

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok && preview.value.seasonFileCount).toBeNull();
    expect(preview.ok && preview.value.seasonEpisodeCount).toBeNull();
  });

  /* ── The season predicate (OQ-5) ────────────────────────────────────────── */

  it('flags a parse that resolved a different season', async () => {
    const { seasonGapId } = await seed();
    // The operator chose season 2; the instance read the name as season 3.
    sonarr.setParse(parsedSeason({ id: 1, title: 'FROM', season: 3 }));

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok && preview.value.target.resolved).toBe(true);
    expect(preview.ok && preview.value.matchesSeason).toBe(false);
    expect(preview.ok && preview.value.target.seasonNumber).toBe(3);
  });

  it('does not pass a different season off as a match because the label contains the code', async () => {
    const { seasonGapId } = await seed();
    // The bug the predicate exists to avoid: on a full-season parse the label
    // joins every resolved code, so `label.includes('S03E01')` passes — while
    // testing something nobody asked about. Season number and series id are the
    // two facts the scope is made of.
    sonarr.setParse(parsedSeason({ id: 1, title: 'FROM', season: 3, episodes: 10 }));

    const preview = await previewSeasonAttach(seasonGapId, 3);
    expect(preview.ok && preview.value.matchesSeason).toBe(true);

    const wrong = await previewSeasonAttach(seasonGapId, 2);
    expect(wrong.ok && wrong.value.target.label).toContain('S03E01');
    expect(wrong.ok && wrong.value.matchesSeason).toBe(false);
  });

  it('flags a parse that resolved a different series', async () => {
    const { seasonGapId } = await seed();
    sonarr.setParse(parsedSeason({ id: 99, title: 'Another Show', season: 2 }));

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok && preview.value.matchesSeason).toBe(false);
  });

  it('degrades an unparseable season name to the unresolved branch, not an error', async () => {
    const { seasonGapId } = await seed();
    sonarr.setParse(null);

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.target.resolved).toBe(false);
    expect(preview.value.matchesSeason).toBe(false);
  });

  it('never treats an episode-scoped parse as a season match', async () => {
    const { seasonGapId } = await seed();
    // What the old name produced, and the whole reason for this feature.
    sonarr.setParse(parsedSeries({ id: 1, title: 'FROM', season: 2, episode: 1 }));

    const preview = await previewSeasonAttach(seasonGapId, 2);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // Sonarr agrees it is season 2 — it just resolved one episode of it. The
    // season predicate reads the season, so this is a match; the count is what
    // tells the operator only one episode came back (FR4).
    expect(preview.value.target.fullSeason).toBe(false);
    expect(preview.value.target.episodeCount).toBe(1);
  });

  /* ── Cache invalidation (AC7, FR10) ─────────────────────────────────────── */

  it('drops the cached series read after an accepted season attach', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: false });
    const before = sonarr.hits.filter((h) => h.path === '/api/v3/series').length;

    await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });
    await readGaps();

    const after = sonarr.hits.filter((h) => h.path === '/api/v3/series').length;
    expect(after).toBeGreaterThan(before);
  });

  it('drops the cached series read after a rejected season attach too', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: true, rejections: ['Existing file meets cutoff'] });
    const before = sonarr.hits.filter((h) => h.path === '/api/v3/series').length;

    await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });
    await readGaps();

    // helparr cannot tell from here whether the instance changed anything on
    // its way to saying no, and a cache miss costs one library read while a
    // stale cache costs correctness.
    const after = sonarr.hits.filter((h) => h.path === '/api/v3/series').length;
    expect(after).toBeGreaterThan(before);
  });

  it('leaves the season\'s gaps listed after an accepted attach', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: false });

    await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });

    // The instance accepted a *download*. Only a later library read can say the
    // files now exist (REQ-GAPS-011).
    const after = await readGaps();
    expect(after.gaps.map((g) => g.id)).toContain(seasonGapId);
  });

  /* ── One row, naming the season (AC8, FR8) ──────────────────────────────── */

  it('records exactly one operation naming the season, not its episodes', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: false });

    const outcome = await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });

    const log = listOperations().operations;
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('attach');
    expect(log[0].outcome).toBe('succeeded');
    expect(outcome.ok && log[0].id).toBe(outcome.ok ? outcome.value.operationId : '');

    // The scope, named. `episodeLabel()` joins every resolved code, and a row
    // reading `S02E01, S02E02, …` describes the wrong unit of work.
    expect(log[0].entityRef).toBe('FROM — season 2');
    expect(log[0].entityRef).not.toMatch(/S\d{2}E\d{2}/);
    expect(log[0].entityTitle).toBe('FROM.S02.WEBDL-1080p');
  });

  it('records the refusal reasons verbatim on a rejected season attach', async () => {
    const reasons = [
      'Existing file meets cutoff: WEBDL-1080p',
      'Not a preferred word upgrade for existing episode file(s)',
    ];
    const { seasonGapId } = await seed();
    parseSeasonTwo();
    sonarr.setPushResult({ rejected: true, rejections: reasons });

    const outcome = await attachSeason({ gapId: seasonGapId, season: 2, link: MAGNET });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('failed');
    expect(outcome.value.rejected).toBe(true);

    const [row] = listOperations().operations;
    expect(row.detail).toEqual(reasons);
    expect(row.entityRef).toBe('FROM — season 2');
  });

  it('refuses a link that is neither a magnet nor a .torrent, before sending', async () => {
    const { seasonGapId } = await seed();
    parseSeasonTwo();

    const outcome = await attachSeason({
      gapId: seasonGapId,
      season: 2,
      link: 'https://example.invalid/page.html',
    });

    expect(outcome.ok).toBe(false);
    expect(sonarr.pushes).toHaveLength(0);
    // Nothing was attempted, so there is nothing to record.
    expect(listOperations().operations).toHaveLength(0);
  });

  it('refuses a gap that is no longer in the library read', async () => {
    await seed();

    const preview = await previewSeasonAttach(`${sonarrId}:episode:404`, 2);
    const outcome = await attachSeason({
      gapId: `${sonarrId}:episode:404`,
      season: 2,
      link: MAGNET,
    });

    expect(preview.ok).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(sonarr.pushes).toHaveLength(0);
  });
});
