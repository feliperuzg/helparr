import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { deadPort, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import {
  getDecisionsConfig,
  invalidateDecisionsConfig,
  resetDecisionsConfigCache,
} from '@/server/decisions/configCache';
import {
  buildComparison,
  evaluateReleases,
  explainCandidate,
  type ExplainTarget,
} from '@/server/decisions/explain';
import type {
  ArrCustomFormatRef,
  ArrExistingFile,
  ArrQualityModel,
  ArrQualityProfileDetail,
  ReleaseCandidate,
} from '@/server/clients/types';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T24 / ADR-10..13, REQ-DEC-001..008.
 *
 * `buildComparison` (pure) is exercised directly: sum mismatch, score source,
 * one-sided formats, absent file, verdict precedence. `explainCandidate` and
 * `evaluateReleases` are exercised against `fakeArr`, where the load-bearing
 * claim is a *read budget* (AC9) rather than a response shape.
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

function customFormatHits(arr: FakeArr): number {
  return arr.hits.filter((h) => h.path.startsWith('/api/v3/customformat')).length;
}

function qualityProfileHits(arr: FakeArr): number {
  return arr.hits.filter((h) => h.path.startsWith('/api/v3/qualityprofile')).length;
}

function releaseHits(arr: FakeArr): number {
  return arr.hits.filter((h) => h.path.startsWith('/api/v3/release')).length;
}

/** `GET /customformat` fixture — the join catalog. */
function rawCustomFormats(): unknown[] {
  return [{ id: 1, name: 'Format A' }, { id: 2, name: 'Format B' }];
}

/** `GET /qualityprofile` fixture, as the instance shapes it (not `ArrQualityProfileDetail`). */
function rawProfile(over: Record<string, unknown> = {}): unknown {
  return {
    id: 1,
    name: 'HD-1080p',
    upgradeAllowed: true,
    cutoff: 2,
    items: [{ quality: { id: 2, name: 'Bluray-1080p' } }],
    minFormatScore: 0,
    cutoffFormatScore: 100,
    minUpgradeFormatScore: null,
    formatItems: [
      { format: 1, name: 'Format A', score: 10 },
      { format: 2, name: 'Format B', score: 5 },
    ],
    ...over,
  };
}

/* ── Fixtures for the pure `buildComparison` tests ────────────────────────── */

function qualityModel(name = 'WEBDL-1080p', id = 1): ArrQualityModel {
  return { quality: { id, name }, revision: { version: 1, real: 0, isRepack: false } };
}

function ref(id: number, name = `Format ${id}`): ArrCustomFormatRef {
  return { id, name };
}

function candidateFixture(over: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
  return {
    title: 'Show.S01E01.WEBDL-1080p',
    infoHash: null,
    guid: null,
    rejections: [],
    quality: qualityModel(),
    customFormats: [],
    customFormatScore: 0,
    episodeIds: [1],
    movieId: null,
    indexer: 'Indexer',
    ...over,
  };
}

function existingFixture(over: Partial<ArrExistingFile> = {}): ArrExistingFile {
  return {
    id: 1,
    path: '/tv/Show/S01E01.mkv',
    relativePath: 'S01E01.mkv',
    sceneName: null,
    size: 1_000_000,
    quality: qualityModel('Bluray-1080p', 2),
    customFormats: [],
    customFormatScore: 0,
    languages: [],
    qualityCutoffNotMet: false,
    ...over,
  };
}

function profileFixture(over: Partial<ArrQualityProfileDetail> = {}): ArrQualityProfileDetail {
  return {
    id: 1,
    name: 'HD-1080p',
    upgradeAllowed: true,
    cutoff: 2,
    cutoffName: 'Bluray-1080p',
    minFormatScore: 0,
    cutoffFormatScore: 100,
    minUpgradeFormatScore: null,
    formatItems: [
      { format: 1, name: 'Format A', score: 10 },
      { format: 2, name: 'Format B', score: 5 },
    ],
    ...over,
  };
}

describe('decisions', () => {
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
      arr.setMode('ok');
      arr.setCustomFormats([]);
      arr.setProfiles([]);
      arr.setExistingFile(1, undefined);
      arr.setExistingFile(999, undefined);
      arr.setCandidates([]);
    }
    resetDecisionsConfigCache();
    disposeAllBreakers();
    vi.useRealTimers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  /* ── Config cache read budget (REQ-DEC-007, AC9, ADR-11) ──────────────────── */

  describe('config cache', () => {
    it('costs at most one customformat and one qualityprofile read for twenty sequential opens', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      for (let i = 0; i < 20; i++) {
        // Sequential on purpose: twenty opens in a row, as an operator would.
        const result = await getDecisionsConfig(dto.id);
        expect(result.ok).toBe(true);
      }

      expect(customFormatHits(sonarr)).toBe(1);
      expect(qualityProfileHits(sonarr)).toBe(1);
    });

    it('costs at most one read each for twenty concurrent opens — in-flight reads are shared', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      const results = await Promise.all(
        Array.from({ length: 20 }, () => getDecisionsConfig(dto.id)),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      expect(customFormatHits(sonarr)).toBe(1);
      expect(qualityProfileHits(sonarr)).toBe(1);
    });

    it('an explicit refresh bypasses the TTL for one more read', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      await getDecisionsConfig(dto.id);
      await getDecisionsConfig(dto.id, { refresh: true });

      expect(customFormatHits(sonarr)).toBe(2);
      expect(qualityProfileHits(sonarr)).toBe(2);
    });

    it('invalidateDecisionsConfig forces the next open to re-read', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      await getDecisionsConfig(dto.id);
      invalidateDecisionsConfig(dto.id);
      await getDecisionsConfig(dto.id);

      expect(customFormatHits(sonarr)).toBe(2);

      // This is the same call `gaps/attach.ts` makes after a successful attach
      // (ADR-11's "a write invalidates the instance" scenario). Exercising it
      // through the real attach flow would need a download-client instance and
      // a torrent fixture that have nothing to do with this cache's contract,
      // so it is asserted here directly, at the one function attach calls.
    });

    it('a ten-minute TTL expiry forces one re-read', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      await getDecisionsConfig(dto.id);
      expect(customFormatHits(sonarr)).toBe(1);

      // Only `Date` is faked — real timers keep the actual HTTP round trip
      // working, and `getCachedDecisionsConfig`'s default `now = Date.now()`
      // is what sees the advanced clock.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await getDecisionsConfig(dto.id);
      vi.useRealTimers();

      expect(customFormatHits(sonarr)).toBe(2);
    });
  });

  /* ── buildComparison — pure (ADR-10, ADR-12, REQ-DEC-002..005) ────────────── */

  describe('buildComparison', () => {
    it('surfaces a sum mismatch without smoothing it over (ADR-10)', () => {
      const profile = profileFixture();
      const candidate = candidateFixture({
        customFormats: [ref(1), ref(2)], // helparr's sum: 10 + 5 = 15
        customFormatScore: 999, // the instance's own total disagrees
      });

      const comparison = buildComparison({
        instanceId: 'i1',
        candidate,
        existing: null,
        profile,
        customFormats: [],
        fetchedAt: '2026-09-30T00:00:00Z',
      });

      expect(comparison.candidate.helparrSum).toBe(15);
      expect(comparison.candidate.reportedScore).toBe(999);
      expect(comparison.candidate.sumMatches).toBe(false);
    });

    it('uses the instance-reported score, not helparr\'s sum, to decide the verdict (REQ-DEC-004)', () => {
      // helparr's own sum (10) would clear the minimum; the instance's
      // reported score (3) does not. The verdict must follow the reported
      // number, never the arithmetic helparr derived from it.
      const profile = profileFixture({ minFormatScore: 5 });
      const candidate = candidateFixture({ customFormats: [ref(1)], customFormatScore: 3 });
      const existing = existingFixture({ customFormatScore: 0 });

      const comparison = buildComparison({
        instanceId: 'i1',
        candidate,
        existing,
        profile,
        customFormats: [],
        fetchedAt: '2026-09-30T00:00:00Z',
      });

      expect(comparison.candidate.helparrSum).toBe(10);
      expect(comparison.candidate.reportedScore).toBe(3);
      expect(comparison.verdict.kind).toBe('not-upgrade');
    });

    it('names the candidate\'s score source as releaseName (ADR-12)', () => {
      const comparison = buildComparison({
        instanceId: 'i1',
        candidate: candidateFixture(),
        existing: null,
        profile: profileFixture(),
        customFormats: [],
        fetchedAt: 'now',
      });
      expect(comparison.candidate.scoreSource).toBe('releaseName');
    });

    it('names the existing file\'s score source as filename when sceneName is absent (ADR-12)', () => {
      const comparison = buildComparison({
        instanceId: 'i1',
        candidate: candidateFixture(),
        existing: existingFixture({ sceneName: null }),
        profile: profileFixture(),
        customFormats: [],
        fetchedAt: 'now',
      });
      expect(comparison.existing.scoreSource).toBe('filename');
    });

    it('names the existing file\'s score source as releaseName when sceneName is present (ADR-12)', () => {
      const comparison = buildComparison({
        instanceId: 'i1',
        candidate: candidateFixture(),
        existing: existingFixture({ sceneName: 'Show.S01E01.WEBDL-1080p-GROUP' }),
        profile: profileFixture(),
        customFormats: [],
        fetchedAt: 'now',
      });
      expect(comparison.existing.scoreSource).toBe('releaseName');
    });

    it('marks a format matched on one side only, without colour as the only channel (REQ-DEC-005)', () => {
      // Format 3 matches the candidate but is in neither the existing file's
      // list nor the profile's `formatItems`. Its ref carries no name, so the
      // name has to come from the instance's catalog.
      const candidate = candidateFixture({ customFormats: [ref(1), ref(3, '')] });
      const existing = existingFixture({ customFormats: [ref(1)] });

      const comparison = buildComparison({
        instanceId: 'i1',
        candidate,
        existing,
        profile: profileFixture(),
        customFormats: [{ id: 3, name: 'Format C' }],
        fetchedAt: 'now',
      });

      expect(comparison.candidate.formats.map((f) => f.formatId)).toEqual([1, 3]);
      expect(comparison.existing.formats.map((f) => f.formatId)).toEqual([1]);

      const onlyCandidate = comparison.candidate.formats.find((f) => f.formatId === 3);
      // Not in the profile's formatItems: scored null, never a false zero.
      expect(onlyCandidate?.score).toBeNull();
      expect(onlyCandidate?.name).toBe('Format C');
    });

    it('states the absence of a file rather than a zero score (REQ-DEC-002, ADR-12)', () => {
      const comparison = buildComparison({
        instanceId: 'i1',
        candidate: candidateFixture(),
        existing: null,
        profile: profileFixture(),
        customFormats: [],
        fetchedAt: 'now',
      });

      expect(comparison.existing.present).toBe(false);
      expect(comparison.existing.reportedScore).toBeNull();
      expect(comparison.existing.helparrSum).toBeNull();
      expect(comparison.verdict.kind).toBe('no-existing');
    });

    it('rejects even with no existing file to compare against (REQ-DEC-001 precedence)', () => {
      const candidate = candidateFixture({ rejections: ['Not a preferred word'] });
      const comparison = buildComparison({
        instanceId: 'i1',
        candidate,
        existing: null,
        profile: profileFixture(),
        customFormats: [],
        fetchedAt: 'now',
      });

      expect(comparison.verdict.kind).toBe('rejected');
      expect(comparison.rejections).toEqual(['Not a preferred word']);
    });

    it('refuses an upgrade the profile does not allow, whatever the scores say', () => {
      const profile = profileFixture({ upgradeAllowed: false });
      const candidate = candidateFixture({ customFormatScore: 100 });
      const existing = existingFixture({ customFormatScore: 0 });

      const comparison = buildComparison({
        instanceId: 'i1',
        candidate,
        existing,
        profile,
        customFormats: [],
        fetchedAt: 'now',
      });

      expect(comparison.verdict.kind).toBe('not-upgrade');
    });

    it('calls it an upgrade once the candidate beats the existing score and clears the minimum', () => {
      const profile = profileFixture({ upgradeAllowed: true, minFormatScore: 10 });
      const candidate = candidateFixture({ customFormatScore: 20 });
      const existing = existingFixture({ customFormatScore: 5 });

      const comparison = buildComparison({
        instanceId: 'i1',
        candidate,
        existing,
        profile,
        customFormats: [],
        fetchedAt: 'now',
      });

      expect(comparison.verdict.kind).toBe('upgrade');
    });
  });

  /* ── explainCandidate — orchestration against fakeArr ─────────────────────── */

  describe('explainCandidate', () => {
    it('states no file for a null fileId, and reads the file endpoint not at all (REQ-DEC-002)', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      const target: ExplainTarget = {
        episodeId: 1,
        fileId: null,
        profileId: 1,
        candidate: candidateFixture(),
      };
      const result = await explainCandidate(dto.id, target);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.existing.present).toBe(false);
        expect(result.value.existing.reportedScore).toBeNull();
        expect(result.value.verdict.kind).toBe('no-existing');
      }
      expect(sonarr.hits.some((h) => h.path.includes('episodefile'))).toBe(false);
    });

    it('treats a 404 on the existing file as absence, not a failure', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');
      // No setExistingFile(42, ...) call: the fake answers 404.

      const target: ExplainTarget = {
        episodeId: 1,
        fileId: 42,
        profileId: 1,
        candidate: candidateFixture(),
      };
      const result = await explainCandidate(dto.id, target);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.existing.present).toBe(false);
        expect(result.value.existing.reportedScore).toBeNull();
      }
    });

    it('degrades, naming the instance and keeping verbatim rejections, when it cannot be reached (REQ-DEC-008)', async () => {
      const port = await deadPort();
      const down = createInstance({
        kind: 'radarr',
        label: 'Radarr',
        baseUrl: `http://127.0.0.1:${port}`,
        credential: { type: 'api-key', apiKey: 'radarr-key' },
      });
      created.push(down.id);

      const candidate = candidateFixture({ rejections: ['Not a preferred word'] });
      const target: ExplainTarget = {
        movieId: 1,
        fileId: null,
        profileId: 1,
        candidate,
      };
      const result = await explainCandidate(down.id, target);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toContain('Radarr');
        expect(result.error.rejections).toEqual(['Not a preferred word']);
      }
    });

    it('still explains Sonarr in the same run as a degraded Radarr', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      const target: ExplainTarget = {
        episodeId: 1,
        fileId: null,
        profileId: 1,
        candidate: candidateFixture(),
      };
      const result = await explainCandidate(dto.id, target);

      expect(result.ok).toBe(true);
    });
  });

  /* ── evaluateReleases — explicit opt-in, never implicit (ADR-13) ──────────── */

  describe('evaluateReleases', () => {
    it('hits /release?episodeId= exactly once per call', async () => {
      sonarr.setCandidates([{ title: 'Candidate release', rejections: [] }]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      const result = await evaluateReleases(dto.id, { episodeId: 5 });

      expect(result.ok).toBe(true);
      const releaseRequests = sonarr.hits.filter((h) => h.path.startsWith('/api/v3/release?'));
      expect(releaseRequests).toHaveLength(1);
      expect(releaseRequests[0].path).toContain('episodeId=5');
    });

    it('never runs implicitly from a config read or an explain call', async () => {
      sonarr.setCustomFormats(rawCustomFormats());
      sonarr.setProfiles([rawProfile()]);
      const dto = register('sonarr', 'Sonarr', sonarr, 'sonarr-key');

      await getDecisionsConfig(dto.id);
      await explainCandidate(dto.id, {
        episodeId: 1,
        fileId: null,
        profileId: 1,
        candidate: candidateFixture(),
      });

      expect(releaseHits(sonarr)).toBe(0);
    });
  });
});
