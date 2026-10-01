import 'server-only';

import type {
  ImportPlan,
  ImportPlanRow,
  ImportRefusal,
  ImportRefusalReason,
  ImportRowOutcome,
} from '@/lib/importPlan';
import {
  type ArrQualityModel,
  type ImportClient,
  type ManualImportFile,
  isImportClient,
} from '@/server/clients/types';
import { awaitCommand } from '@/server/commands/await';
import { invalidateDecisionsConfig } from '@/server/decisions/configCache';
import { invalidateLibrary } from '@/server/gaps/seriesCache';
import { clientFor } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { recordImportOperation, type ImportFileOutcomeInput } from '@/server/operations/log';
import { importWriteEnabled } from './kinds';
import { diffImportRows, resolveImportRows } from './resolve';
import {
  beginImportApply,
  finishImportPlan,
  getImportPlan,
  recordImportRowOutcome,
  refuseImportPlan,
} from './store';
import { verifyImport } from './verify';

/**
 * Applying a force-import plan (ADR-5, ADR-6, ADR-7; REQ-QUEUE-021/022,
 * REQ-OPS-001/007).
 *
 * `startImport` takes a plan id and a number, same discipline as rename's
 * `startApply`: there is no parameter here a caller could use to name a file
 * or a mapping, because every file and every mapping was persisted at build
 * or edit time (T7) by this process. The only write in this whole module is
 * one `ManualImport` command, issued once, never retried.
 *
 * Every refusal before `beginImportApply` leaves the plan exactly as it was
 * and writes nothing to the operation log (ADR-7, REQ-OPS-001's "a refused
 * force import is not recorded as a write") — a count typo should be
 * retypable, not a dead end requiring a fresh preview.
 */

export type ImportStartError =
  // The plan id does not resolve to anything — never persisted, because there
  // is nothing to persist against.
  | { kind: 'not-found'; reason: string }
  | { kind: 'refused'; refusal: ImportRefusal };

export type ImportStart =
  | { ok: true; rowCount: number }
  | { ok: false; error: ImportStartError };

const inFlight = new Set<string>();

function refused(reason: ImportRefusalReason, changeLine: string): ImportStart {
  return { ok: false, error: { kind: 'refused', refusal: { reason, changes: [changeLine] } } };
}

/**
 * Validates, refuses, or dispatches. Returns as soon as the command is
 * accepted — per-file outcomes resolve behind the poll, because the
 * read-back in `verify.ts` takes a `commands/await.ts` round trip plus two
 * more reads, and nothing may be reported as imported until that evidence
 * exists (ADR-7).
 */
