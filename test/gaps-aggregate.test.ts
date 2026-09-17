import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { fakeWanted, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { isAttachableLink } from '@/lib/attach';
import { synthesizeTitle } from '@/server/gaps/attach';
import type { Gap, HistoryEvent } from '@/lib/types';
import { closeDb } from '@/server/db';
import { readGaps, resetGapsReadState } from '@/server/gaps/aggregate';
import { inferReason } from '@/server/gaps/reason';
import {
  getCachedLibrary,
  invalidateLibrary,
  resetLibraryCache,
  setCachedLibrary,
} from '@/server/gaps/seriesCache';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T18 / REQ-GAPS-001..003, -014, -016; ADR-3, ADR-5, ADR-6.
 *
 * Every assertion here is about the same failure: a gaps list that is wrong in a
 * way the operator cannot see. A short list looks like a tidy library; a silent
 * truncation looks like the same thing; a stale cache looks like a screen that
 * simply has not noticed. So the tests are about what is *missing* from the
 * output and what is *present* in the request.
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

function event(eventType: string, at: string): HistoryEvent {
  return { at, eventType, sourceTitle: 'Show.S01E01.1080p.WEB-DL' };
}

function gap(over: Partial<Gap> = {}): Gap {
  return {
    id: 'i1:episode:5',
    instanceId: 'i1',
    instanceLabel: 'Sonarr',
    instanceKind: 'sonarr',
    kind: 'episode',
    upstreamId: 5,
    seriesId: 1,
    seasonNumber: 4,
    groupTitle: 'Reacher',
    itemCode: 'S04E02',
    title: 'Episode 2',
    airDate: '2025-01-01T00:00:00Z',
    wantedQuality: 'HD-1080p',
    targetPath: '/tv/Reacher',
    lastSearchAt: null,
    inferred: null,
    ...over,
  };
}

describe('gaps aggregation', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    for (const arr of [sonarr, radarr]) {
      arr.hits.length = 0;
      arr.wantedRequests.length = 0;
      arr.commands.length = 0;
      arr.setWanted([]);
      arr.setWantedTotal(null);
      arr.setSeries([]);
      arr.setProfiles([]);
      arr.setHistory([]);
      arr.failCommands(null);
    }
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

  /* ── Paging ─────────────────────────────────────────────────────────────── */

  it('reads a wanted list larger than one page in full', async () => {
    // 450 > the forced page size of 200. Sonarr's own default page size is 10:
    // a client that accepted it would return 10 of these and report success,
    // which reads on screen as a library with 10 gaps.
    sonarr.setWanted(fakeWanted(450));
    sonarr.setSeries([{ id: 1, title: 'Reacher', path: '/tv/Reacher', qualityProfileId: 3 }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const result = await readGaps();

    expect(result.errors).toEqual([]);
    expect(result.gaps).toHaveLength(450);
    expect(sonarr.wantedRequests.map((r) => r.params.page)).toEqual(['1', '2', '3']);
  });

  it('deduplicates a record that shifts across a page boundary', async () => {
    // The same id served on two pages — what happens when an item gains a file
    // mid-read and everything after it slides up one slot.
    const page1 = fakeWanted(200);
    const page2 = [...fakeWanted(1, 200), ...fakeWanted(199, 201)];
    sonarr.setWanted([...page1, ...page2]);
    sonarr.setWantedTotal(400);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const result = await readGaps();

    const ids = result.gaps.map((g) => g.upstreamId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /* ── sortKey (AC3) ──────────────────────────────────────────────────────── */

  it('always sends an explicit sort key, per kind', async () => {
    sonarr.setWanted(fakeWanted(1));
    radarr.setWanted([{ id: 9, title: 'Dune', year: 2021, status: 'released', monitored: true }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    register('radarr', 'Radarr', radarr, 'radarr-key');

    await readGaps();

    // Undocumented defaults have changed between *arr releases, and a 500 on
    // page 1 reads from here as "you have no gaps" — the one answer this screen
    // must never invent.
    expect(sonarr.wantedRequests[0].params).toMatchObject({
      sortKey: 'airDateUtc',
      sortDirection: 'descending',
      monitored: 'true',
    });
    expect(radarr.wantedRequests[0].params).toMatchObject({
      sortKey: 'title',
      sortDirection: 'ascending',
      monitored: 'true',
    });
  });

  /* ── Truncation ─────────────────────────────────────────────────────────── */

  it('reports a truncated read instead of serving a short list silently', async () => {
    // 25 pages × 200 is the ceiling, and the instance claims far more than that,
    // so the loop stops with the list incomplete. A list cut off without a word
    // looks exactly like a library with fewer gaps in it.
    sonarr.setWanted(fakeWanted(5_000));
    sonarr.setWantedTotal(99_999);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const result = await readGaps();

    expect(result.gaps).toHaveLength(5_000);
    expect(sonarr.wantedRequests).toHaveLength(25);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('page ceiling');
    expect(result.errors[0].reason).toContain('5000 of 99999');
  });

  /* ── The released guard (REQ-GAPS-003) ──────────────────────────────────── */

  it('excludes an announced film with no release date of any kind', async () => {
    // Measured on live hardware during the spike: a naive `monitored && !hasFile`
    // read found two films, one of them `announced` with no cinema, digital or
    // physical date. Its only possible action is a search that cannot succeed.
    radarr.setWanted([
      { id: 1, title: 'Dune Part Three', year: 2027, status: 'announced', monitored: true },
      { id: 2, title: 'Dune Part Two', year: 2024, status: 'released', monitored: true },
    ]);
    register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readGaps();

    expect(result.gaps.map((g) => g.title)).toEqual(['Dune Part Two']);
  });

  it('keeps an announced film whose release date has already passed', async () => {
    // `status` lags on some instances. A date in the past is a fact about the
    // film, so it outranks a label that has not been refreshed.
    radarr.setWanted([{
      id: 3,
      title: 'Late Label',
      year: 2024,
      status: 'announced',
      monitored: true,
      digitalRelease: '2024-03-01T00:00:00Z',
    }]);
    register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readGaps();

    expect(result.gaps.map((g) => g.title)).toEqual(['Late Label']);
  });

  it('excludes an item that already has a file whatever the instance says', async () => {
    sonarr.setWanted([{ ...fakeWanted(1)[0], hasFile: true }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    expect((await readGaps()).gaps).toEqual([]);
  });

  /* ── The library join (ADR-3) ───────────────────────────────────────────── */

  it('names the series and the target path from the cached join', async () => {
    sonarr.setWanted(fakeWanted(1));
    sonarr.setSeries([{ id: 1, title: 'Reacher', path: '/tv/Reacher', qualityProfileId: 3 }]);
    sonarr.setProfiles([{ id: 3, name: 'HD-1080p' }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const [row] = (await readGaps()).gaps;

    expect(row.groupTitle).toBe('Reacher');
    expect(row.targetPath).toBe('/tv/Reacher');
    expect(row.wantedQuality).toBe('HD-1080p');
    expect(row.itemCode).toBe('S01E01');
  });

  it('keeps the row when the join misses, rather than dropping it', async () => {
    // A row that vanishes because its series was not in the snapshot is the
    // worst outcome for a screen whose whole purpose is completeness.
    sonarr.setWanted(fakeWanted(1));
    sonarr.setSeries([]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

    const [row] = (await readGaps()).gaps;

    expect(row.groupTitle).toContain('unknown');
    expect(row.itemCode).toBe('S01E01');
  });

  it('leaves Sonarr rows with no last-searched time rather than inventing one', async () => {
    // ADR-5: Sonarr reports no per-episode search state at all, and the column
    // renders an em dash. Deriving one from history would be a guess shown as
    // a fact.
    sonarr.setWanted(fakeWanted(1));
    radarr.setWanted([{
      id: 7,
      title: 'Dune',
      year: 2021,
      status: 'released',
      monitored: true,
      lastSearchTime: '2025-06-01T12:00:00Z',
    }]);
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    register('radarr', 'Radarr', radarr, 'radarr-key');

    const rows = (await readGaps()).gaps;

    expect(rows.find((g) => g.kind === 'episode')?.lastSearchAt).toBeNull();
    expect(rows.find((g) => g.kind === 'movie')?.lastSearchAt).toBe('2025-06-01T12:00:00Z');
  });

  it('gives every film the same group and every row a composite id', async () => {
    // FR5: Radarr has no per-series grouping. And two instances hand out the
    // same numeric id, so identity has to carry the instance and the kind.
    radarr.setWanted([
      { id: 1, title: 'Dune', year: 2021, status: 'released', monitored: true },
      { id: 2, title: 'Arrival', year: 2016, status: 'released', monitored: true },
    ]);
    const dto = register('radarr', 'Radarr', radarr, 'radarr-key');

    const rows = (await readGaps()).gaps;

    expect(rows.map((g) => g.groupTitle)).toEqual(['Films', 'Films']);
    expect(rows.map((g) => g.id)).toEqual([`${dto.id}:movie:1`, `${dto.id}:movie:2`]);
  });

  /* ── Partial failure (REQ-GAPS-015) ─────────────────────────────────────── */

  it('serves one instance\'s gaps while naming the other\'s failure', async () => {
    sonarr.setWanted(fakeWanted(3));
    radarr.setMode('server-error');
    register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
    const down = register('radarr', 'Radarr', radarr, 'radarr-key');

    const result = await readGaps();

    expect(result.gaps).toHaveLength(3);
    expect(result.errors.map((e) => e.instanceId)).toContain(down.id);
    radarr.setMode('ok');
  });
});

/* ── The library cache, in isolation (ADR-3, REQ-GAPS-016) ────────────────── */

describe('library cache', () => {
  const snapshot = {
    series: new Map([[1, { id: 1, title: 'Reacher', path: '/tv', monitored: true, qualityProfileId: 3 }]]),
    profiles: new Map([[3, 'HD-1080p']]),
    readAt: '2025-01-01T00:00:00Z',
  };

  afterEach(() => { resetLibraryCache(); });

  it('serves a snapshot inside its TTL', () => {
    setCachedLibrary('i1', snapshot, 0);
    expect(getCachedLibrary('i1', 9 * 60_000)?.readAt).toBe(snapshot.readAt);
  });

  it('drops a snapshot past its TTL rather than marking it stale', () => {
    // Returned-and-flagged would mean every caller has to remember to check the
    // flag, and one of them eventually will not.
    setCachedLibrary('i1', snapshot, 0);
    expect(getCachedLibrary('i1', 10 * 60_000 + 1)).toBeNull();
  });

  it('drops a snapshot on an explicit invalidation', () => {
    // Called after every write. helparr's own attach is the one thing that can
    // make this cache wrong without warning, and serving the pre-attach
    // snapshot afterwards shows the operator the state their action invalidated.
    setCachedLibrary('i1', snapshot, 0);
    invalidateLibrary('i1');
    expect(getCachedLibrary('i1', 0)).toBeNull();
  });

  it('invalidates one instance without touching another', () => {
    setCachedLibrary('i1', snapshot, 0);
    setCachedLibrary('i2', snapshot, 0);
    invalidateLibrary('i1');
    expect(getCachedLibrary('i1', 0)).toBeNull();
    expect(getCachedLibrary('i2', 0)).not.toBeNull();
  });
});

/* ── Title synthesis (REQ-GAPS-012) ───────────────────────────────────────── */

describe('attach title synthesis', () => {
  it('builds a dot-separated episode name the parsers were written against', () => {
    expect(synthesizeTitle(gap())).toBe('Reacher.S04E02.WEBDL-1080p');
  });

  it('strips punctuation rather than leaving prose the parser will miss', () => {
    // A failed parse costs the operator the mismatch warning, which is the one
    // protection this flow has.
    expect(synthesizeTitle(gap({ groupTitle: "Marvel's Daredevil: Born Again" })))
      .toBe('Marvel.s.Daredevil.Born.Again.S04E02.WEBDL-1080p');
  });

  it('names a film by its own title and year, not by the Films group', () => {
    expect(synthesizeTitle(gap({
      kind: 'movie',
      groupTitle: 'Films',
      title: 'Dune: Part Two',
      itemCode: '2024',
    }))).toBe('Dune.Part.Two.2024.WEBDL-1080p');
  });

  it('states the quality token rather than guessing at the file', () => {
    // helparr cannot know what is inside the torrent; the token has to be
    // something for the parse to complete, and it is shown in the confirmation.
    expect(synthesizeTitle(gap())).toContain('WEBDL-1080p');
  });
});

/* ── The attachable-link predicate (REQ-GAPS-010) ─────────────────────────── */

/**
 * The dialog disables its button on this and the route refuses on it. They must
 * not drift, so the shape of "attachable" is pinned here rather than only at the
 * two call sites — a client rule stricter than the server's silently hides links
 * that would have worked, and a looser one turns a local, instant explanation
 * into a round trip and a refusal.
 */
describe('attachable links', () => {
  it('accepts the two shapes an *arr can be handed', () => {
    expect(isAttachableLink('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(isAttachableLink('https://indexer.invalid/download/abc123.torrent')).toBe(true);
    // A query string after the path is the common indexer shape, and the
    // suffix test reads the path rather than the whole URL.
    expect(isAttachableLink('https://indexer.invalid/dl/abc.torrent?apikey=k')).toBe(true);
    expect(isAttachableLink('  magnet:?xt=urn:btih:abc  ')).toBe(true);
    expect(isAttachableLink('https://indexer.invalid/DL/ABC.TORRENT')).toBe(true);
  });

  it('refuses anything else, without calling it an error', () => {
    expect(isAttachableLink('https://indexer.invalid/details/abc123')).toBe(false);
    // Not refused on principle — simply not offered by this flow.
    expect(isAttachableLink('https://indexer.invalid/download/abc123.nzb')).toBe(false);
    expect(isAttachableLink('not a url at all')).toBe(false);
    expect(isAttachableLink('')).toBe(false);
    // The suffix is the path's, not the query's: a `.torrent` that only appears
    // in a parameter is not a torrent file.
    expect(isAttachableLink('https://indexer.invalid/page?file=abc.torrent')).toBe(false);
  });
});

/* ── Reason inference, always tagged (ADR-6) ──────────────────────────────── */

describe('reason inference', () => {
  const now = Date.parse('2025-06-10T00:00:00Z');

  it('says nothing at all when there is no history', () => {
    // An empty history genuinely means nothing has been tried. A sentence
    // invented to fill the space would be helparr asserting what it does not know.
    expect(inferReason([], now)).toBeNull();
  });

  it('tags every sentence it composes as inferred', () => {
    const reason = inferReason([event('grabbed', '2025-06-06T00:00:00Z')], now);
    expect(reason?.source).toBe('inferred');
  });

  it('distinguishes a grab that is still running from one that stalled', () => {
    expect(inferReason([event('grabbed', '2025-06-10T00:00:00Z')], now)?.text)
      .toContain('probably still running');
    expect(inferReason([event('grabbed', '2025-06-06T00:00:00Z')], now)?.text)
      .toContain('never imported');
  });

  it('reads the newest event whatever order the instance returned', () => {
    // Radarr's per-movie route and Sonarr's paged collection do not agree on
    // direction, so the inference cannot trust the upstream ordering.
    const reason = inferReason([
      event('grabbed', '2025-06-01T00:00:00Z'),
      event('downloadFailed', '2025-06-09T00:00:00Z'),
    ], now);
    expect(reason?.text).toContain('failed');
  });

  it('surfaces the imported-yet-missing contradiction instead of hiding it', () => {
    const reason = inferReason([event('downloadFolderImported', '2025-06-09T00:00:00Z')], now);
    expect(reason?.text).toContain('still reported missing');
  });

  it('quotes an unrecognised event type verbatim rather than paraphrasing it', () => {
    // An unknown type is precisely where a paraphrase would be a guess about
    // upstream semantics.
    const reason = inferReason([event('grabbedFromSomewhereNew', '2025-06-09T00:00:00Z')], now);
    expect(reason?.text).toContain('"grabbedFromSomewhereNew"');
    expect(reason?.source).toBe('inferred');
  });
});
