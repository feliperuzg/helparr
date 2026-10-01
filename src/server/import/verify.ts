import 'server-only';

import type { ImportPlanRow, ImportRowOutcome } from '@/lib/importPlan';
import type { ArrHistoryEvent, ArrImportCandidate, ClientResult } from '@/server/clients/types';

/**
 * Per-file read-back (ADR-7, REQ-QUEUE-022, REQ-OPS-001's force-import
 * extension).
 *
 * `ManualImport`'s own command result is a whole-batch verdict — `awaitCommand`
 * (`commands/await.ts`) treats it as a gate, never as per-file truth, exactly
 * as rename's ADR-7 already established. This module supplies the truth, by
 * the same two-source rule rename never had the luxury of (Radarr has no
 * rename event, but every force import — Sonarr or Radarr — writes a
 * `downloadFolderImported` history event):
 *
 * 1. A history event after the command was posted, naming this row's own path
 *    as `droppedPath`, is this row's evidence of success. `importedPath` is
 *    the destination, read verbatim off that event.
 * 2. Absent that, a fresh `manualimport` read that still lists the path is
 *    evidence of failure — its own rejections are the explanation.
 * 3. Absent both, the row is `unverified`: neither source confirms it either
 *    way, and that honesty is the whole point of the three-way outcome
 *    (ADR-7, mirroring REQ-RENAME-016's rule that a partial run can never be
 *    reported as a complete one).
 *
 * Pure: both reads are passed in already resolved (as `ClientResult`s), so
 * this function makes no request of its own and can be exercised without a
 * fake client.
 */

export interface VerifiedRow {
  ordinal: number;
  path: string;
  outcome: ImportRowOutcome;
}

/**
 * Path comparison is exact string equality — the instance reports its own
 * `droppedPath`/candidate `path` verbatim, and a normalized or fuzzy match
 * could paper over a real mismatch between what was sent and what landed.
 */
/**
 * `since` is helparr's clock; `event.date` is the instance's, at whatever
 * precision it records (whole seconds on some builds). A strict comparison
 * misses a real import that lands in the same second, or on a host whose
 * clock trails helparr's. The window is safe to widen because the match is
 * already scoped to this download's history and to the exact `droppedPath`.
 */
export const IMPORT_CLOCK_SKEW_MS = 60_000;

function matchingImportEvent(
  events: ArrHistoryEvent[],
  path: string,
  sinceMs: number,
): ArrHistoryEvent | null {
  return events.find((event) => (
    event.eventType === 'downloadFolderImported'
    && Date.parse(event.date) >= sinceMs - IMPORT_CLOCK_SKEW_MS
    && event.data.droppedPath === path
  )) ?? null;
}

export function verifyImport(
  rows: ImportPlanRow[],
  history: ClientResult<ArrHistoryEvent[]>,
  candidates: ClientResult<ArrImportCandidate[]>,
  since: string,
): VerifiedRow[] {
  const sinceMs = Date.parse(since);
  const events = history.ok ? history.value : [];
  const byPath = candidates.ok
    ? new Map(candidates.value.map((candidate) => [candidate.path, candidate]))
    : null;

  // Neither source could be read at all — there is no evidence either way,
  // and every row is honestly unverified rather than guessed at from the
  // command's own coarse result.
  const bothUnreadable = !history.ok && !candidates.ok;
  const unreadableReason = bothUnreadable
    ? `Could not verify: history read failed (${history.ok ? '' : history.error.reason}); `
      + `candidate read failed (${candidates.ok ? '' : candidates.error.reason}).`
    : null;

  return rows.map((row): VerifiedRow => {
    const matched = matchingImportEvent(events, row.path, sinceMs);
    if (matched) {
      return {
        ordinal: row.ordinal,
        path: row.path,
        outcome: {
          outcome: 'succeeded',
          destination: matched.data.importedPath ?? null,
          error: null,
        },
      };
    }

    if (bothUnreadable) {
      return {
        ordinal: row.ordinal,
        path: row.path,
        outcome: { outcome: 'unverified', destination: null, error: unreadableReason },
      };
    }

    const stillCandidate = byPath?.get(row.path) ?? null;
    if (stillCandidate) {
      return {
        ordinal: row.ordinal,
        path: row.path,
        outcome: {
          outcome: 'failed',
          destination: null,
          // The candidate's own rejection reasons, verbatim (FR6's rule
          // applied here too) — joined, since `error` is one string.
          error: stillCandidate.rejections.length > 0
            ? stillCandidate.rejections.join('; ')
            : 'The instance still lists this file as a pending candidate, with no rejection reason given.',
        },
      };
    }

    return {
      ordinal: row.ordinal,
      path: row.path,
      outcome: {
        outcome: 'unverified',
        destination: null,
        error: candidates.ok
          ? "Neither the instance's history nor its candidate list accounts for this file."
          : `Could not verify against the candidate list: ${candidates.error.reason}`,
      },
    };
  });
}
