import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  IMPORT_PLAN_TTL_MS,
  type ImportBulkSkip,
  type ImportMapping,
  type ImportPlan,
  type ImportPlanPhase,
  type ImportPlanRow,
  type ImportRefusal,
  type ImportReplacement,
  type ImportRowOutcome,
  type MappingSource,
} from '@/lib/importPlan';
import { getDb } from '@/server/db';

/**
 * Persistence for force-import plans (ADR-3, ADR-4, ADR-5, ADR-7, ADR-8).
 *
 * This module mirrors `rename/store.ts` deliberately: the apply path (T8)
 * must be able to load "the files this plan is allowed to touch" from one
 * place, read back after this module wrote it, with no caller-supplied path
 * or candidate list able to widen that set. There is no function below that
 * accepts anything but a plan id, an ordinal and a patch — same discipline
 * NFR1 states for rename, now REQ-QUEUE-022's for force import.
 *
 * Expiry is a property of the code, not a promise: `expires_at` is computed
 * once in `createImportPlan` and nothing here writes it again.
 */

interface PlanRecord {
  id: string;
  instance_id: string | null;
  instance_kind: 'sonarr' | 'radarr';
  instance_label: string;
  download_id: string;
  queue_record_id: number;
  title: string;
  phase: ImportPlanPhase;
  refusal_json: string | null;
  created_at: string;
  expires_at: string;
}

interface RowRecord {
  plan_id: string;
  ordinal: number;
  path: string;
  relative_path: string | null;
  size: number;
  quality_json: string;
  languages_json: string;
  release_group: string | null;
  indexer_flags: number;
  release_type: string | null;
  custom_formats_json: string;
  custom_format_score: number | null;
  mapping_json: string | null;
  mapping_source: MappingSource;
  rejections_json: string;
  replaces_existing_json: string | null;
  included: number;
  outcome: 'succeeded' | 'failed' | 'unverified' | null;
  outcome_destination: string | null;
  outcome_error: string | null;
}

/** What `buildImportPlan()` (T7) hands over to open a plan. */
export interface ImportPlanInput {
  instanceId: string;
  instanceKind: 'sonarr' | 'radarr';
  instanceLabel: string;
  downloadId: string;
  queueRecordId: number;
  title: string;
  rows: Array<Omit<ImportPlanRow, 'outcome'>>;
}

/** Why `updateImportRow` declined an edit. Typed, never thrown. */
export type ImportRowUpdateError = 'plan-not-ready' | 'row-not-found' | 'missing-mapping';
export type ImportRowUpdateResult = { ok: true } | { ok: false; error: ImportRowUpdateError };

/** Why `updateImportRows` declined a bulk edit. Narrower than the single-row set (ADR-6): a bulk edit never fails on a missing mapping — it skips instead. */
export type ImportRowsUpdateError = 'plan-not-ready' | 'row-not-found';
export type ImportRowsUpdateResult =
  | { ok: true; changed: number; skipped: ImportBulkSkip[] }
  | { ok: false; error: ImportRowsUpdateError };

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRow(record: RowRecord): ImportPlanRow {
  const outcome: ImportRowOutcome | null = record.outcome === null
    ? null
    : { outcome: record.outcome, destination: record.outcome_destination, error: record.outcome_error };

  return {
    ordinal: record.ordinal,
    path: record.path,
    relativePath: record.relative_path,
    size: record.size,
    quality: parseJson(record.quality_json, { name: null, model: null }),
    languages: parseJson(record.languages_json, []),
    releaseGroup: record.release_group,
    indexerFlags: record.indexer_flags,
    releaseType: record.release_type,
    customFormats: parseJson(record.custom_formats_json, []),
    customFormatScore: record.custom_format_score,
    mapping: parseJson<ImportMapping | null>(record.mapping_json, null),
    mappingSource: record.mapping_source,
    rejections: parseJson(record.rejections_json, []),
    replacesExisting: parseJson<ImportReplacement | null>(record.replaces_existing_json, null),
    included: record.included === 1,
    outcome,
  };
}

function toPlan(record: PlanRecord, rows: ImportPlanRow[]): ImportPlan {
  return {
    id: record.id,
    // The column is a soft reference and nullable (data-model.md), surviving
    // the instance being deleted in Settings; `instanceLabel` is what stays
    // true to show in that case, so the id's own emptiness is harmless here.
    instanceId: record.instance_id ?? '',
    instanceKind: record.instance_kind,
    instanceLabel: record.instance_label,
    downloadId: record.download_id,
    queueRecordId: record.queue_record_id,
    title: record.title,
    phase: record.phase,
    refusal: parseJson<ImportRefusal | null>(record.refusal_json, null),
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    rows,
  };
}

/* ── Writes ───────────────────────────────────────────────────────────────── */

/**
 * Opens a plan directly in `ready`, rows included, in one transaction.
 *
 * Unlike rename there is no `building` phase to seal later (state-import-plan
 * .md): `manualimport` is a single synchronous read, so the plan is complete
 * the moment it exists. `created_at`/`expires_at` are stamped here and
 * nowhere else, so the five minutes start when the operator can first see it.
 */