export async function startImport(planId: string, typedCount: number): Promise<ImportStart> {
  const plan = getImportPlan(planId);
  if (!plan) {
    return { ok: false, error: { kind: 'not-found', reason: 'That plan no longer exists.' } };
  }

  // `getImportPlan` retires an over-age plan on read, same clock the
  // operator's screen reads.
  if (plan.phase === 'expired') {
    return refused('expired', 'This preview is more than five minutes old. Regenerate it.');
  }
  if (plan.phase !== 'ready') {
    return refused('not-ready', `This plan is ${plan.phase}, not ready to apply.`);
  }

  if (!importWriteEnabled(plan.instanceKind)) {
    return refused(
      'write-disabled',
      `${plan.instanceLabel} is a ${plan.instanceKind} — force import is disabled for it until its ManualImport payload is verified (ADR-6).`,
    );
  }

  const included = plan.rows.filter((row) => row.included);
  if (included.length === 0) {
    return refused('empty', 'Every row in this plan is excluded.');
  }

  // Defense in depth, same reasoning as rename's: the dialog already gates
  // this, but the dialog is the browser's opinion and this is the server's.
  // Not persisted — a mistyped count should be retypable without forcing a
  // fresh preview.
  if (typedCount !== included.length) {
    return refused(
      'count-mismatch',
      `The confirmation was for ${typedCount} files; this plan affects ${included.length}.`,
    );
  }

  const resolved = clientFor(plan.instanceId);
  if (!resolved || !isImportClient(resolved.client)) {
    // Reported, not persisted: this is a transient reachability problem, not
    // a confirmed change to the candidate set, so there is nothing here for
    // `refuseImportPlan` to record and the plan stays `ready` for a retry.
    return refused('drift', `Could not re-read the candidate set: ${plan.instanceLabel} is no longer reachable.`);
  }
  const client: ImportClient = resolved.client;

  // ADR-5: re-run the same resolution the build and every prior drift check
  // ran, against the same `downloadId`, and compare the *whole* stored row
  // set — not just the included rows — against it, so a candidate appearing
  // or disappearing anywhere is caught even if the operator never ticked it.
  const fresh = await resolveImportRows(client, plan.downloadId);
  if (!fresh.ok) {
    return refused('drift', `Could not re-read the candidate set: ${fresh.error.reason}`);
  }
  if (fresh.value.length === 0) {
    // Empty is not "nothing changed" — it is the queue record having
    // vanished out from under this plan, named distinctly from an ordinary
    // drift (ADR-5).
    return refused('record-gone', 'The download no longer has any import candidates on the instance — the queue record may be gone.');
  }

  const changes = diffImportRows(plan.rows, fresh.value);
  if (changes.length > 0) {
    const refusal: ImportRefusal = { reason: 'drift', changes };
    // Whole, not partial, and persisted: the plan the operator read no
    // longer describes the download, and there is no force/override column
    // to bypass it with (ADR-5).
    refuseImportPlan(planId, refusal);
    return { ok: false, error: { kind: 'refused', refusal } };
  }

  if (!beginImportApply(planId)) {
    // Someone else moved this plan out of `ready` between the read above and
    // here — a second apply of the same plan. The loser does nothing.
    return refused('not-ready', 'This plan is already being applied.');
  }

  inFlight.add(planId);
  void runImport(planId, plan, included, client).finally(() => inFlight.delete(planId));
  return { ok: true, rowCount: included.length };
}

/**
 * One `ManualImportFile` per included row (OQ-5). `quality.model` is declared
 * `unknown` on `ImportPlanRow` only because it crosses a JSON column
 * (`store.ts`); at runtime it is exactly the `ArrQualityModel` `resolve.ts`
 * wrote there off the candidate, so it is cast here rather than re-derived —
 * the whole point of ADR-6's payload is that it is echoed back verbatim.
 */
function toManualImportFile(row: ImportPlanRow, downloadId: string): ManualImportFile {
  const quality = row.quality.model as ArrQualityModel | null;
  const shared = {
    path: row.path,
    quality,
    languages: row.languages,
    releaseGroup: row.releaseGroup,
    indexerFlags: row.indexerFlags,
    releaseType: row.releaseType,
    downloadId,
  };

  if (row.mapping?.kind === 'series') {
    return { ...shared, seriesId: row.mapping.seriesId, episodeIds: row.mapping.episodeIds };
  }
  if (row.mapping?.kind === 'movie') {
    return { ...shared, movieId: row.mapping.movieId };
  }
  // Unreachable in practice: `included` rows always carry a mapping — a row
  // without one cannot be included (ADR-4, `store.ts`'s `missing-mapping`
  // guard on `updateImportRow`). Sent as-is rather than thrown, so a
  // precondition that somehow slipped through still produces a failed
  // outcome through the ordinary command path instead of crashing the run.
  return shared;
}

function failAll(
  outcomes: Map<number, ImportRowOutcome>,
  rows: ImportPlanRow[],
  reason: string,
): void {
  for (const row of rows) outcomes.set(row.ordinal, { outcome: 'failed', destination: null, error: reason });
}

