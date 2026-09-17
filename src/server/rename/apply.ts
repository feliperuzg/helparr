import 'server-only';

import type { RenamePlanRow, RenameRefusal, RenameScopeEntry } from '@/lib/types';
import { isRenameClient, type RenameClient } from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { recordRenameOperation, type RenameFileOutcomeInput } from '@/server/operations/log';
import { resolvePlanRows } from './resolve';
import {
  beginApply,
  finishApply,
  getPlan,
  readApplicableRows,
  readScope,
  recordOutcome,
  refusePlan,
} from './store';

/**
 * Applying a plan (FR9..FR14, REQ-RENAME-010..016; ADR-6, ADR-7).
 *
 * Read the signature of `startApply` before anything else: it takes a plan id
 * and a number. That is the whole of NFR1's enforcement. There is no parameter
 * here a caller could use to name a file, and `RenameCommandRequest` is
 * constructed further down from rows this process itself persisted at build
 * time — so "apply something the operator did not approve" is not a case to
 * defend against, it is a sentence that cannot be written against this API.
 *
 * Everything else in this module is about the gap between "the plan was true
 * when it was built" and "the plan is true now". That gap is closed by
 * re-running the *same* `resolvePlanRows()` the build ran (NFR2) and refusing
 * the whole apply on any mismatch. There is no force flag and no partial
 * apply of the un-drifted rows: a preview the operator read that no longer
 * describes the library is not partly valid.
 */

/** How long the batch command is waited on before outcomes are verified. */
const COMMAND_DEADLINE_MS = 10 * 60 * 1000;
const COMMAND_POLL_MS = 1_000;

export type ApplyStart =
  | { ok: true; rowCount: number }
  | { ok: false; refusal: RenameRefusal };

interface CommandGroup {
  instanceId: string;
  instanceLabel: string;
  titleKind: RenamePlanRow['titleKind'];
  titleUpstreamId: number;
  titleLabel: string;
  rows: RenamePlanRow[];
}

const inFlight = new Set<string>();

/**
 * Validates, refuses, or dispatches. Returns as soon as the commands are
 * accepted — outcomes resolve behind the poll, because a `RenameFiles` across a
 * large plan takes minutes and nothing may be reported as renamed until its own
 * evidence exists (REQ-RENAME-015).
 */
export async function startApply(planId: string, typedCount: number): Promise<ApplyStart> {
  const plan = getPlan(planId);
  if (!plan) {
    return { ok: false, refusal: { kind: 'expired', reason: 'That plan no longer exists.', drifted: [] } };
  }

  // `getPlan` retires an over-age plan on read, so this is the same clock the
  // operator's screen is reading — not a second interpretation of the deadline.
  if (plan.phase === 'expired') {
    return {
      ok: false,
      refusal: {
        kind: 'expired',
        reason: 'This preview is more than five minutes old. Generate a new one.',
        drifted: [],
      },
    };
  }
  if (plan.phase !== 'ready') {
    return {
      ok: false,
      refusal: { kind: 'expired', reason: `This plan is ${plan.phase}, not ready to apply.`, drifted: [] },
    };
  }

  const stored = readApplicableRows(planId);
  if (stored.length === 0) {
    return {
      ok: false,
      refusal: { kind: 'empty', reason: 'Every row in this plan is excluded.', drifted: [] },
    };
  }

  // Defense in depth. The dialog already gates this, but the dialog is the
  // browser's opinion and this is the server's.
  if (typedCount !== stored.length) {
    return {
      ok: false,
      refusal: {
        kind: 'precondition-drift',
        reason: `The confirmation was for ${typedCount} files; this plan affects ${stored.length}.`,
        drifted: [],
      },
    };
  }

  const drifted = await findDrift(readScope(planId), stored);
  if (drifted.length > 0) {
    const refusal: RenameRefusal = {
      kind: 'precondition-drift',
      reason: drifted.length === 1
        ? '1 file changed since this preview was generated. Nothing was renamed.'
        : `${drifted.length} files changed since this preview was generated. Nothing was renamed.`,
      drifted,
    };
    refusePlan(planId, refusal);
    return { ok: false, refusal };
  }

  if (!beginApply(planId, String(typedCount))) {
    // Someone else moved this plan out of `ready` between the read above and
    // here — a second apply of the same plan. The loser does nothing.
    return {
      ok: false,
      refusal: { kind: 'expired', reason: 'This plan is already being applied.', drifted: [] },
    };
  }

  inFlight.add(planId);
  void runApply(planId, stored).finally(() => inFlight.delete(planId));
  return { ok: true, rowCount: stored.length };
}

