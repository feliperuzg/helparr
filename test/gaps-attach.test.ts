import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { fakeWanted, parsedSeries, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb, getDb } from '@/server/db';
import { attach, previewAttach } from '@/server/gaps/attach';
import { readGaps, resetGapsReadState } from '@/server/gaps/aggregate';
import { bulkSearch } from '@/server/gaps/search';
import { resetLibraryCache } from '@/server/gaps/seriesCache';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { listOperations, purgeOperations } from '@/server/operations/log';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T19 / FR6..FR9; REQ-GAPS-010..015, -017; ADR-1, ADR-7; AC12.
 *
 * The server half of the two writes this screen can perform. Its job is to prove
 * the claims that cannot be seen from the browser:
 *
 * - a push happens **once** per confirmation, and only after one,
 * - what the instance said is what gets recorded, word for word,
 * - the gap is still listed afterwards, whatever the answer was,
 * - and the pasted magnet never reaches the database in the clear.
 *
 * The browser half is `gaps-interaction.test.ts`, which proves the UI never
 * reaches any of this before a confirmation.
 */

const created: string[] = [];

/** A plausible magnet, with a tracker query a careless log would echo back. */
const MAGNET = 'magnet:?xt=urn:btih:9f2c1d4a7b3e5f6089abcdef0123456789abcdef'
  + '&dn=Reacher.S04E02&tr=http://tracker.invalid/announce?passkey=SECRETPASSKEY';

