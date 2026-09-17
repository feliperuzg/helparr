import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  type OperationFilter,
  type OperationOutcome,
  type OperationRead,
  type OperationsRead,
} from '@/lib/types';
import { getDb } from '@/server/db';

/**
 * The operation log (REQ-OPS-001..006, NFR3; ADR-6, ADR-7).
 *
 * Append-only is a property of this module's code, not a promise about it:
 * there is no `UPDATE` statement against `operation` anywhere below, and T24
 * asserts that by reading the file rather than by exercising behaviour. A row
 * is written exactly once, after the upstream has answered, and is never
 * revisited. `pending` is a client-side state that is never persisted.
 *
 * The one deletion helparr performs against this table is `purgeOperations`,
 * which the operator triggers explicitly and which takes everything — there is
 * no partial delete, so no row can be quietly dropped from the trail.
 *
 * What is deliberately absent: the download URL. `operation` has `url_sha256`
 * and `url_host` and no column to write a URL to, because the URL embeds
 * Prowlarr's own API key (ADR-7). The caller hashes; this module never sees the
 * plaintext.
 */

export interface OperationInput {
  /** `grab` today. `attach` and `rename` land here unchanged (ADR-10). */
  kind: string;
  summary: string;
  /**
   * Nullable and not a foreign key. Deleting an instance in Settings must not
   * rewrite what helparr did while it existed, and `ON DELETE CASCADE` would
   * let a Settings deletion silently erase history.
   */
  instanceId: string | null;
  instanceLabel: string;
  instanceKind: string;
  entityTitle: string;
  entityRef: string | null;
  indexer: string | null;
  urlSha256: string | null;
  urlHost: string | null;
  outcome: OperationOutcome;
  /** Splits "your quality profile said no" from "radarr returned 502". */
  rejected: boolean;
  detail: string[];
}

interface OperationRow {
  id: string;
  at: string;
  kind: string;
  summary: string;
  instance_id: string | null;
  instance_label: string;
  instance_kind: string;
  entity_title: string;
  entity_ref: string | null;
  indexer: string | null;
  url_sha256: string | null;
  url_host: string | null;
  outcome: OperationOutcome;
  rejected: number;
  detail: string | null;
}

/**
 * `detail` is stored as a JSON array so a multi-reason rejection survives
 * verbatim (REQ-OPS-002 / FR9). A joined string would make "Existing file meets
 * cutoff" and the reason after it indistinguishable from one long sentence.
 */
function parseDetail(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // A row written by an older shape is still a row. Showing its text beats
    // dropping the only explanation the operator has.
    return [raw];
  }
}

function toRead(row: OperationRow): OperationRead {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind,
    summary: row.summary,
    instanceLabel: row.instance_label,
    instanceKind: row.instance_kind,
    entityTitle: row.entity_title,
    entityRef: row.entity_ref,
    indexer: row.indexer,
    urlSha256: row.url_sha256,
    urlHost: row.url_host,
    outcome: row.outcome,
    rejected: row.rejected === 1,
    detail: parseDetail(row.detail),
  };
}

/**
 * The only INSERT. Called once per attempt, from the response — including when
 * the response is a rejection or a transport error (ADR-6).
 */
export function recordOperation(input: OperationInput): OperationRead {
  const id = randomUUID();
  const at = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO operation
      (id, at, kind, summary, instance_id, instance_label, instance_kind,
       entity_title, entity_ref, indexer, url_sha256, url_host,
       outcome, rejected, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    at,
    input.kind,
    input.summary,
    input.instanceId,
    input.instanceLabel,
    input.instanceKind,
    input.entityTitle,
    input.entityRef,
    input.indexer,
    input.urlSha256,
    input.urlHost,
    input.outcome,
    input.rejected ? 1 : 0,
    JSON.stringify(input.detail),
  );

  return {
    id,
    at,
    kind: input.kind,
    summary: input.summary,
    instanceLabel: input.instanceLabel,
    instanceKind: input.instanceKind,
    entityTitle: input.entityTitle,
    entityRef: input.entityRef,
    indexer: input.indexer,
    urlSha256: input.urlSha256,
    urlHost: input.urlHost,
    outcome: input.outcome,
    rejected: input.rejected,
    detail: input.detail,
  };
}

/* ── Rename file outcomes (bulk-rename-preview, T7) ───────────────────────── */

/**
 * One file's result within a rename run (REQ-OPS-001's rename extension,
 * NFR7). `operation.detail` is a flat `string[]` — enough for a grab's handful
 * of rejection reasons, not for "reconstruct which files were renamed from what
 * to what" across a plan, and overloading it with structured JSON would make
 * `parseDetail`'s fallback path ambiguous.
 */