async function runImport(
  planId: string,
  plan: ImportPlan,
  rows: ImportPlanRow[],
  client: ImportClient,
): Promise<void> {
  const outcomes = new Map<number, ImportRowOutcome>();

  try {
    const files = rows.map((row) => toManualImportFile(row, plan.downloadId));
    // Noted just before the command is posted: ADR-7's history read-back is
    // scoped to events after this instant, so an older import of the same
    // path from a previous run cannot be mistaken for this one's.
    const since = new Date().toISOString();

    const posted = await client.manualImport(files);
    if (!posted.ok) {
      failAll(outcomes, rows, posted.error.reason);
    } else {
      const settled = await awaitCommand(client, posted.value.commandId, 'import');
      // The command's own failure or timeout is a coarse gate, never per-file
      // truth (ADR-7) — verification still runs, because the instance may
      // have imported some files before the command as a whole failed.
      const [history, candidates] = await Promise.all([
        client.historyForDownload(plan.downloadId),
        client.manualImportCandidates(plan.downloadId),
      ]);
      const verified = verifyImport(rows, history, candidates, since);
      for (const result of verified) outcomes.set(result.ordinal, result.outcome);

      if (settled.failure !== null) {
        // Verification is still authoritative for every row it reached. The
        // command's note only fills in a row verification somehow left
        // untouched, which should not happen since every row is scoped by
        // `verifyImport` above.
        for (const row of rows) {
          if (!outcomes.has(row.ordinal)) {
            outcomes.set(row.ordinal, { outcome: 'unverified', destination: null, error: settled.failure });
          }
        }
      }
    }
  } catch (error) {
    // The run threw before it could record an outcome through the ordinary
    // path. Every row left unresolved is honestly `unverified` — not
    // `failed`, because an exception here says nothing about whether the
    // instance actually imported anything — and the plan still finishes
    // rather than being left stuck in `applying`.
    const message = error instanceof Error ? error.message : 'The import run threw before it could record an outcome.';
    for (const row of rows) {
      if (!outcomes.has(row.ordinal)) {
        outcomes.set(row.ordinal, { outcome: 'unverified', destination: null, error: message });
      }
    }
    logger.error('import apply threw', { planId, error: String(error) });
  }

  for (const row of rows) {
    const outcome = outcomes.get(row.ordinal)
      ?? { outcome: 'unverified' as const, destination: null, error: 'No outcome was observed for this file.' };
    recordImportRowOutcome(planId, row.ordinal, outcome);
  }

  writeOperationLog(planId, plan, rows, outcomes);
  finishImportPlan(planId);

  // Unconditional, including on a run with failures: helparr cannot tell from
  // here whether the instance changed its decision-engine inputs or its
  // library on its way to a partial result, and a cache miss costs one
  // re-read while a stale cache costs correctness (ADR-7, matching gaps'
  // `attach()` precedent).
  invalidateDecisionsConfig(plan.instanceId);
  invalidateLibrary(plan.instanceId);
}

function writeOperationLog(
  planId: string,
  plan: ImportPlan,
  rows: ImportPlanRow[],
  outcomes: Map<number, ImportRowOutcome>,
): void {
  const files: ImportFileOutcomeInput[] = rows.map((row) => {
    const outcome = outcomes.get(row.ordinal)
      ?? { outcome: 'unverified' as const, destination: null, error: 'No outcome was observed for this file.' };
    return {
      path: row.path,
      destination: {
        mapping: row.mapping,
        importedPath: outcome.destination,
      },
      mappingSource: row.mappingSource,
      outcome: outcome.outcome,
      error: outcome.error,
    };
  });

  const succeeded = files.filter((file) => file.outcome === 'succeeded').length;

  try {
    recordImportOperation({
      kind: 'import',
      // States the ratio rather than the happy number, so a partial run
      // cannot be read as a complete one from the log's summary line alone
      // (REQ-OPS-001's force-import extension).
      summary: `Force-imported ${succeeded} of ${files.length} file(s)`,
      // `plan.instanceId` is `''` when the instance was deleted after the
      // plan was opened (store.ts) — normalized to null, same as rename's.
      instanceId: plan.instanceId || null,
      instanceLabel: plan.instanceLabel,
      instanceKind: plan.instanceKind,
      entityTitle: plan.title,
      entityRef: planId,
      indexer: null,
      // A force import involves no indexer and no download URL to hash.
      urlSha256: null,
      urlHost: null,
      outcome: succeeded === files.length ? 'succeeded' : 'failed',
      rejected: false,
      detail: [],
    }, files);
  } catch (error) {
    // The import already happened. Losing the log entry is bad; throwing
    // here would also lose the plan's own per-row outcomes, which is worse.
    logger.error('failed to record import operation', { planId, error: String(error) });
  }
}

export function isImporting(planId: string): boolean {
  return inFlight.has(planId);
}