describe('gaps attach and bulk search', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;
  let sonarrId: string;
  let radarrId: string;

  function register(): void {
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
  }

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
   * One monitored, fileless episode on Sonarr and one film on Radarr, both
   * carrying **upstream id 5** — the collision the composite id exists for.
   */
  async function seed(): Promise<{ episodeGapId: string; movieGapId: string }> {
    sonarr.setWanted(fakeWanted(1, 5));
    sonarr.setSeries([{ id: 1, title: 'Reacher', path: '/tv/Reacher', qualityProfileId: 3 }]);
    sonarr.setProfiles([{ id: 3, name: 'HD-1080p' }]);
    radarr.setWanted([{
      id: 5,
      title: 'Dune: Part Two',
      year: 2024,
      status: 'released',
      monitored: true,
      path: '/films/Dune Part Two (2024)',
    }]);
    register();

    const read = await readGaps();
    expect(read.errors).toEqual([]);
    return {
      episodeGapId: `${sonarrId}:episode:5`,
      movieGapId: `${radarrId}:movie:5`,
    };
  }

  /* ── Composite ids (REQ-GAPS-014) ───────────────────────────────────────── */

  it('keeps two instances\' identical upstream ids apart', async () => {
    const { episodeGapId, movieGapId } = await seed();

    expect(episodeGapId).not.toBe(movieGapId);

    sonarr.setParse(parsedSeries({ id: 1, title: 'Reacher', season: 1, episode: 5 }));
    const episode = await previewAttach(episodeGapId);
    const movie = await previewAttach(movieGapId);

    expect(episode.ok && episode.value.title).toBe('Reacher.S01E05.WEBDL-1080p');
    expect(movie.ok && movie.value.title).toBe('Dune.Part.Two.2024.WEBDL-1080p');
    // The episode's parse went to Sonarr and the film's to Radarr — an id that
    // did not carry the instance would have sent both to whichever answered first.
    expect(sonarr.hits.some((h) => h.path.startsWith('/api/v3/parse'))).toBe(true);
    expect(radarr.hits.some((h) => h.path.startsWith('/api/v3/parse'))).toBe(true);
  });

  /* ── The pre-flight is read-only (REQ-GAPS-017) ─────────────────────────── */

  it('resolves the destination without sending anything', async () => {
    const { episodeGapId } = await seed();
    sonarr.setParse(parsedSeries({ id: 1, title: 'Reacher', season: 1, episode: 5 }));

    const preview = await previewAttach(episodeGapId);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.target.resolved).toBe(true);
    expect(preview.value.matchesGap).toBe(true);
    expect(preview.value.path).toBe('/tv/Reacher');
    // The whole point. Opening the dialog costs one GET and nothing else.
    expect(sonarr.pushes).toHaveLength(0);
    expect(listOperations().operations).toHaveLength(0);
  });

  it('flags a parse that resolves to a different episode', async () => {
    const { episodeGapId } = await seed();
    // The instance read the synthesized name as a different episode of the same
    // series. Both readings get named in the dialog; the instance's wins.
    sonarr.setParse(parsedSeries({ id: 1, title: 'Reacher', season: 4, episode: 2 }));

    const preview = await previewAttach(episodeGapId);

    expect(preview.ok && preview.value.target.resolved).toBe(true);
    expect(preview.ok && preview.value.matchesGap).toBe(false);
  });

  it('degrades an unparseable name to the unresolved branch, not an error', async () => {
    const { episodeGapId } = await seed();
    sonarr.setParse(null);

    const preview = await previewAttach(episodeGapId);

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.target.resolved).toBe(false);
    expect(preview.value.matchesGap).toBe(false);
  });

  /* ── The write (FR8, REQ-GAPS-011..013) ─────────────────────────────────── */

  it('pushes exactly once and records one row for the attempt', async () => {
    const { episodeGapId } = await seed();
    sonarr.setParse(parsedSeries({ id: 1, title: 'Reacher', season: 1, episode: 5 }));
    sonarr.setPushResult({ rejected: false, rejections: [] });

    const outcome = await attach({ gapId: episodeGapId, link: MAGNET });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('succeeded');

    // Once. A push is not idempotent from the operator's point of view, so a
    // landed push whose response was lost must not be sent a second time.
    expect(sonarr.pushes).toHaveLength(1);
    expect(sonarr.pushes[0].body).toMatchObject({
      title: 'Reacher.S01E05.WEBDL-1080p',
      downloadUrl: MAGNET,
      protocol: 'torrent',
    });

    const log = listOperations().operations;
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('attach');
    expect(log[0].outcome).toBe('succeeded');
    expect(log[0].id).toBe(outcome.value.operationId);
  });

  it('re-synthesizes the title instead of trusting the request', async () => {
    // The browser gets to say *which* gap, never *what to call it* — otherwise
    // the client decides what the operation is recorded as.
    const { movieGapId } = await seed();
    radarr.setPushResult({ rejected: false });

    await attach({ gapId: movieGapId, link: MAGNET });

    expect(radarr.pushes[0].body.title).toBe('Dune.Part.Two.2024.WEBDL-1080p');
  });

  it('keeps every rejection reason verbatim', async () => {
    const reasons = [
      'Existing file meets cutoff: WEBDL-1080p',
      'Not a preferred word upgrade for existing episode file(s)',
    ];
    const { episodeGapId } = await seed();
    sonarr.setParse(parsedSeries({ id: 1, title: 'Reacher', season: 1, episode: 5 }));
    sonarr.setPushResult({ rejected: true, rejections: reasons });

    const outcome = await attach({ gapId: episodeGapId, link: MAGNET });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // A successful HTTP request that says no is still a refusal.
    expect(outcome.value.status).toBe('failed');
    expect(outcome.value.rejected).toBe(true);
    expect(outcome.value.rejections).toEqual(reasons);

    const [row] = listOperations().operations;
    expect(row.rejected).toBe(true);
    // Two reasons, two lines. Joined into one string, two become one.
    expect(row.detail).toEqual(reasons);
  });

  it('separates a transport failure from a refusal', async () => {
    const { episodeGapId } = await seed();
    sonarr.setPushResult(502);

    const outcome = await attach({ gapId: episodeGapId, link: MAGNET });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('failed');
    expect(outcome.value.rejected).toBe(false);
    expect(outcome.value.rejections).toEqual([]);
    expect(listOperations().operations).toHaveLength(1);
  });

  it('refuses a link that is neither a magnet nor a .torrent, before sending', async () => {
    const { episodeGapId } = await seed();

    const outcome = await attach({ gapId: episodeGapId, link: 'https://example.invalid/page.html' });

    expect(outcome.ok).toBe(false);
    expect(sonarr.pushes).toHaveLength(0);
    // Nothing was attempted, so there is nothing to record.
    expect(listOperations().operations).toHaveLength(0);
  });

  /* ── Not optimistic (REQ-GAPS-011) ──────────────────────────────────────── */

  it('leaves the gap listed after an accepted attach', async () => {
    const { episodeGapId } = await seed();
    sonarr.setPushResult({ rejected: false });

    await attach({ gapId: episodeGapId, link: MAGNET });

    // Only a later library read can say the file now exists. The instance has
    // accepted a *download*, which is not the same as having the episode.
    const after = await readGaps();
    expect(after.gaps.map((g) => g.id)).toContain(episodeGapId);
  });

  it('re-reads the library after an attach rather than serving the pre-write snapshot', async () => {
    const { episodeGapId } = await seed();
    const before = sonarr.hits.filter((h) => h.path.startsWith('/api/v3/series')).length;
    sonarr.setPushResult({ rejected: false });

    await attach({ gapId: episodeGapId, link: MAGNET });
    await readGaps();

    // helparr's own write is the one thing that can make this cache wrong
    // without warning, so the entry is dropped whatever the instance answered.
    const after = sonarr.hits.filter((h) => h.path.startsWith('/api/v3/series')).length;
    expect(after).toBeGreaterThan(before);
  });

  /* ── The link never lands in the clear (ADR-7, REQ-GAPS-013) ────────────── */

  it('stores a fingerprint of the magnet and never the magnet itself', async () => {
    const { episodeGapId } = await seed();
    sonarr.setPushResult({ rejected: false });

    await attach({ gapId: episodeGapId, link: MAGNET });

    const [row] = listOperations().operations;
    expect(row.urlSha256).toBe(createHash('sha256').update(MAGNET).digest('hex'));

    // Not just the read path — the bytes on disk. A magnet carries the
    // operator's tracker passkey, and a log row is forever.
    const db = getDb();
    const rows = db.prepare('SELECT * FROM operation').all() as Array<Record<string, unknown>>;
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain('magnet:?');
    expect(dumped).not.toContain('SECRETPASSKEY');
    expect(dumped).not.toContain('urn:btih');
    expect(dumped).toContain(row.urlSha256);
  });

  /* ── Bulk search (FR9, REQ-GAPS-008, -009; AC12) ────────────────────────── */

  it('issues one command per instance, carrying every id for it', async () => {
    const { episodeGapId, movieGapId } = await seed();

    const result = await bulkSearch([episodeGapId, movieGapId]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((o) => o.status === 'queued')).toBe(true);

    // One each, not one per id: five separate commands would be five queue
    // entries for what the operator asked once.
    expect(sonarr.commands).toHaveLength(1);
    expect(radarr.commands).toHaveLength(1);
    expect(sonarr.commands[0].body).toMatchObject({ name: 'EpisodeSearch', episodeIds: [5] });
    expect(radarr.commands[0].body).toMatchObject({ name: 'MoviesSearch', movieIds: [5] });
  });

  it('reports one instance queued and the other refused, separately', async () => {
    const { episodeGapId, movieGapId } = await seed();
    radarr.failCommands(500);

    const result = await bulkSearch([episodeGapId, movieGapId]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.value.map((o) => [o.instanceId, o]));
    expect(byId.get(sonarrId)?.status).toBe('queued');
    expect(byId.get(radarrId)?.status).toBe('failed');
    // "Queued" for a batch where half of it was refused would be the report
    // being wrong about the one thing it exists to report.
    expect(byId.get(radarrId)?.reason).toBeTruthy();
  });

  it('records one operation row per instance, whatever the verdict', async () => {
    const { episodeGapId, movieGapId } = await seed();
    radarr.failCommands(500);

    await bulkSearch([episodeGapId, movieGapId]);

    const rows = listOperations().operations;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toEqual(['search', 'search']);
    expect(rows.map((r) => r.outcome).sort()).toEqual(['failed', 'succeeded']);
    // A command carries no link, so there is nothing to fingerprint.
    expect(rows.every((r) => r.urlSha256 === null && r.urlHost === null)).toBe(true);
    // A search is never a rejection: an instance accepts a command or it does
    // not — there is no "your quality profile said no" for a search request.
    expect(rows.every((r) => r.rejected === false)).toBe(true);
  });

  it('leaves the gaps listed after a queued search', async () => {
    const { episodeGapId } = await seed();

    await bulkSearch([episodeGapId]);

    // helparr asked; it did not find anything. The gaps stay until a later
    // library read says otherwise.
    const after = await readGaps();
    expect(after.gaps.map((g) => g.id)).toContain(episodeGapId);
  });

  it('refuses a selection that is no longer in the library read', async () => {
    await seed();

    const result = await bulkSearch(['nope:episode:404']);

    expect(result.ok).toBe(false);
    expect(sonarr.commands).toHaveLength(0);
    expect(radarr.commands).toHaveLength(0);
  });
});