export interface RenameFileOutcomeInput {
  planRowId: string;
  existingPath: string;
  proposedPath: string;
  outcome: 'succeeded' | 'failed' | 'skipped';
  detail: string | null;
}

/**
 * Writes the parent operation and every file outcome in one transaction.
 *
 * Deliberately *not* a pending-then-finalize pair. The append-only rule above
 * is a property of this file's code — there is no `UPDATE` against `operation`
 * anywhere in it — and an in-flight rename does not need the log to hold its
 * state, because `rename_plan` already does. So the log row is written once,
 * when every outcome is known, exactly like a grab's.
 *
 * `outcome` is `'succeeded'` only when every file succeeded. A partial run is
 * recorded `'failed'` with the per-file truth in the child rows, because
 * REQ-RENAME-016 forbids presenting a partial run as a complete one.
 */
export function recordRenameOperation(
  input: OperationInput,
  files: RenameFileOutcomeInput[],
): OperationRead {
  const db = getDb();
  const insertFile = db.prepare(`
    INSERT INTO rename_file_outcome
      (id, operation_id, plan_row_id, existing_path, proposed_path, outcome, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return db.transaction(() => {
    const operation = recordOperation(input);
    for (const file of files) {
      insertFile.run(
        randomUUID(),
        operation.id,
        file.planRowId,
        // Copied rather than joined: REQ-OPS-001 requires the log to survive
        // the plan being purged, and plans are ephemeral working state.
        file.existingPath,
        file.proposedPath,
        file.outcome,
        file.detail,
      );
    }
    return operation;
  })();
}

export function listRenameFileOutcomes(operationId: string): RenameFileOutcomeInput[] {
  return (getDb().prepare(`
    SELECT plan_row_id, existing_path, proposed_path, outcome, detail
      FROM rename_file_outcome WHERE operation_id = ? ORDER BY rowid
  `).all(operationId) as Array<{
    plan_row_id: string;
    existing_path: string;
    proposed_path: string;
    outcome: 'succeeded' | 'failed' | 'skipped';
    detail: string | null;
  }>).map((row) => ({
    planRowId: row.plan_row_id,
    existingPath: row.existing_path,
    proposedPath: row.proposed_path,
    outcome: row.outcome,
    detail: row.detail,
  }));
}

/**
 * `rejected` is a split of `failed`, not a third outcome — the table has two
 * outcome values because REQ-OPS-001 requires a rejected grab to be recorded as
 * "failed" verbatim. The viewer's four chips are derived here so the SQL and
 * the counts can never disagree about what a bucket means.
 */
const WHERE_FOR: Record<OperationFilter, string> = {
  all: '1 = 1',
  succeeded: "outcome = 'succeeded'",
  rejected: "outcome = 'failed' AND rejected = 1",
  failed: "outcome = 'failed' AND rejected = 0",
};

export function listOperations(filter: OperationFilter = 'all'): OperationsRead {
  const db = getDb();

  const rows = db.prepare(`
    SELECT * FROM operation
     WHERE ${WHERE_FOR[filter]}
     ORDER BY at DESC
  `).all() as OperationRow[];

  // Counted across the whole table, never across the filtered set: the chips
  // have to keep reading "Failed 3" while the operator is looking at the three
  // failures, otherwise the filter erases the evidence it was opened to find.
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                                      AS all_count,
      SUM(CASE WHEN outcome = 'succeeded'              THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN outcome = 'failed' AND rejected = 1 THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN outcome = 'failed' AND rejected = 0 THEN 1 ELSE 0 END) AS failed,
      MIN(at)                                                       AS oldest_at
    FROM operation
  `).get() as {
    all_count: number;
    succeeded: number | null;
    rejected: number | null;
    failed: number | null;
    oldest_at: string | null;
  };

  return {
    operations: rows.map(toRead),
    counts: {
      all: totals.all_count,
      succeeded: totals.succeeded ?? 0,
      rejected: totals.rejected ?? 0,
      failed: totals.failed ?? 0,
    },
    // Drives the "oldest 2026-09-14 · retention unlimited" footer. Nothing
    // prunes this table on a timer (settled in proposal OQ-5), so the operator
    // is the only thing that shortens it.
    oldestAt: totals.oldest_at,
  };
}

/**
 * Just the total, for the purge route's confirmation check — which needs a
 * number, not every row in the table.
 */
export function countOperations(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total FROM operation')
    .get() as { total: number };
  return row.total;
}

/**
 * Everything, or nothing. The confirmation dialog states the row count and the
 * failure count before this runs, because a log the operator cannot trust to be
 * complete is not a log.
 */
export function purgeOperations(): number {
  return getDb().prepare('DELETE FROM operation').run().changes;
}
