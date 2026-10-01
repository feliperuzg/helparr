import 'server-only';

import type {
  CauseEvidence,
  CauseRemedy,
  QueueCause,
  QueueRecord,
  TorrentState,
} from '@/lib/types';
import { classifyStall } from './stall';

/**
 * `classifyCause` per ADR-2 (REQ-QUEUE-018..023, design/state-cause.md).
 *
 * A pure function over the record, the torrent already joined by
 * `enrichRecords`, and an injected clock — no I/O, so `now` can be fixed in a
 * test and the five-minute dwell boundary checked exactly (T22). It has no
 * memory of its own previous answer; `design/state-cause.md` draws the real
 * lifecycle only to reason about it, it is not a state machine helparr
 * implements.
 *
 * Rules are evaluated top to bottom and the first match wins, exactly as
 * ADR-2's table reads. Reaching the end without a match is `unknown`, never
 * `healthy` (FR5) — the taxonomy is closed (REQ-QUEUE-018) and nothing here
 * asserts a reading the evidence does not support: a rule that needs the
 * download client's state (payload-missing, stalled, importing,
 * import-not-performed) simply does not fire when the client is unreachable
 * or the record was never matched to a torrent, and classification falls
 * through to the next rule rather than guessing.
 */

/** REQ-QUEUE-018 / OQ-8: the client-clock dwell before "importing" becomes
 *  "import not performed". `completionOn` is the client's clock, never the
 *  *arr's (ADR-2) — `trackedDownloadState` alone flapped 38/70 times in 70s
 *  during the spike and cannot carry this boundary on its own. */
export const IMPORT_NOT_PERFORMED_DWELL_MS = 5 * 60 * 1000;

/** Evidence source for the arr side. Queue records only ever come from an
 *  arr-capable client (`isArrQueueClient` in `queue/aggregate.ts`), so
 *  `instanceKind` is always `sonarr` or `radarr` here — this just narrows
 *  the wider `InstanceKind` type to the evidence union without asserting. */
function arrSource(record: QueueRecord): 'sonarr' | 'radarr' {
  return record.instanceKind === 'radarr' ? 'radarr' : 'sonarr';
}

/** `import-not-performed` and `import-rejected` are the only causes that can
 *  recommend force import, and only for an arr record with a downloadId —
 *  everything the ADR-3 screen is opened from (candidates come from
 *  `manualimport?downloadId=`, which has nothing to read without one). */
function canForceImport(record: QueueRecord): boolean {
  return (
    record.downloadId !== null
    && (record.instanceKind === 'sonarr' || record.instanceKind === 'radarr')
  );
}

function cause(
  kind: QueueCause['kind'],
  provenance: QueueCause['provenance'],
  evidence: CauseEvidence[],
  remedies: CauseRemedy[],
): QueueCause {
  return { kind, provenance, evidence, remedies };
}

export function classifyCause(
  record: QueueRecord,
  torrent: TorrentState | null,
  now: number,
): QueueCause {
  const source = arrSource(record);
  const hasWarning = record.trackedDownloadStatus === 'warning' || record.statusMessages.length > 0;

  // Rule 1: no torrent matched, and the instance itself has nothing to say —
  // there is no evidence to call this healthy or anything else (FR5).
  if (!torrent && !hasWarning) {
    return cause(
      'unknown',
      'inferred',
      [
        {
          source: 'helparr',
          text: 'No download-client torrent matched this record, and '
            + `${source} reported no warning.`,
        },
      ],
      [],
    );
  }

  // Rule 2: the download client's own vocabulary for a vanished payload.
  // Checked before the stall read so a payload the client has already given
  // up on is never reported merely "stalled" (REQ-QUEUE-021's "MUST NOT
  // offer force import without a payload" starts here).
  if (torrent && (torrent.state === 'missingFiles' || torrent.state === 'error')) {
    return cause(
      'payload-missing',
      'inferred',
      [{ source: 'qbittorrent', text: `state ${torrent.state}` }],
      ['remove-and-blocklist'],
    );
  }

  // Rule 3: REQ-QUEUE-005's stall verdict, reused unchanged — not
  // reimplemented. Independent of `trackedDownloadStatus` by design: the
  // premise of this whole screen is a torrent stuck at 0 peers while the
  // *arr still reports "ok".
  const stall = classifyStall(torrent);
  if (stall.stalled) {
    return cause(
      'stalled',
      'inferred',
      [{ source: 'qbittorrent', text: stall.evidence }],
      ['remove-and-blocklist'],
    );
  }

  // Rule 4: the only *reported* cause — cited verbatim from the instance's
  // own statusMessages, never replaced or reworded (REQ-QUEUE-020).
  if (
    record.status === 'completed'
    && record.trackedDownloadStatus === 'warning'
    && record.statusMessages.length > 0
  ) {
    const evidence: CauseEvidence[] = record.statusMessages.map((message) => ({
      source,
      text: message.messages.length > 0
        ? `${message.title}: ${message.messages.join('; ')}`
        : message.title,
    }));
    const remedies: CauseRemedy[] = canForceImport(record)
      ? ['force-import', 'remove-and-blocklist']
      : ['remove-and-blocklist'];
    return cause('import-rejected', 'reported', evidence, remedies);
  }

  // Rules 5 and 6: both require the client's own completion clock. Without a
  // torrent match (or without `completionOn`, e.g. a client that reports the
  // hash but never recorded a completion), neither can fire — the
  // classification falls through rather than asserting one of them anyway.
  if (
    record.status === 'completed'
    && record.trackedDownloadStatus === 'ok'
    && record.statusMessages.length === 0
    && torrent?.completionOn != null
  ) {
    const dwellMs = now - torrent.completionOn;
    const minutesAgo = Math.max(0, Math.round(dwellMs / 60_000));
    const evidence: CauseEvidence[] = [
      { source, text: `trackedDownloadStatus ${record.trackedDownloadStatus}` },
      { source, text: `trackedDownloadState ${record.trackedDownloadState}` },
      { source: 'qbittorrent', text: `client completed ${minutesAgo}m ago` },
    ];

    if (dwellMs <= IMPORT_NOT_PERFORMED_DWELL_MS) {
      return cause('importing', 'inferred', evidence, ['wait']);
    }

    const remedies: CauseRemedy[] = canForceImport(record) ? ['force-import'] : [];
    return cause('import-not-performed', 'inferred', evidence, remedies);
  }

  // Rule 7: both sides agree the record is actively transferring. The only
  // cause reached with no `inferred` callout, because nothing here is
  // helparr's own reading (REQ-QUEUE-005 already requires this agreement).
  // "Both sides" is literal: without a matched torrent there is no client side,
  // and a record is never healthy on the absence of evidence (REQ-QUEUE-018) —
  // a warning-bearing `downloading` record with the client unreachable would
  // otherwise slip past rule 1 and land here.
  if (torrent !== null && record.status === 'downloading' && !stall.stalled) {
    return cause(
      'healthy',
      'reported',
      [
        { source, text: `trackedDownloadStatus ${record.trackedDownloadStatus}` },
        { source: 'qbittorrent', text: `state ${torrent.state}` },
      ],
      [],
    );
  }

  // Rule 8: nothing above matched. Named explicitly rather than left to a
  // default — `unknown` is a genuine resting state (REQ-QUEUE-018), not a
  // failure of this function.
  return cause(
    'unknown',
    'inferred',
    [
      {
        source: 'helparr',
        text: `status ${record.status}, trackedDownloadStatus ${record.trackedDownloadStatus} `
          + 'matched none of the closed taxonomy\'s rules.',
      },
    ],
    [],
  );
}
