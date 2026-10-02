import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';
import { buildImportPlan } from '@/server/import/build';
import { startImport } from '@/server/import/apply';
import { getImportPlan } from '@/server/import/store';
import { closeDb, getDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { listImportFileOutcomes, listOperations, purgeOperations } from '@/server/operations/log';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import type { ImportPlan } from '@/lib/importPlan';

/**
 * T23 / FR7..FR10, ADR-5..ADR-8; REQ-QUEUE-021/022, REQ-OPS-001's
 * force-import extension.
 *
 * Mirrors `rename-plan.test.ts`'s shape, against the force-import stack:
 * `buildImportPlan` is a single synchronous read (no `building` phase to
 * poll through), and `startImport` is fire-and-forget exactly as rename's
 * `startApply` is, so a test that wants the outcome polls `getImportPlan`
 * the same way the browser does.
 */

const created: string[] = [];

/** One Sonarr `/manualimport` candidate, in the shape the real route returns. */
function sonarrCandidate(options: {
  path: string;
  size?: number;
  seriesId?: number;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeId?: number;
  episodeNumber?: number;
  downloadId?: string;
  hasFile?: boolean;
  episodeFileId?: number;
  rejections?: string[];
}): unknown {
  return {
    path: options.path,
    relativePath: options.path,
    size: options.size ?? 1_000_000_000,
    quality: { quality: { id: 7, name: 'WEBDL-1080p' }, revision: { version: 1, real: 0, isRepack: false } },
    languages: [{ id: 1, name: 'English' }],
    releaseGroup: 'GROUP',
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    customFormats: [],
    customFormatScore: 0,
    rejections: options.rejections ?? [],
    downloadId: options.downloadId ?? 'HASH1',
    series: { id: options.seriesId ?? 1, title: options.seriesTitle ?? 'Reacher' },
    seasonNumber: options.seasonNumber ?? 1,
    episodes: [{
      id: options.episodeId ?? 11,
      seasonNumber: options.seasonNumber ?? 1,
      episodeNumber: options.episodeNumber ?? 1,
      title: null,
      hasFile: options.hasFile ?? false,
      episodeFileId: options.episodeFileId ?? null,
    }],
  };
}

describe('force import build and apply', () => {
  let sonarr: FakeArr;
  let radarr: FakeArr;

  function registerSonarr(): string {
    const id = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    }).id;
    created.push(id);
    return id;
  }

  function registerRadarr(): string {
    const id = createInstance({
      kind: 'radarr',
      label: 'Radarr',
      baseUrl: radarr.url,
      credential: { type: 'api-key', apiKey: 'radarr-key' },
    }).id;
    created.push(id);
    return id;
  }

  /**
   * Runs a build to settlement. `buildImportPlan` is a single synchronous
   * read (no `building` phase), so this resolves immediately — it exists
   * only to keep the shape symmetric with `applySettle` below.
   */
  async function build(instanceId: string, downloadId = 'HASH1', title = 'Reacher'): Promise<ImportPlan> {
    const result = await buildImportPlan({
      instanceId,
      queueRecordId: 1,
      downloadId,
      title,
    });
    if (!result.ok) throw new Error(`build refused: ${result.error.kind} — ${result.error.reason}`);
    return result.plan;
  }

  /**
   * `startImport` is fire-and-forget past the drift check — it returns as
   * soon as the command is accepted, and per-row outcomes resolve behind the
   * poll (ADR-7). A test that wants the settled plan polls the same way the
   * browser does.
   */
  async function settle(planId: string, timeoutMs = 15_000): Promise<ImportPlan> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const plan = getImportPlan(planId);
      if (plan && plan.phase !== 'applying') return plan;
      if (Date.now() >= deadline) {
        throw new Error(`plan ${planId} never settled (phase ${plan?.phase ?? 'missing'})`);
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    radarr = await startFakeArr({ apiKey: 'radarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    sonarr.hits.length = 0;
    sonarr.commands.length = 0;
    sonarr.setImportCandidates([]);
    sonarr.setImportHook(null);
    sonarr.setEpisodes([]);
    sonarr.setHistory([]);
    sonarr.setCommandOutcome({ status: 'completed', result: 'successful', message: null });
    sonarr.failCommands(null);
    sonarr.setMode('ok');
    radarr.hits.length = 0;
    radarr.commands.length = 0;
    radarr.setImportCandidates([]);
    radarr.setImportHook(null);
    radarr.setMode('ok');
    purgeOperations();
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    await radarr.close();
    cleanupTestDir();
  });

  /* ── Build: replacement excluded by default (ADR-8) ───────────────────── */

  it('starts a row excluded by default when it would replace an existing file', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([
      sonarrCandidate({ path: '/downloads/ep1.mkv', hasFile: false }),
      sonarrCandidate({
        path: '/downloads/ep2.mkv',
        episodeId: 12,
        episodeNumber: 2,
        hasFile: true,
        episodeFileId: 99,
      }),
    ]);

    const plan = await build(instanceId);

    const fresh = plan.rows.find((row) => row.path === '/downloads/ep1.mkv');
    const replacing = plan.rows.find((row) => row.path === '/downloads/ep2.mkv');
    expect(fresh?.included).toBe(true);
    expect(replacing?.replacesExisting).toEqual({ quality: null, fileId: 99 });
    expect(replacing?.included).toBe(false);
  });

  it('names the quality of the file a row would replace, read by id (ADR-8)', async () => {
    const instanceId = registerSonarr();
    sonarr.setExistingFile(99, {
      id: 99,
      path: '/tv/Reacher/S01E02.mkv',
      size: 1,
      quality: { quality: { id: 7, name: 'Bluray-1080p' }, revision: { version: 1, real: 0, isRepack: false } },
      customFormats: [],
      customFormatScore: 0,
      languages: [],
    });
    sonarr.setImportCandidates([
      sonarrCandidate({
        path: '/downloads/ep2.mkv',
        episodeId: 12,
        episodeNumber: 2,
        hasFile: true,
        episodeFileId: 99,
      }),
    ]);

    try {
      const plan = await build(instanceId);
      expect(plan.rows[0]?.replacesExisting).toEqual({ quality: 'Bluray-1080p', fileId: 99 });
      expect(plan.rows[0]?.included).toBe(false);
    } finally {
      sonarr.setExistingFile(99, undefined);
    }
  });

  /* ── Apply: no command before a matching count ────────────────────────── */

  it('issues no command when the typed count does not match the included rows', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([sonarrCandidate({ path: '/downloads/ep1.mkv' })]);
    const plan = await build(instanceId);

    const started = await startImport(plan.id, 7);
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error.kind === 'refused' && started.error.refusal.reason)
      .toBe('count-mismatch');
    expect(sonarr.commands.filter((c) => c.body.name === 'ManualImport')).toHaveLength(0);
    // A mistyped count is retypable, not persisted (ADR-5's reasoning
    // extends to it): the plan stays exactly where it was.
    expect(getImportPlan(plan.id)?.phase).toBe('ready');
  });

  /* ── Apply: drift refuses the whole plan, naming the change ───────────── */

  it('refuses the whole plan on drift, naming what changed, with no partial write', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([
      sonarrCandidate({ path: '/downloads/ep1.mkv' }),
      sonarrCandidate({ path: '/downloads/ep2.mkv', episodeId: 12, episodeNumber: 2 }),
    ]);
    const plan = await build(instanceId);
    const includedCount = plan.rows.filter((row) => row.included).length;

    // One candidate vanished between preview and confirmation — a size
    // change on the instance's side, modelled here as the file simply
    // dropping out of the candidate set.
    sonarr.setImportCandidates([sonarrCandidate({ path: '/downloads/ep1.mkv' })]);

    const started = await startImport(plan.id, includedCount);
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error.kind === 'refused' && started.error.refusal.reason)
      .toBe('drift');
    expect(started.ok === false && started.error.kind === 'refused'
      && started.error.refusal.changes.some((line) => line.includes('/downloads/ep2.mkv'))).toBe(true);
    expect(sonarr.commands.filter((c) => c.body.name === 'ManualImport')).toHaveLength(0);

    const settled = getImportPlan(plan.id);
    expect(settled?.phase).toBe('refused');
    expect(settled?.refusal?.reason).toBe('drift');
    expect(settled?.refusal?.changes.some((line) => line.includes('/downloads/ep2.mkv'))).toBe(true);
  });

  /* ── Apply: expiry ─────────────────────────────────────────────────────── */

  it('expires a plan on read and refuses to apply it', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([sonarrCandidate({ path: '/downloads/ep1.mkv' })]);
    const plan = await build(instanceId);

    getDb()
      .prepare('UPDATE import_plan SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), plan.id);

    expect(getImportPlan(plan.id)?.phase).toBe('expired');

    const started = await startImport(plan.id, 1);
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error.kind === 'refused' && started.error.refusal.reason)
      .toBe('expired');
    expect(sonarr.commands.filter((c) => c.body.name === 'ManualImport')).toHaveLength(0);
  });

  /* ── Apply: payload shape (ADR-6) ──────────────────────────────────────── */

  it('posts ManualImport with an explicit importMode and only the included rows', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([
      sonarrCandidate({ path: '/downloads/ep1.mkv', downloadId: 'HASH1' }),
      sonarrCandidate({
        path: '/downloads/ep2.mkv',
        episodeId: 12,
        episodeNumber: 2,
        hasFile: true,
        episodeFileId: 99,
        downloadId: 'HASH1',
      }),
    ]);
    const plan = await build(instanceId);
    // ep2 replaces an existing file and starts excluded (ADR-8); left as-is,
    // only ep1 should ever reach the command.
    const includedCount = plan.rows.filter((row) => row.included).length;
    expect(includedCount).toBe(1);

    sonarr.setImportHook(() => ({ succeeded: { '/downloads/ep1.mkv': '/tv/Reacher/Season 1/S01E01.mkv' } }));

    const started = await startImport(plan.id, includedCount);
    expect(started.ok).toBe(true);
    await settle(plan.id);

    const commands = sonarr.commands.filter((c) => c.body.name === 'ManualImport');
    expect(commands).toHaveLength(1);
    expect(commands[0].body.importMode).toBe('auto');
    const files = commands[0].body.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('/downloads/ep1.mkv');
    // The excluded replacement row never reaches the command, in any form.
    expect(JSON.stringify(commands[0].body)).not.toContain('ep2.mkv');
  });

  /* ── Apply: droppedPath read-back (ADR-7) ─────────────────────────────── */

  it('reports a row succeeded only once history names its own droppedPath', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([sonarrCandidate({ path: '/downloads/ep1.mkv', downloadId: 'HASH1' })]);
    const plan = await build(instanceId);

    sonarr.setImportHook(() => ({ succeeded: { '/downloads/ep1.mkv': '/tv/Reacher/Season 1/S01E01.mkv' } }));

    const started = await startImport(plan.id, 1);
    expect(started.ok).toBe(true);
    const settled = await settle(plan.id);

    expect(settled.phase).toBe('done');
    expect(settled.rows[0].outcome?.outcome).toBe('succeeded');
    expect(settled.rows[0].outcome?.destination).toBe('/tv/Reacher/Season 1/S01E01.mkv');
  });

  /* ── Apply: partial reported and logged ───────────────────────────────── */

  it('reports and logs a partial import: one file succeeds, one fails', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([
      sonarrCandidate({ path: '/downloads/ep1.mkv', downloadId: 'HASH1' }),
      sonarrCandidate({
        path: '/downloads/ep2.mkv',
        episodeId: 12,
        episodeNumber: 2,
        downloadId: 'HASH1',
        rejections: ['Sample'],
      }),
    ]);
    const plan = await build(instanceId);
    expect(plan.rows.filter((row) => row.included)).toHaveLength(2);

    // ep1 "lands" (the fake removes it from the candidate list and writes a
    // history event); ep2 is left untouched, so it is still a candidate
    // after the command, with its own rejection reasons intact.
    sonarr.setImportHook(() => ({ succeeded: { '/downloads/ep1.mkv': '/tv/Reacher/Season 1/S01E01.mkv' } }));

    const started = await startImport(plan.id, 2);
    expect(started.ok).toBe(true);
    const settled = await settle(plan.id);

    expect(settled.phase).toBe('done');
    const ep1 = settled.rows.find((row) => row.path === '/downloads/ep1.mkv');
    const ep2 = settled.rows.find((row) => row.path === '/downloads/ep2.mkv');
    expect(ep1?.outcome?.outcome).toBe('succeeded');
    expect(ep2?.outcome?.outcome).toBe('failed');
    expect(ep2?.outcome?.error).toContain('Sample');

    const operations = listOperations('all');
    const entry = operations.operations.find((op) => op.kind === 'import');
    expect(entry, 'no import operation was logged').toBeDefined();
    expect(entry!.outcome).toBe('failed');
    expect(entry!.summary).toContain('Force-imported 1 of 2 file(s)');

    const outcomes = listImportFileOutcomes(entry!.id);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.path === '/downloads/ep1.mkv')?.outcome).toBe('succeeded');
    expect(outcomes.find((o) => o.path === '/downloads/ep2.mkv')?.outcome).toBe('failed');
  });

  /* ── Apply: a refused plan is never logged ────────────────────────────── */

  it('writes no operation row for a refused plan', async () => {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([
      sonarrCandidate({ path: '/downloads/ep1.mkv' }),
      sonarrCandidate({ path: '/downloads/ep2.mkv', episodeId: 12, episodeNumber: 2 }),
    ]);
    const plan = await build(instanceId);
    const includedCount = plan.rows.filter((row) => row.included).length;

    sonarr.setImportCandidates([sonarrCandidate({ path: '/downloads/ep1.mkv' })]);

    const started = await startImport(plan.id, includedCount);
    expect(started.ok).toBe(false);

    expect(sonarr.commands.filter((c) => c.body.name === 'ManualImport')).toHaveLength(0);
    const operations = listOperations('all');
    expect(operations.operations.find((op) => op.kind === 'import')).toBeUndefined();
  });

  /* ── Apply: Radarr (ADR-6, amended — T0 waived) ───────────────────────── */

  it('posts a Radarr ManualImport keyed by movieId, with an explicit importMode', async () => {
    const instanceId = registerRadarr();
    radarr.setImportCandidates([{
      path: '/downloads/movie.mkv',
      relativePath: '/downloads/movie.mkv',
      size: 2_000_000_000,
      quality: { quality: { id: 7, name: 'WEBDL-1080p' }, revision: { version: 1, real: 0, isRepack: false } },
      languages: [{ id: 1, name: 'English' }],
      releaseGroup: 'GROUP',
      indexerFlags: 0,
      releaseType: 'single',
      customFormats: [],
      customFormatScore: 0,
      rejections: [],
      downloadId: 'HASH2',
      movie: { id: 5, title: 'Heat', year: 1995, hasFile: false, movieFileId: null },
    }]);

    const plan = await build(instanceId, 'HASH2', 'Heat');
    expect(plan.instanceKind).toBe('radarr');

    const includedCount = plan.rows.filter((row) => row.included).length;
    expect(includedCount).toBe(1);
    radarr.setImportHook(() => ({ succeeded: { '/downloads/movie.mkv': '/movies/Heat (1995)/Heat.mkv' } }));

    const started = await startImport(plan.id, includedCount);
    expect(started.ok).toBe(true);
    await settle(plan.id);

    const commands = radarr.commands.filter((c) => c.body.name === 'ManualImport');
    expect(commands).toHaveLength(1);
    expect(commands[0].body.importMode).toBe('auto');
    const files = commands[0].body.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: '/downloads/movie.mkv', movieId: 5, downloadId: 'HASH2' });
    expect(files[0]).not.toHaveProperty('seriesId');
    expect(files[0]).not.toHaveProperty('episodeIds');
  });
});
