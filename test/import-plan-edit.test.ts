import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';
import { includedCount, type ImportPlan } from '@/lib/importPlan';
import { buildImportPlan, editImportRow, editImportRows } from '@/server/import/build';
import { patchSchema } from '@/server/import/editSchema';
import { closeDb, getDb } from '@/server/db';
import { getImportPlan, updateImportRows } from '@/server/import/store';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { disposeAllBreakers } from '@/server/resilience/breaker';

/**
 * T5 / ADR-6, REQ-QUEUE-025.
 *
 * Mirrors `import-plan.test.ts`'s fixture style (the same `sonarrCandidate`
 * shape, the same fake-arr-backed `buildImportPlan`), scoped to the row-edit
 * surface this task adds: `updateImportRows`'s one-transaction bulk write and
 * `patchSchema`'s strict union.
 */

const created: string[] = [];

function sonarrCandidate(options: {
  path: string;
  episodeId?: number;
  episodeNumber?: number;
  hasFile?: boolean;
  episodeFileId?: number;
}): unknown {
  return {
    path: options.path,
    relativePath: options.path,
    size: 1_000_000_000,
    quality: { quality: { id: 7, name: 'WEBDL-1080p' }, revision: { version: 1, real: 0, isRepack: false } },
    languages: [{ id: 1, name: 'English' }],
    releaseGroup: 'GROUP',
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    customFormats: [],
    customFormatScore: 0,
    rejections: [],
    downloadId: 'HASH1',
    series: { id: 1, title: 'Reacher' },
    seasonNumber: 1,
    episodes: [{
      id: options.episodeId ?? 11,
      seasonNumber: 1,
      episodeNumber: options.episodeNumber ?? 1,
      title: null,
      hasFile: options.hasFile ?? false,
      episodeFileId: options.episodeFileId ?? null,
    }],
  };
}

