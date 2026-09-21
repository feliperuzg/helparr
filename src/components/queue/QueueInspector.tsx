'use client';

import Icon from '@/components/Icon';
import { Callout, Inspector, InspectorGroup, KV, StatusBadge } from '@/components/ui';
import {
  STATE_ICON,
  STATE_LABEL,
  STATE_TONE,
  deriveState,
  etaOf,
  formatBytes,
  formatSpeed,
  progressOf,
  stallDisagreement,
} from '@/lib/queue';
import type { QueueRecord } from '@/lib/types';

/**
 * The inspector (REQ-QUEUE-004, -011, T15 — deviation D2).
 *
 * A right-hand panel, not a modal: the operator is comparing this row against
 * the ones around it, and a dialog would hide exactly the context that makes
 * the comparison worth making.
 *
 * The four upstream channels are rendered **verbatim and separately**. Collapsing
 * them into one derived sentence is what the prototype did and what
 * REQ-QUEUE-004 forbids — `trackedDownloadStatus: ok` alongside
 * `trackedDownloadState: importBlocked` is a diagnosis, and it only exists if
 * both are on screen.
 */
export default function QueueInspector({
  record,
  onClose,
  onRemove,
}: {
  record: QueueRecord;
  onClose: () => void;
  onRemove: () => void;
}) {
  const state = deriveState(record);
  const progress = progressOf(record);
  const disagreement = stallDisagreement(record);

  return (
    <Inspector
      eyebrow={`${record.instanceLabel} · ${record.protocol}`}
      title={record.title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-danger btn-sm" onClick={onRemove}>
          <Icon name="x" size={12} />Remove from queue
        </button>
      }
    >
      {disagreement ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          {/* The disagreement is the finding, not an inconsistency to hide. */}
          <Callout tone="warn">{disagreement}</Callout>
        </div>
      ) : null}

      {record.errorMessage ? (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Callout tone="error">{record.errorMessage}</Callout>
        </div>
      ) : null}

      <InspectorGroup title="Upstream state">
        <KV
          rows={[
            ['Derived', (
              <StatusBadge key="d" tone={STATE_TONE[state]} icon={STATE_ICON[state]}>
                {STATE_LABEL[state]}
              </StatusBadge>
            )],
            ['status', <span key="s" className="mono">{record.status || '—'}</span>],
            ['trackedDownloadStatus', (
              <span key="tds" className="mono">{record.trackedDownloadStatus || '—'}</span>
            )],
            ['trackedDownloadState', (
              <span key="tdst" className="mono">{record.trackedDownloadState || '—'}</span>
            )],
            ['statusMessages', <StatusMessages key="sm" record={record} />],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Download client">
        {record.torrent ? (
          <KV
            rows={[
              ['stalled', record.stall.stalled ? `yes — ${record.stall.evidence}` : 'no'],
              ['fetching metadata', record.torrent.fetchingMetadata ? 'yes' : 'no'],
              ['client state', <span key="cs" className="mono">{record.torrent.state}</span>],
              ['seeders', `${record.torrent.numSeeds}`],
              ['leechers', `${record.torrent.numLeechs}`],
              ['speed', formatSpeed(record.torrent.dlspeed)],
            ]}
          />
        ) : (
          /* Un-enriched is a legible state, not a blank. Saying why keeps the
             operator from reading the gap as "nothing is wrong" (ADR-3). */
          <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
            {record.downloadId
              ? 'No download client reported this hash. The row is shown un-enriched rather than '
                + 'matched on title, which would attach the wrong torrent.'
              : 'This record has no download id — nothing to match against a download client.'}
          </p>
        )}
      </InspectorGroup>

      <InspectorGroup title="Transfer">
        <KV
          rows={[
            ['Progress', `${progress}% — ${formatBytes(record.size - record.sizeleft)} of ${formatBytes(record.size)}`],
            ['ETA', etaOf(record)],
            ['Protocol', record.protocol || '—'],
            ['Indexer', record.indexer ?? '—'],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Routing">
        <KV
          rows={[
            ['Target', record.targetLabel],
            ['Managed by', `${record.instanceLabel} (${record.instanceKind})`],
            ['Record id', <span key="r" className="mono">{record.recordId}</span>],
            ['Download id', <span key="d" className="mono">{record.downloadId ?? '—'}</span>],
          ]}
        />
      </InspectorGroup>
    </Inspector>
  );
}

/** Every message, every line. Truncating the one that names the actual problem
 *  is the failure mode this list exists to avoid. */
function StatusMessages({ record }: { record: QueueRecord }) {
  if (record.statusMessages.length === 0) return <span className="subtle">none</span>;
  return (
    <ul className="msg-list">
      {record.statusMessages.map((message, i) => (
        <li key={`${message.title}-${i}`}>
          <span className="mono">{message.title}</span>
          {message.messages.length > 0 ? (
            <ul className="msg-list msg-list--nested">
              {message.messages.map((line, j) => <li key={j}>{line}</li>)}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
