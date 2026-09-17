import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  RENAME_WARNINGS,
  type InstanceKind,
  type RenameOutcome,
  type RenamePlanDto,
  type RenamePlanPhase,
  type RenamePlanRow,
  type RenameRefusal,
  type RenameScopeEntry,
  type RenameTitleKind,
  type RenameTitleStatus,
  type RenameWarning,
} from '@/lib/types';
import { getDb } from '@/server/db';

/**
 * Persistence for rename plans (FR2, FR11, REQ-RENAME-013/014).
 *
 * This module is the whole of NFR1's enforcement surface. The apply request
 * carries a plan id and a typed count and nothing else, so the file list a
 * command is built from can only come from `rename_plan_row` — read back here,
 * server-side, from what the build wrote. There is no function below that
 * accepts a caller-supplied path or file id, which is why there is no bypass
 * to audit for: the widening move is not expressible.
 *
 * Expiry is likewise a property of the code rather than a promise about it.
 * `expires_at` is computed once at build time and nothing below writes it
 * again — `extendPlan` does not exist.
 */

/** FR11 / REQ-RENAME-014. Five minutes, computed once, never extended. */
export const RENAME_PLAN_TTL_MS = 5 * 60 * 1000;

interface PlanRecord {
  id: string;
  phase: RenamePlanPhase;
  scope_json: string;
  title_json: string;
  total_titles: number;
  total_files: number;
  built_at: string | null;
  expires_at: string | null;
  applied_at: string | null;
  refusal_json: string | null;
}

interface RowRecord {
  id: string;
  instance_id: string | null;
  instance_label: string;
  instance_kind: InstanceKind;
  title_kind: RenameTitleKind;
  title_upstream_id: number;
  title_label: string;
  file_id: number;
  existing_path: string;
  proposed_path: string;
  warnings_json: string;
  excluded: number;
  outcome: RenameOutcome;
  outcome_detail: string | null;
}

/** What `buildPlan()` hands over once every title has been previewed. */
export interface PlanContent {
  titles: RenameTitleStatus[];
  rows: Array<Omit<RenamePlanRow, 'id' | 'excluded' | 'outcome' | 'outcomeDetail'>>;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Unknown codes are dropped rather than passed through. Every value here was
 * derived by helparr (ADR-9); a code this build does not recognise came from a
 * shape this build cannot explain, and an unexplained badge is worse than none.
 */
function parseWarnings(raw: string): RenameWarning[] {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is RenameWarning =>
    typeof x === 'string' && (RENAME_WARNINGS as readonly string[]).includes(x));
}

function toRow(record: RowRecord): RenamePlanRow {
  return {
    id: record.id,
    instanceId: record.instance_id,
    instanceLabel: record.instance_label,
    instanceKind: record.instance_kind,
    titleKind: record.title_kind,
    titleUpstreamId: record.title_upstream_id,
    titleLabel: record.title_label,
    fileId: record.file_id,
    existingPath: record.existing_path,
    proposedPath: record.proposed_path,
    warnings: parseWarnings(record.warnings_json),
    excluded: record.excluded === 1,
    outcome: record.outcome,
    outcomeDetail: record.outcome_detail,
  };
}

/* ── Writes ───────────────────────────────────────────────────────────────── */

/** Opens a plan in `building`. The scope is stored before any upstream call. */
export function createPlan(scope: RenameScopeEntry[]): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO rename_plan (id, phase, scope_json, title_json, created_at)
    VALUES (?, 'building', ?, '[]', ?)
  `).run(id, JSON.stringify(scope), new Date().toISOString());
  return id;
}

export function readScope(planId: string): RenameScopeEntry[] {
  const record = getDb()
    .prepare('SELECT scope_json FROM rename_plan WHERE id = ?')
    .get(planId) as { scope_json: string } | undefined;
  return record ? parseJson<RenameScopeEntry[]>(record.scope_json, []) : [];
}

/**
 * Publishes per-title progress while the plan is still `building` (ADR-5).
 *
 * Titles only — no rows. Rows are written once, in `finalizePlan`, because the
 * plan-wide collision warning cannot be derived until every title has landed,
 * and a row persisted without its warnings is a row that could be read without
 * them.
 */
export function updateBuildProgress(planId: string, titles: RenameTitleStatus[]): void {
  getDb().prepare(`
    UPDATE rename_plan SET title_json = ?, total_titles = ? WHERE id = ? AND phase = 'building'
  `).run(JSON.stringify(titles), titles.length, planId);
}

/** The build could not produce a plan at all — every instance was unreachable. */
export function abandonBuild(planId: string, refusal: RenameRefusal): void {
  getDb().prepare(`
    UPDATE rename_plan SET phase = 'refused', refusal_json = ? WHERE id = ? AND phase = 'building'
  `).run(JSON.stringify(refusal), planId);
}

/**
 * Seals the build: rows, per-title outcomes, totals, and the validity window,
 * in one transaction. `built_at` and `expires_at` are set here and nowhere
 * else, so the five minutes start when the operator can first *see* the plan.
 */
export function finalizePlan(planId: string, content: PlanContent): void {
  const db = getDb();
  const now = new Date();
  const builtAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + RENAME_PLAN_TTL_MS).toISOString();

  const insertRow = db.prepare(`
    INSERT INTO rename_plan_row (
      id, plan_id, instance_id, instance_label, instance_kind,
      title_kind, title_upstream_id, title_label,
      file_id, existing_path, proposed_path, warnings_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const row of content.rows) {
      insertRow.run(
        randomUUID(), planId,
        row.instanceId, row.instanceLabel, row.instanceKind,
        row.titleKind, row.titleUpstreamId, row.titleLabel,
        row.fileId, row.existingPath, row.proposedPath,
        JSON.stringify(row.warnings),
      );
    }
    db.prepare(`
      UPDATE rename_plan
         SET phase = 'ready', title_json = ?, total_titles = ?, total_files = ?,
             built_at = ?, expires_at = ?
       WHERE id = ?
    `).run(
      JSON.stringify(content.titles),
      content.titles.length,
      content.rows.length,
      builtAt, expiresAt, planId,
    );
  })();
}