export function createImportPlan(input: ImportPlanInput): ImportPlan {
  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + IMPORT_PLAN_TTL_MS).toISOString();

  const insertRow = db.prepare(`
    INSERT INTO import_plan_row (
      plan_id, ordinal, path, relative_path, size,
      quality_json, languages_json, release_group, indexer_flags, release_type,
      custom_formats_json, custom_format_score,
      mapping_json, mapping_source, rejections_json, replaces_existing_json, included
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rows = db.transaction((): ImportPlanRow[] => {
    db.prepare(`
      INSERT INTO import_plan (
        id, instance_id, instance_kind, instance_label,
        download_id, queue_record_id, title, phase, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
    `).run(
      id, input.instanceId, input.instanceKind, input.instanceLabel,
      input.downloadId, input.queueRecordId, input.title, createdAt, expiresAt,
    );

    for (const row of input.rows) {
      insertRow.run(
        id, row.ordinal, row.path, row.relativePath, row.size,
        JSON.stringify(row.quality), JSON.stringify(row.languages),
        row.releaseGroup, row.indexerFlags, row.releaseType,
        JSON.stringify(row.customFormats), row.customFormatScore,
        row.mapping ? JSON.stringify(row.mapping) : null, row.mappingSource,
        JSON.stringify(row.rejections),
        row.replacesExisting ? JSON.stringify(row.replacesExisting) : null,
        row.included ? 1 : 0,
      );
    }

    return input.rows.map((row) => ({ ...row, outcome: null }));
  })();

  return {
    id,
    instanceId: input.instanceId,
    instanceKind: input.instanceKind,
    instanceLabel: input.instanceLabel,
    downloadId: input.downloadId,
    queueRecordId: input.queueRecordId,
    title: input.title,
    phase: 'ready',
    refusal: null,
    createdAt,
    expiresAt,
    rows,
  };
}

/**
 * Row edits only while `ready` (state-import-plan.md): once `applying` has
 * started, the included set and every mapping are exactly what `beginImport
 * Apply` locked in. `mapping` is write-only here — there is no way to clear a
 * mapping back to null, only to replace it, because a row the instance could
 * not map starts excluded with "no target" and the only forward path for it
 * is the operator supplying one (ADR-4).
 */
export function updateImportRow(
  planId: string,
  ordinal: number,
  patch: { included?: boolean; mapping?: ImportMapping },
): ImportRowUpdateResult {
  if (patch.included === undefined && patch.mapping === undefined) return { ok: true };

  const db = getDb();
  return db.transaction((): ImportRowUpdateResult => {
    const plan = db.prepare('SELECT phase FROM import_plan WHERE id = ?').get(planId) as
      { phase: ImportPlanPhase } | undefined;
    if (!plan || plan.phase !== 'ready') return { ok: false, error: 'plan-not-ready' };

    const row = db.prepare(
      'SELECT mapping_json, included FROM import_plan_row WHERE plan_id = ? AND ordinal = ?',
    ).get(planId, ordinal) as { mapping_json: string | null; included: number } | undefined;
    if (!row) return { ok: false, error: 'row-not-found' };

    const nextMapping = patch.mapping ?? parseJson<ImportMapping | null>(row.mapping_json, null);
    const nextIncluded = patch.included ?? row.included === 1;

    // A row the instance could not map, and the operator has not mapped
    // either, cannot be included (ADR-4) — refused here rather than silently
    // clamped, so the caller can say why the toggle did not take.
    if (nextIncluded && nextMapping === null) return { ok: false, error: 'missing-mapping' };

    if (patch.mapping !== undefined) {
      db.prepare(`
        UPDATE import_plan_row
           SET mapping_json = ?, mapping_source = 'operator', included = ?
         WHERE plan_id = ? AND ordinal = ?
      `).run(JSON.stringify(patch.mapping), nextIncluded ? 1 : 0, planId, ordinal);
    } else {
      db.prepare(`
        UPDATE import_plan_row SET included = ? WHERE plan_id = ? AND ordinal = ?
      `).run(nextIncluded ? 1 : 0, planId, ordinal);
    }

    return { ok: true };
  })();
}

/**
 * Sets inclusion on many rows in one transaction (ADR-6, REQ-QUEUE-025) —
 * "Include all" / "Exclude all" / "Include all replacements" and range
 * inclusion all land here, differing only in which ordinals are gathered
 * before the call. Never touches `mapping` or `mapping_source`.
 *
 * All-or-nothing on the request itself: the phase/expiry check and the
 * existence check both happen before any row is written, so an unready plan
 * or an unknown ordinal leaves every row exactly as it was. Past that gate,
 * a row that cannot be included (no mapping) is not an error — it is skipped
 * and named in the result, so "Include all" on a plan with one unmapped row
 * still includes the other nine.
 *
 * The expiry check is explicit here rather than left to the lazy sweep in
 * `getImportPlan`: that sweep only runs on a read, so a bulk edit arriving
 * after `expires_at` but before any poll re-reads the plan would otherwise
 * write through a plan that should already be `expired` (ADR-6's "closes the
 * lazy-TTL gap").
 */
export function updateImportRows(
  planId: string,
  ordinals: number[],
  included: boolean,
): ImportRowsUpdateResult {
  const db = getDb();
  return db.transaction((): ImportRowsUpdateResult => {
    const plan = db.prepare('SELECT phase, expires_at FROM import_plan WHERE id = ?').get(planId) as
      { phase: ImportPlanPhase; expires_at: string } | undefined;
    if (!plan || plan.phase !== 'ready' || Date.parse(plan.expires_at) <= Date.now()) {
      return { ok: false, error: 'plan-not-ready' };
    }

    const placeholders = ordinals.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT ordinal, mapping_json, included FROM import_plan_row WHERE plan_id = ? AND ordinal IN (${placeholders})`,
    ).all(planId, ...ordinals) as { ordinal: number; mapping_json: string | null; included: number }[];

    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
    for (const ordinal of ordinals) {
      if (!byOrdinal.has(ordinal)) return { ok: false, error: 'row-not-found' };
    }

    const update = db.prepare(
      'UPDATE import_plan_row SET included = ? WHERE plan_id = ? AND ordinal = ?',
    );
    const skipped: ImportBulkSkip[] = [];
    let changed = 0;

    for (const ordinal of ordinals) {
      const row = byOrdinal.get(ordinal)!;
      const hasMapping = row.mapping_json !== null;
      const alreadyIncluded = row.included === 1;

      if (included && !hasMapping) {
        skipped.push({ ordinal, reason: 'no-target' });
        continue;
      }
      if (alreadyIncluded === included) continue;

      update.run(included ? 1 : 0, planId, ordinal);
      changed += 1;
    }

    return { ok: true, changed, skipped };
  })();
}

