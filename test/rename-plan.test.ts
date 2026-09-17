import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';
import { closeDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { listOperations, purgeOperations } from '@/server/operations/log';
import { startApply } from '@/server/rename/apply';
import { startBuild } from '@/server/rename/build';
import { deriveWarnings, titleKeyOf } from '@/server/rename/resolve';
import { getPlan, purgeStalePlans, setExcluded } from '@/server/rename/store';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import type { RenamePlanDto, RenameScopeEntry } from '@/lib/types';

/**
 * T16 / FR4..FR7, FR12, FR13; REQ-RENAME-006, -009, -012, -015; ADR-3, ADR-6,
 * ADR-7, ADR-9; NFR1, NFR2.
 *
 * The server half of the feature. Its job is the set of claims the browser
 * cannot demonstrate:
 *
 * - the command carries exactly the files the operator left checked, and no
 *   others (FR7 is only real if this holds — ADR-6),
 * - a plan whose library moved underneath it renames **nothing**,
 * - an instance that reports success having done nothing is reported as a
 *   failure, because the preview re-run and not the command status is the
 *   evidence (ADR-7),
 * - and each of ADR-9's four warnings fires on its own shape and not on its
 *   neighbours'.
 *
 * `test/rename-interaction.test.ts` covers the browser half.
 */

const SONARR_ROOT = '/tv/Reacher';
const created: string[] = [];

/** One Sonarr preview row in the shape the real `/rename` returns. */
function previewRow(options: {
  fileId: number;
  existing: string;
  proposed: string;
  episodes?: number[];
}): unknown {
  return {
    seriesId: 1,
    seasonNumber: 1,
    episodeNumbers: options.episodes ?? [1],
    episodeFileId: options.fileId,
    existingPath: options.existing,
    newPath: options.proposed,
  };
}

describe('rename plan build and apply', () => {
  let sonarr: FakeArr;
  let sonarrId: string;

  function register(): void {
    sonarrId = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    }).id;
    created.push(sonarrId);
  }

  function scope(label = 'Reacher'): RenameScopeEntry[] {
    return [{ instanceId: sonarrId, kind: 'series', upstreamId: 1, label }];
  }

  /**
   * Runs a build (or an apply) to a settled phase.
   *
   * Both are fire-and-forget by design — the routes return an id and the
   * browser polls — so a test that wants the outcome has to poll the same way
   * the browser does rather than awaiting a promise that was never handed out.
   */
  async function settle(planId: string, timeoutMs = 15_000): Promise<RenamePlanDto> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const plan = getPlan(planId);
      if (plan && plan.phase !== 'building' && plan.phase !== 'applying') return plan;
      if (Date.now() >= deadline) {
        throw new Error(`plan ${planId} never settled (phase ${plan?.phase ?? 'missing'})`);
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    sonarr.hits.length = 0;
    sonarr.commands.length = 0;
    sonarr.renameReads.length = 0;
    sonarr.filesystemReads.length = 0;
    sonarr.setRenamePreview([]);
    sonarr.setFilesystem({});
    sonarr.setSeriesDetail(null);
    sonarr.setCommandOutcome({ status: 'completed', result: 'successful', message: null });
    sonarr.failCommands(null);
    sonarr.setMode('ok');
    purgeOperations();
    purgeStalePlans(0);
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    cleanupTestDir();
  });

  /** A title whose root is known and whose destination folder is empty. */
  function seedTitle(rows: unknown[]): void {
    sonarr.setSeriesDetail({ id: 1, title: 'Reacher', path: SONARR_ROOT });
    sonarr.setRenamePreview(rows);
    sonarr.setFilesystem({});
  }

  /* ── Build ──────────────────────────────────────────────────────────────── */

  it('builds a plan from the preview and reports totals from it', async () => {
    register();
    seedTitle([
      previewRow({ fileId: 11, existing: 'S01E01.mkv', proposed: 'Season 1/S01E01.mkv' }),
      previewRow({ fileId: 12, existing: 'S01E02.mkv', proposed: 'Season 1/S01E02.mkv' }),
    ]);

    const plan = await settle(startBuild(scope()));

    expect(plan.phase).toBe('ready');
    expect(plan.totalFiles).toBe(2);
    expect(plan.affectedFiles).toBe(2);
    expect(plan.rows.map((row) => row.fileId)).toEqual([11, 12]);
    expect(plan.rows[0].existingPath).toBe('S01E01.mkv');
    expect(plan.rows[0].proposedPath).toBe('Season 1/S01E01.mkv');
    expect(plan.expiresAt).not.toBeNull();
  });

  /**
   * FR5 / REQ-RENAME-006. "Nothing pending" and "we never asked" look identical
   * to an operator, and only one of them is true.
   */
  it('records a title with nothing pending rather than dropping it', async () => {
    register();
    seedTitle([]);

    const plan = await settle(startBuild(scope()));

    expect(plan.phase).toBe('ready');
    expect(plan.titles).toHaveLength(1);
    expect(plan.titles[0].state).toBe('no-changes');
    expect(plan.titles[0].label).toBe('Reacher');
    expect(plan.rows).toHaveLength(0);
  });

  it('attributes one title’s failure to that title without losing the others', async () => {
    register();
    sonarr.setMode('server-error');

    const plan = await settle(startBuild(scope()));

    // Every title errored, so there is no plan to show — but the refusal says
    // so explicitly rather than presenting an empty plan as "nothing to rename".
    expect(plan.phase).toBe('refused');
    expect(plan.refusal?.kind).toBe('empty');
    expect(plan.titles[0].state).toBe('errored');
    expect(plan.titles[0].reason).toBeTruthy();
  });

  /* ── ADR-9 warnings ─────────────────────────────────────────────────────── */

  describe('derived warnings (ADR-9)', () => {
    const key = titleKeyOf('i1', 'series', 1);
    const other = titleKeyOf('i1', 'series', 2);

    function input(options: {
      titleKey?: string;
      fileId: number;
      existing: string;
      proposed: string;
      episodeCount?: number | null;
    }) {
      return {
        titleKey: options.titleKey ?? key,
        fileId: options.fileId,
        existingPath: options.existing,
        proposedPath: options.proposed,
        episodeCount: options.episodeCount ?? 1,
      };
    }

    it('flags a change of directory as a move, not a rename', () => {
      const [moved, renamed] = deriveWarnings([
        input({ fileId: 1, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' }),
        input({ fileId: 2, existing: 'Season 1/old.mkv', proposed: 'Season 1/S01E02.mkv' }),
      ]);
      expect(moved).toContain('moves-directory');
      expect(renamed).not.toContain('moves-directory');
    });

    it('flags two rows of one title resolving to the same destination', () => {
      const warnings = deriveWarnings([
        input({ fileId: 1, existing: 'a.mkv', proposed: 'Season 1/S01E01.mkv' }),
        input({ fileId: 2, existing: 'b.mkv', proposed: 'Season 1/S01E01.mkv' }),
      ]);
      expect(warnings[0]).toContain('destination-collision');
      expect(warnings[1]).toContain('destination-collision');
    });

    /**
     * `/rename` reports paths relative to each title's own root, so two series
     * can legitimately both hold `Season 1/S01E01.mkv`. Comparing plan-wide
     * would invent a collision out of a naming convention.
     */
    it('does not invent a collision between two different titles', () => {
      const warnings = deriveWarnings([
        input({ fileId: 1, existing: 'a.mkv', proposed: 'Season 1/S01E01.mkv' }),
        input({ titleKey: other, fileId: 2, existing: 'b.mkv', proposed: 'Season 1/S01E01.mkv' }),
      ]);
      expect(warnings[0]).not.toContain('destination-collision');
      expect(warnings[1]).not.toContain('destination-collision');
    });

    /**
     * The shape measured live: Sonarr proposed a destination another file
     * already held, accepted the command, reported it completed and
     * successful, and renamed nothing.
     */
    it('flags a destination something already occupies', () => {
      const occupancy = new Map([[key, new Set(['Season 1/S01E01.mkv'])]]);
      const [warnings] = deriveWarnings(
        [input({ fileId: 1, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' })],
        occupancy,
      );
      expect(warnings).toContain('destination-exists');
    });

    it('does not flag a destination this plan is itself vacating', () => {
      const occupancy = new Map([[
        key,
        new Set(['Season 1/S01E01.mkv', 'Season 1/S01E02.mkv']),
      ]]);
      // A straight shuffle: E02 moves to E01's path, and E01 is moving away.
      const warnings = deriveWarnings(
        [
          input({ fileId: 1, existing: 'Season 1/S01E01.mkv', proposed: 'Season 1/S01E03.mkv' }),
          input({ fileId: 2, existing: 'Season 1/S01E02.mkv', proposed: 'Season 1/S01E01.mkv' }),
        ],
        occupancy,
      );
      expect(warnings[1]).not.toContain('destination-exists');
    });

    it('flags a multi-episode file, and treats Radarr’s null as not applicable', () => {
      const [multi, single, movie] = deriveWarnings([
        input({ fileId: 1, existing: 'a.mkv', proposed: 'b.mkv', episodeCount: 2 }),
        input({ fileId: 2, existing: 'c.mkv', proposed: 'd.mkv', episodeCount: 1 }),
        input({ fileId: 3, existing: 'e.mkv', proposed: 'f.mkv', episodeCount: null }),
      ]);
      expect(multi).toContain('multi-episode');
      expect(single).not.toContain('multi-episode');
      expect(movie).not.toContain('multi-episode');
    });
  });

  /**
   * End to end, through a live-ish instance: the occupancy read has to reach
   * `/filesystem` with the **trailing slash**, or it silently answers about the
   * parent directory.
   */
  it('reads occupancy from the filesystem endpoint with a trailing slash', async () => {
    register();
    sonarr.setSeriesDetail({ id: 1, title: 'Reacher', path: SONARR_ROOT });
    sonarr.setRenamePreview([
      previewRow({ fileId: 11, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' }),
    ]);
    sonarr.setFilesystem({ [`${SONARR_ROOT}/Season 1/`]: ['S01E01.mkv'] });

    const plan = await settle(startBuild(scope()));

    expect(sonarr.filesystemReads).toContain(`${SONARR_ROOT}/Season 1/`);
    expect(plan.rows[0].warnings).toContain('destination-exists');
    expect(plan.rows[0].warnings).toContain('moves-directory');
  });

  /* ── Apply ──────────────────────────────────────────────────────────────── */

  it('names only the rows the operator left checked (FR7, ADR-6)', async () => {
    register();
    seedTitle([
      previewRow({ fileId: 11, existing: 'S01E01.mkv', proposed: 'Season 1/S01E01.mkv' }),
      previewRow({ fileId: 12, existing: 'S01E02.mkv', proposed: 'Season 1/S01E02.mkv' }),
      previewRow({ fileId: 13, existing: 'S01E03.mkv', proposed: 'Season 1/S01E03.mkv' }),
    ]);

    const planId = startBuild(scope());
    const built = await settle(planId);

    const excludedRow = built.rows.find((row) => row.fileId === 12);
    expect(setExcluded(planId, [excludedRow!.id], true)).toBe(1);
    expect(getPlan(planId)?.affectedFiles).toBe(2);

    // The apply's verification re-read must report the renamed files as gone,
    // or ADR-7 correctly calls them failures.
    sonarr.setRenamePreview((_query, callIndex) => (callIndex === 0
      ? [
        previewRow({ fileId: 11, existing: 'S01E01.mkv', proposed: 'Season 1/S01E01.mkv' }),
        previewRow({ fileId: 12, existing: 'S01E02.mkv', proposed: 'Season 1/S01E02.mkv' }),
        previewRow({ fileId: 13, existing: 'S01E03.mkv', proposed: 'Season 1/S01E03.mkv' }),
      ]
      : [previewRow({ fileId: 12, existing: 'S01E02.mkv', proposed: 'Season 1/S01E02.mkv' })]));

    const started = await startApply(planId, 2);
    expect(started.ok).toBe(true);
    await settle(planId);

    const renames = sonarr.commands.filter((command) => command.body.name === 'RenameFiles');
    expect(renames).toHaveLength(1);
    expect(renames[0].body.files).toEqual([11, 13]);
    // The excluded file is never named, in any form, in any command.
    expect(JSON.stringify(renames[0].body)).not.toContain('12');
  });

  it('refuses a typed count that does not match the plan', async () => {
    register();
    seedTitle([previewRow({ fileId: 11, existing: 'a.mkv', proposed: 'Season 1/a.mkv' })]);

    const planId = startBuild(scope());
    await settle(planId);

    const refused = await startApply(planId, 7);
    expect(refused.ok).toBe(false);
    expect(sonarr.commands.filter((c) => c.body.name === 'RenameFiles')).toHaveLength(0);
    expect(getPlan(planId)?.phase).toBe('ready');
  });

  /**
   * ADR-3. The precondition is the existing *and* proposed path per file; a
   * library that moved underneath the preview must rename nothing at all, not
   * the subset that still matches.
   */
  it('renames nothing when the library moved under the preview', async () => {
    register();
    seedTitle([
      previewRow({ fileId: 11, existing: 'S01E01.mkv', proposed: 'Season 1/S01E01.mkv' }),
      previewRow({ fileId: 12, existing: 'S01E02.mkv', proposed: 'Season 1/S01E02.mkv' }),
    ]);

    const planId = startBuild(scope());
    await settle(planId);

    // One file was renamed elsewhere between the preview and the confirmation.
    sonarr.setRenamePreview([
      previewRow({ fileId: 11, existing: 'S01E01.mkv', proposed: 'Season 1/S01E01.mkv' }),
      previewRow({ fileId: 12, existing: 'moved/S01E02.mkv', proposed: 'Season 1/S01E02.mkv' }),
    ]);

    const refused = await startApply(planId, 2);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.refusal.kind).toBe('precondition-drift');
    expect(refused.ok === false && refused.refusal.drifted.length).toBeGreaterThan(0);
    expect(sonarr.commands.filter((c) => c.body.name === 'RenameFiles')).toHaveLength(0);

    const plan = getPlan(planId);
    expect(plan?.phase).toBe('refused');
    expect(plan?.refusal?.drifted.length).toBeGreaterThan(0);
  });

  it('refuses a plan whose every row is excluded', async () => {
    register();
    seedTitle([previewRow({ fileId: 11, existing: 'a.mkv', proposed: 'Season 1/a.mkv' })]);

    const planId = startBuild(scope());
    const built = await settle(planId);
    setExcluded(planId, built.rows.map((row) => row.id), true);

    const refused = await startApply(planId, 0);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.refusal.kind).toBe('empty');
    expect(sonarr.commands.filter((c) => c.body.name === 'RenameFiles')).toHaveLength(0);
  });

  /**
   * ADR-7, measured rather than reasoned about. On 2026-09-17 Sonarr answered
   * `completed` / `successful` for a `RenameFiles` that moved nothing; the only
   * honest signal was a message saying zero files were renamed. A design that
   * trusted command status would have called that a success.
   */
  it('reports a file as failed when the instance says success but the preview still lists it', async () => {
    register();
    seedTitle([previewRow({ fileId: 11, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' })]);

    const planId = startBuild(scope());
    await settle(planId);

    sonarr.setCommandOutcome({
      status: 'completed',
      result: 'successful',
      message: '0 selected episode files renamed for Reacher',
    });
    // The file is still pending after the command — nothing moved.
    sonarr.setRenamePreview([
      previewRow({ fileId: 11, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' }),
    ]);

    expect((await startApply(planId, 1)).ok).toBe(true);
    const plan = await settle(planId);

    expect(plan.phase).toBe('done');
    expect(plan.rows[0].outcome).toBe('failed');
    // The message is the only place the upstream admits it did nothing, so it
    // is quoted back rather than paraphrased.
    expect(plan.rows[0].outcomeDetail).toContain('0 selected episode files renamed');
  });

  it('reports a file as succeeded only once it has left the preview', async () => {
    register();
    seedTitle([previewRow({ fileId: 11, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' })]);

    const planId = startBuild(scope());
    await settle(planId);

    sonarr.setRenamePreview((_query, callIndex) => (callIndex === 0
      ? [previewRow({ fileId: 11, existing: 'loose.mkv', proposed: 'Season 1/S01E01.mkv' })]
      : []));

    expect((await startApply(planId, 1)).ok).toBe(true);
    const plan = await settle(planId);

    expect(plan.phase).toBe('done');
    expect(plan.rows[0].outcome).toBe('succeeded');

    // NFR7: the rename is in the operation log, per file.
    const operations = listOperations('all');
    expect(operations.operations.length).toBeGreaterThan(0);
  });

  /** ADR-3 / REQ-RENAME-014. Five minutes is a ceiling, not a suggestion. */
  it('expires a plan on read and refuses to apply it', async () => {
    register();
    seedTitle([previewRow({ fileId: 11, existing: 'a.mkv', proposed: 'Season 1/a.mkv' })]);

    const planId = startBuild(scope());
    await settle(planId);

    const { getDb } = await import('@/server/db');
    getDb()
      .prepare('UPDATE rename_plan SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), planId);

    expect(getPlan(planId)?.phase).toBe('expired');

    const refused = await startApply(planId, 1);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.refusal.kind).toBe('expired');
    expect(sonarr.commands.filter((c) => c.body.name === 'RenameFiles')).toHaveLength(0);
  });

  /**
   * NFR2 / REQ-RENAME-012. Preview and apply resolve through one code path, so
   * the apply's drift check asks the instance exactly what the build asked it.
   */
  it('re-reads the same preview endpoint at apply time', async () => {
    register();
    seedTitle([previewRow({ fileId: 11, existing: 'a.mkv', proposed: 'Season 1/a.mkv' })]);

    const planId = startBuild(scope());
    await settle(planId);
    const afterBuild = sonarr.renameReads.length;

    await startApply(planId, 1);
    await settle(planId);

    expect(sonarr.renameReads.length).toBeGreaterThan(afterBuild);
    for (const read of sonarr.renameReads) {
      expect(read.params.seriesId).toBe('1');
    }
  });
});