/** FR7. Exclusions are only settable while the plan is still `ready`. */
export function setExcluded(planId: string, rowIds: string[], excluded: boolean): number {
  if (rowIds.length === 0) return 0;
  const db = getDb();
  const placeholders = rowIds.map(() => '?').join(',');
  const result = db.prepare(`
    UPDATE rename_plan_row
       SET excluded = ?
     WHERE plan_id = ?
       AND id IN (${placeholders})
       AND plan_id IN (SELECT id FROM rename_plan WHERE phase = 'ready')
  `).run(excluded ? 1 : 0, planId, ...rowIds);
  return result.changes;
}

/**
 * Moves the plan into `applying` and stamps `applied_at` — the first moment a
 * row is allowed to carry a non-`pending` outcome.
 *
 * Guarded on the current phase inside the UPDATE rather than by a read-then-
 * write, so two concurrent applies of the same plan cannot both proceed: the
 * second one changes zero rows and gets `false` back.
 */
export function beginApply(planId: string, typedConfirmation: string): boolean {
  const result = getDb().prepare(`
    UPDATE rename_plan
       SET phase = 'applying', applied_at = ?, typed_confirmation = ?
     WHERE id = ? AND phase = 'ready'
  `).run(new Date().toISOString(), typedConfirmation, planId);
  return result.changes === 1;
}

export function finishApply(planId: string): void {
  getDb().prepare("UPDATE rename_plan SET phase = 'done' WHERE id = ?").run(planId);
}

/**
 * Refuses the whole plan (REQ-RENAME-013). Whole, not partial: a drift in one
 * row means the preview the operator approved no longer describes the library,
 * and applying "the rest of it" would apply something nobody read.
 */
export function refusePlan(planId: string, refusal: RenameRefusal): void {
  getDb().prepare(`
    UPDATE rename_plan SET phase = 'refused', refusal_json = ? WHERE id = ?
  `).run(JSON.stringify(refusal), planId);
}

export function recordOutcome(
  rowId: string,
  outcome: RenameOutcome,
  detail: string | null,
): void {
  getDb().prepare(`
    UPDATE rename_plan_row SET outcome = ?, outcome_detail = ? WHERE id = ?
  `).run(outcome, detail, rowId);
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * Lazily retires a plan whose window has closed.
 *
 * Done on read rather than by a timer because the only thing that matters is
 * that nothing can be *applied* past the window — and every apply starts with a
 * read. A background sweep would add a second place for the deadline to be
 * interpreted, which is one more than the deadline can afford.
 */
function expireIfDue(record: PlanRecord): PlanRecord {
  if (record.phase !== 'ready' || !record.expires_at) return record;
  if (Date.parse(record.expires_at) > Date.now()) return record;

  getDb().prepare("UPDATE rename_plan SET phase = 'expired' WHERE id = ? AND phase = 'ready'")
    .run(record.id);
  return { ...record, phase: 'expired' };
}

export function getPlan(planId: string): RenamePlanDto | null {
  const db = getDb();
  const found = db.prepare('SELECT * FROM rename_plan WHERE id = ?').get(planId) as
    PlanRecord | undefined;
  if (!found) return null;

  const record = expireIfDue(found);

  // Insertion order is scope order, which is the order the operator picked the
  // titles in. Stable ordering is what lets the virtualized grid address a row
  // by index without re-sorting five thousand rows on every render.
  const rows = (db.prepare(
    'SELECT * FROM rename_plan_row WHERE plan_id = ? ORDER BY rowid',
  ).all(planId) as RowRecord[]).map(toRow);

  return {
    id: record.id,
    phase: record.phase,
    titles: parseJson<RenameTitleStatus[]>(record.title_json, []),
    rows,
    totalFiles: record.total_files,
    totalTitles: record.total_titles,
    // What the typed-count gate is checked against (REQ-RENAME-010) — the
    // files that would actually move, not every row the preview produced.
    affectedFiles: rows.filter((row) => !row.excluded).length,
    builtAt: record.built_at,
    expiresAt: record.expires_at,
    appliedAt: record.applied_at,
    refusal: parseJson<RenameRefusal | null>(record.refusal_json, null),
  };
}

/** The rows an apply is allowed to touch. Nothing else may produce this list. */
export function readApplicableRows(planId: string): RenamePlanRow[] {
  return (getDb().prepare(
    'SELECT * FROM rename_plan_row WHERE plan_id = ? AND excluded = 0 ORDER BY rowid',
  ).all(planId) as RowRecord[]).map(toRow);
}

/**
 * Drops plans whose window closed a while ago. Plans are ephemeral working
 * state, not history — the operation log is what REQ-OPS-001 preserves, and it
 * copies the paths it needs so this deletion can never orphan it.
 */
export function purgeStalePlans(olderThanMs = 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return getDb().prepare(
    "DELETE FROM rename_plan WHERE expires_at IS NOT NULL AND expires_at < ? AND phase <> 'applying'",
  ).run(cutoff).changes;
}