describe('import plan row edit', () => {
  let sonarr: FakeArr;

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

  async function build(instanceId: string): Promise<ImportPlan> {
    const result = await buildImportPlan({ instanceId, queueRecordId: 1, downloadId: 'HASH1', title: 'Reacher' });
    if (!result.ok) throw new Error(`build refused: ${result.error.kind} — ${result.error.reason}`);
    return result.plan;
  }

  /** Builds a 3-row plan: ep1 and ep3 fresh (included by default), ep2 a replacement (excluded by default). */
  async function buildThreeRowPlan(): Promise<ImportPlan> {
    const instanceId = registerSonarr();
    sonarr.setImportCandidates([
      sonarrCandidate({ path: '/downloads/ep1.mkv', episodeId: 11, episodeNumber: 1 }),
      sonarrCandidate({ path: '/downloads/ep2.mkv', episodeId: 12, episodeNumber: 2, hasFile: true, episodeFileId: 99 }),
      sonarrCandidate({ path: '/downloads/ep3.mkv', episodeId: 13, episodeNumber: 3 }),
    ]);
    return build(instanceId);
  }

  /** Simulates a candidate the instance could not map — direct SQL, same as `import-plan.test.ts`'s expiry test. */
  function clearMapping(planId: string, ordinal: number): void {
    getDb().prepare(`
      UPDATE import_plan_row SET mapping_json = NULL, included = 0
       WHERE plan_id = ? AND ordinal = ?
    `).run(planId, ordinal);
  }

  function expirePlan(planId: string): void {
    getDb().prepare('UPDATE import_plan SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), planId);
  }

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    sonarr.hits.length = 0;
    sonarr.commands.length = 0;
    sonarr.setImportCandidates([]);
    sonarr.setImportHook(null);
    sonarr.setEpisodes([]);
    sonarr.setHistory([]);
    sonarr.setMode('ok');
    disposeAllBreakers();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    cleanupTestDir();
  });

  /* ── Single-row PATCH path is untouched ───────────────────────────────── */

  it('still toggles a single row by ordinal', async () => {
    const plan = await buildThreeRowPlan();
    const ep1 = plan.rows.find((row) => row.path === '/downloads/ep1.mkv')!;
    expect(ep1.included).toBe(true);

    const result = await editImportRow(plan.id, ep1.ordinal, { included: false });
    expect(result.ok).toBe(true);

    const after = getImportPlan(plan.id)!;
    expect(after.rows.find((row) => row.ordinal === ep1.ordinal)?.included).toBe(false);
  });

  /* ── Bulk: all-or-nothing on an unknown ordinal ───────────────────────── */

  it('writes nothing when one ordinal in a bulk edit does not exist', async () => {
    const plan = await buildThreeRowPlan();
    const before = getImportPlan(plan.id)!;
    const ordinals = before.rows.map((row) => row.ordinal);
    const unknown = Math.max(...ordinals) + 1;

    const result = editImportRows(plan.id, [...ordinals, unknown], true);
    expect(result).toEqual({ ok: false, error: 'row-not-found' });

    const after = getImportPlan(plan.id)!;
    expect(after.rows).toEqual(before.rows);
  });

  /* ── Bulk: no-target skips are named, mapped rows still included ─────── */

  it('skips an unmapped row and includes the rest in the same edit', async () => {
    const plan = await buildThreeRowPlan();
    const ep2 = plan.rows.find((row) => row.path === '/downloads/ep2.mkv')!;
    clearMapping(plan.id, ep2.ordinal);

    const before = getImportPlan(plan.id)!;
    const ordinals = before.rows.map((row) => row.ordinal);
    // Start from every row excluded, so the include below has a visible
    // effect on ep1 and ep3 rather than being a no-op on rows already
    // included by `defaultIncluded` (build.ts).
    editImportRows(plan.id, ordinals, false);

    const result = editImportRows(plan.id, ordinals, true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.skipped).toEqual([{ ordinal: ep2.ordinal, reason: 'no-target' }]);
    // ep1 and ep3 are mapped and were just excluded, so both flip; ep2 has no
    // mapping and is skipped rather than written.
    expect(result.changed).toBe(2);

    const after = getImportPlan(plan.id)!;
    expect(after.rows.find((row) => row.ordinal === ep2.ordinal)?.included).toBe(false);
    expect(after.rows.find((row) => row.path === '/downloads/ep1.mkv')?.included).toBe(true);
    expect(after.rows.find((row) => row.path === '/downloads/ep3.mkv')?.included).toBe(true);
    expect(includedCount(after)).toBe(2);
  });

  /* ── Bulk: exclude all ────────────────────────────────────────────────── */

  it('excludes every named row in one edit', async () => {
    const plan = await buildThreeRowPlan();
    const ordinals = plan.rows.map((row) => row.ordinal);

    const result = editImportRows(plan.id, ordinals, false);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.skipped).toEqual([]);
    // ep1 and ep3 start included and flip; ep2 starts excluded and does not count as changed.
    expect(result.changed).toBe(2);

    const after = getImportPlan(plan.id)!;
    expect(after.rows.every((row) => !row.included)).toBe(true);
    expect(includedCount(after)).toBe(0);
  });

  /* ── Bulk: expiry is checked inside the transaction ───────────────────── */

  it('refuses a bulk edit once expires_at has passed, even while phase is still ready', async () => {
    const plan = await buildThreeRowPlan();
    expirePlan(plan.id);

    const before = getDb().prepare(
      'SELECT ordinal, included FROM import_plan_row WHERE plan_id = ? ORDER BY ordinal',
    ).all(plan.id);

    const result = updateImportRows(plan.id, plan.rows.map((row) => row.ordinal), true);
    expect(result).toEqual({ ok: false, error: 'plan-not-ready' });

    const after = getDb().prepare(
      'SELECT ordinal, included FROM import_plan_row WHERE plan_id = ? ORDER BY ordinal',
    ).all(plan.id);
    expect(after).toEqual(before);

    // The row-level phase is still `ready` in storage — only `expires_at` is
    // what refused the edit; `getImportPlan`'s own lazy sweep would retire it
    // on the next read, which is a separate code path from this one.
    const phase = getDb().prepare('SELECT phase FROM import_plan WHERE id = ?').get(plan.id) as { phase: string };
    expect(phase.phase).toBe('ready');
  });

  /* ── Bulk never touches a mapping ─────────────────────────────────────── */

  it('leaves every mapping untouched by a bulk edit', async () => {
    const plan = await buildThreeRowPlan();
    const before = new Map(plan.rows.map((row) => [row.ordinal, row.mapping]));

    editImportRows(plan.id, plan.rows.map((row) => row.ordinal), true);
    editImportRows(plan.id, plan.rows.map((row) => row.ordinal), false);

    const after = getImportPlan(plan.id)!;
    for (const row of after.rows) {
      expect(row.mapping).toEqual(before.get(row.ordinal));
    }
  });

  /* ── Strict union: mixed body and duplicate ordinals are both invalid ─── */

  it('rejects a body mixing the single-row and bulk shapes', () => {
    const result = patchSchema.safeParse({ ordinal: 0, ordinals: [0, 1], included: true });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate ordinals in a bulk body', () => {
    const result = patchSchema.safeParse({ ordinals: [1, 1], included: true });
    expect(result.success).toBe(false);
  });

  it('still accepts a well-formed single-row body and a well-formed bulk body', () => {
    expect(patchSchema.safeParse({ ordinal: 0, included: true }).success).toBe(true);
    expect(patchSchema.safeParse({ ordinals: [0, 1, 2], included: true }).success).toBe(true);
  });
});