/**
 * Moves the plan into `applying`, atomically.
 *
 * Guarded on the current phase inside the UPDATE rather than by a read-then-
 * write, so two concurrent applies of the same plan cannot both proceed
 * (R3) — the second one changes zero rows and gets `false` back, same
 * pattern as `rename/store.ts`'s `beginApply`.
 */
export function beginImportApply(planId: string): boolean {
  const result = getDb().prepare(`
    UPDATE import_plan SET phase = 'applying' WHERE id = ? AND phase = 'ready'
  `).run(planId);
  return result.changes === 1;
}

/**
 * Writes one row's terminal outcome. Called progressively as `verify.ts`
 * resolves each included row against history, so the review screen can show
 * outcomes landing one at a time rather than only once the whole plan is
 * `done` (state-import-plan.md).
 */
export function recordImportRowOutcome(
  planId: string,
  ordinal: number,
  outcome: ImportRowOutcome,
): void {
  getDb().prepare(`
    UPDATE import_plan_row
       SET outcome = ?, outcome_destination = ?, outcome_error = ?
     WHERE plan_id = ? AND ordinal = ?
  `).run(outcome.outcome, outcome.destination, outcome.error, planId, ordinal);
}

/** Every included row has a terminal outcome (state-import-plan.md's `Applying -> Done`). */
export function finishImportPlan(planId: string): void {
  getDb().prepare("UPDATE import_plan SET phase = 'done' WHERE id = ?").run(planId);
}

/**
 * Refuses the whole plan (ADR-5). Whole, not partial — identical reasoning to
 * `rename/store.ts`'s `refusePlan`: a drift in one row means the preview the
 * operator approved no longer describes the download, and there is no
 * force/override column to bypass it with.
 */
export function refuseImportPlan(planId: string, refusal: ImportRefusal): void {
  getDb().prepare(`
    UPDATE import_plan SET phase = 'refused', refusal_json = ? WHERE id = ?
  `).run(JSON.stringify(refusal), planId);
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * Lazily retires a plan whose window has closed, same reasoning as rename's
 * `expireIfDue`: done on read because every apply starts with a read, so a
 * background sweep would only add a second place for the deadline to be
 * interpreted.
 */
function expireIfDue(record: PlanRecord): PlanRecord {
  if (record.phase !== 'ready') return record;
  if (Date.parse(record.expires_at) > Date.now()) return record;

  getDb().prepare("UPDATE import_plan SET phase = 'expired' WHERE id = ? AND phase = 'ready'")
    .run(record.id);
  return { ...record, phase: 'expired' };
}

export function getImportPlan(planId: string): ImportPlan | null {
  const db = getDb();
  const found = db.prepare('SELECT * FROM import_plan WHERE id = ?').get(planId) as
    PlanRecord | undefined;
  if (!found) return null;

  const record = expireIfDue(found);

  const rows = (db.prepare(
    'SELECT * FROM import_plan_row WHERE plan_id = ? ORDER BY ordinal',
  ).all(planId) as RowRecord[]).map(toRow);

  return toPlan(record, rows);
}