/**
 * Re-resolves the scope and compares, per non-excluded row, the three things
 * the operator actually approved: which file, where it is, and where it is
 * going.
 *
 * The design names `(fileId, existingPath)` as the precondition identity; the
 * destination is checked too, because a naming-format change between preview
 * and apply would move files somewhere the operator never saw. A row that has
 * disappeared from the fresh preview entirely counts as drifted — its rename
 * is no longer pending, which means something else already handled it.
 */
async function findDrift(scope: RenameScopeEntry[], stored: RenamePlanRow[]): Promise<string[]> {
  const fresh = await resolvePlanRows(scope);
  const byFileId = new Map(fresh.rows.map((row) => [`${row.instanceId}:${row.fileId}`, row]));

  const drifted: string[] = [];
  for (const row of stored) {
    const current = byFileId.get(`${row.instanceId}:${row.fileId}`);
    if (!current
      || current.existingPath !== row.existingPath
      || current.proposedPath !== row.proposedPath) {
      drifted.push(row.existingPath);
    }
  }
  return drifted;
}

/**
 * Groups by title, because that is what `RenameFiles` takes: one title id and
 * the subset of its files to touch. The subset is the point — it is the only
 * shape that can express an exclusion (ADR-6).
 */
function groupByTitle(rows: RenamePlanRow[]): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  for (const row of rows) {
    const key = `${row.instanceId}:${row.titleKind}:${row.titleUpstreamId}`;
    const group = groups.get(key) ?? {
      instanceId: row.instanceId ?? '',
      instanceLabel: row.instanceLabel,
      titleKind: row.titleKind,
      titleUpstreamId: row.titleUpstreamId,
      titleLabel: row.titleLabel,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function runApply(planId: string, rows: RenamePlanRow[]): Promise<void> {
  const groups = groupByTitle(rows);
  const outcomes = new Map<string, { outcome: 'succeeded' | 'failed' | 'skipped'; detail: string | null }>();

  for (const group of groups) {
    const resolved = clientFor(group.instanceId);
    if (!resolved || !isRenameClient(resolved.client)) {
      fail(outcomes, group.rows, `${group.instanceLabel} is no longer reachable.`);
      continue;
    }
    const client: RenameClient = resolved.client;

    const dispatched = await client.renameFiles({
      kind: group.titleKind,
      titleId: group.titleUpstreamId,
      // Exclusions were filtered out in `readApplicableRows`. Nothing here
      // reads the plan again — these are the rows the gate was checked against.
      fileIds: group.rows.map((row) => row.fileId),
    });
    if (!dispatched.ok) {
      fail(outcomes, group.rows, dispatched.error.reason);
      continue;
    }

    const settled = await awaitCommand(client, dispatched.value);
    if (settled.failure !== null) {
      fail(outcomes, group.rows, settled.failure);
      continue;
    }

    await verifyGroup(client, group, outcomes, settled.message);
  }

  for (const row of rows) {
    const result = outcomes.get(row.id)
      ?? { outcome: 'failed' as const, detail: 'No outcome was observed for this file.' };
    recordOutcome(row.id, result.outcome, result.detail);
  }

  writeOperationLog(planId, rows, outcomes);
  finishApply(planId);
}

function fail(
  outcomes: Map<string, { outcome: 'succeeded' | 'failed' | 'skipped'; detail: string | null }>,
  rows: RenamePlanRow[],
  reason: string,
): void {
  for (const row of rows) outcomes.set(row.id, { outcome: 'failed', detail: reason });
}

interface CommandResult {
  /** Non-null when the command itself never completed. */
  failure: string | null;
  /**
   * The instance's own note about the completed command.
   *
   * Worth carrying even on success, because it is the only place the upstream
   * admits to doing nothing: a Sonarr that renamed zero files still reports
   * `completed` / `successful`, and says so only here — measured verbatim as
   * `0 selected episode files renamed for <title>` on 2026-09-17.
   */
  message: string | null;
}

async function awaitCommand(client: RenameClient, commandId: number): Promise<CommandResult> {
  const deadline = Date.now() + COMMAND_DEADLINE_MS;
  while (Date.now() < deadline) {
    const status = await client.commandStatus(commandId);
    if (!status.ok) return { failure: status.error.reason, message: null };
    if (status.value.state === 'completed') {
      return { failure: null, message: status.value.message };
    }
    if (status.value.state === 'failed') {
      return {
        failure: status.value.message ?? 'The instance reported the rename command failed.',
        message: status.value.message,
      };
    }
    await new Promise((done) => setTimeout(done, COMMAND_POLL_MS));
  }
  return {
    failure: 'The rename command did not finish in time. Check the instance before retrying.',
    message: null,
  };
}

/**
 * Establishes what actually happened, per file, by re-running the preview
 * (ADR-7).
 *
 * `commandStatus` reporting `completed` means the instance stopped working, not
 * that any particular file moved — so it is a gate, never the evidence. The
 * preview is the evidence: a file that was pending a rename and is no longer
 * pending one was renamed; a file still listed was not.
 *
 * This works identically on Sonarr and Radarr, which the history route does
 * not — Radarr has no rename event at all. It also has a property the history
 * route lacks: if `RenameFiles` had ignored the id list and renamed everything
 * pending, the fresh preview would be emptier than this plan, and the
 * discrepancy is visible rather than silently successful.
 */
async function verifyGroup(
  client: RenameClient,
  group: CommandGroup,
  outcomes: Map<string, { outcome: 'succeeded' | 'failed' | 'skipped'; detail: string | null }>,
  commandMessage: string | null,
): Promise<void> {
  const fresh = await client.renamePreview({
    kind: group.titleKind,
    upstreamId: group.titleUpstreamId,
  });

  if (!fresh.ok) {
    // The command was accepted and may well have worked, but helparr has no
    // evidence either way — and reporting an unverified rename as succeeded is
    // exactly what REQ-RENAME-015 forbids.
    fail(outcomes, group.rows, `Could not verify the result: ${fresh.error.reason}`);
    return;
  }

  const stillPending = new Set(fresh.value.map((row) => row.fileId));
  // The command's own note, when it has one, is the closest thing to an
  // explanation the upstream offers for a rename that did not happen. Quoted
  // rather than paraphrased — the reasons are the product.
  const failureDetail = commandMessage
    ? `The instance still lists this file as pending a rename. It reported: ${commandMessage}`
    : 'The instance still lists this file as pending a rename.';

  for (const row of group.rows) {
    outcomes.set(row.id, stillPending.has(row.fileId)
      ? { outcome: 'failed', detail: failureDetail }
      : { outcome: 'succeeded', detail: null });
  }
}

function writeOperationLog(
  planId: string,
  rows: RenamePlanRow[],
  outcomes: Map<string, { outcome: 'succeeded' | 'failed' | 'skipped'; detail: string | null }>,
): void {
  const files: RenameFileOutcomeInput[] = rows.map((row) => {
    const result = outcomes.get(row.id) ?? { outcome: 'failed' as const, detail: null };
    return {
      planRowId: row.id,
      existingPath: row.existingPath,
      proposedPath: row.proposedPath,
      outcome: result.outcome,
      detail: result.detail,
    };
  });

  const succeeded = files.filter((file) => file.outcome === 'succeeded').length;
  const titles = new Set(rows.map((row) => `${row.instanceId}:${row.titleUpstreamId}`)).size;
  const first = rows[0];

  try {
    recordRenameOperation({
      kind: 'rename',
      // States the ratio rather than the happy number, so a partial run cannot
      // be read as a complete one from the log's summary line alone.
      summary: `Renamed ${succeeded} of ${files.length} files across ${titles} title(s)`,
      instanceId: first?.instanceId ?? null,
      instanceLabel: first?.instanceLabel ?? 'unknown',
      instanceKind: first?.instanceKind ?? 'sonarr',
      entityTitle: first?.titleLabel ?? 'rename plan',
      entityRef: planId,
      indexer: null,
      // A rename involves no indexer and no download URL. There is nothing to
      // hash because nothing was fetched.
      urlSha256: null,
      urlHost: null,
      outcome: succeeded === files.length ? 'succeeded' : 'failed',
      rejected: false,
      detail: [],
    }, files);
  } catch (error) {
    // The rename already happened. Losing the log entry is bad; throwing here
    // would also lose the plan's own outcomes, which is worse.
    logger.error('failed to record rename operation', { planId, error: String(error) });
  }
}

export function isApplying(planId: string): boolean {
  return inFlight.has(planId);
}
