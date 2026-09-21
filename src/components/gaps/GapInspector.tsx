'use client';

import Link from 'next/link';

import { formatAirDate } from '@/components/gaps/GapsGrid';
import { useGapHistory } from '@/components/gaps/useGaps';
import Icon from '@/components/Icon';
import { Callout, Inspector, InspectorGroup, KV } from '@/components/ui';
import { ApiError } from '@/lib/api';
import type { Gap, HistoryEvent, InferredReason } from '@/lib/types';

/**
 * The gap inspector (REQ-GAPS-006, -007; FR16; ADR-6; T14).
 *
 * Two rules, and both are about provenance:
 *
 * 1. **helparr's reading is labelled as helparr's reading.** Neither Sonarr nor
 *    Radarr answers "why is this missing", so the reason shown here is composed
 *    from history. It says so, in those words, in a different tone from the
 *    upstream text below it. An inference rendered like a report is a lie about
 *    where it came from.
 * 2. **History is read when a gap is opened, never per row.** One `/history`
 *    request for the item on screen. A grid of four hundred rows that each
 *    fetched their own history would be four hundred requests for a panel the
 *    operator opens three times.
 */

export interface GapInspectorProps {
  gap: Gap;
  onClose: () => void;
  /** Opens the attach confirmation. The push never starts from this panel. */
  onAttach: () => void;
  /** Opens the search confirmation for this one gap. */
  onSearch: () => void;
}

export default function GapInspector({ gap, onClose, onAttach, onSearch }: GapInspectorProps) {
  // Keyed on the item, so moving down the grid with j/k cannot leave the
  // previous episode's history under the current episode's title.
  const history = useGapHistory({
    instanceId: gap.instanceId,
    kind: gap.kind,
    upstreamId: gap.upstreamId,
  });

  // The route's inference wins over whatever the list carried: the list has no
  // history to reason from, so its `inferred` is null on every gap until this
  // read lands.
  const inferred = history.data?.inferred ?? gap.inferred;

  return (
    <Inspector
      label="Gap detail"
      eyebrow={`${gap.instanceLabel} · ${gap.kind}`}
      title={`${gap.groupTitle} — ${gap.itemCode}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline btn-sm" onClick={onSearch}>
            <Icon name="search" size={12} />Search
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onAttach}>
            <Icon name="down" size={12} />Attach
          </button>
          {/* FR16. The query is pre-typed, not pre-run — /search spends indexer
              quota and decides that for itself. */}
          <Link
            className="btn btn-ghost btn-sm"
            href={`/search?q=${encodeURIComponent(`${gap.groupTitle} ${gap.itemCode}`)}`}
          >
            <Icon name="search" size={12} />Indexers
          </Link>
        </>
      }
    >
      {inferred ? <Inference reason={inferred} instanceLabel={gap.instanceLabel} /> : null}

      <InspectorGroup title="Item">
        <KV
          rows={[
            ['Title', gap.title],
            ['Code', gap.itemCode],
            ['Aired', formatAirDate(gap.airDate)],
            // Constant by construction — the read filters on `monitored`, so an
            // unmonitored item is never a gap. Stated anyway, because an absent
            // row would read as "unknown" on the screen whose whole job is
            // explaining why a file is not there.
            ['Monitored', 'yes'],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Destination">
        <KV
          rows={[
            // An em dash rather than an empty cell: a blank `dd` reads as a
            // rendering gap, and "the instance did not say" is information.
            ['Wanted', gap.wantedQuality ?? '—'],
            ['Path', gap.targetPath ?? '—'],
            ['Managed by', gap.instanceLabel],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title={`History (from ${gap.instanceLabel})`}>
        {history.isPending ? (
          <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>Reading history from {gap.instanceLabel}…</p>
        ) : history.isError ? (
          <Callout tone="warn">
            {history.error instanceof ApiError
              ? history.error.message
              : `${gap.instanceLabel} did not return a history for this item.`}
          </Callout>
        ) : (history.data?.events.length ?? 0) === 0 ? (
          // A statement about the data, not about the item. "No history" is not
          // the same claim as "never searched", and only the first is knowable.
          <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
            {gap.instanceLabel} holds no history for this {gap.kind}.
          </p>
        ) : (
          <ul className="msg-list">
            {history.data!.events.map((event, i) => (
              <li key={`${i}-${event.at}`}>
                <HistoryLine event={event} />
              </li>
            ))}
          </ul>
        )}
      </InspectorGroup>
    </Inspector>
  );
}

/**
 * Deliberately not the `warn` tone. This is helparr talking, and it is marked as
 * such twice over — by the `info` tone and by the sentence itself (REQ-GAPS-007).
 */
function Inference({ reason, instanceLabel }: { reason: InferredReason; instanceLabel: string }) {
  return (
    <Callout tone="info">
      <strong style={{ display: 'block', marginBottom: 'var(--space-2)' }}>
        helparr&apos;s reading — not reported by {instanceLabel}
      </strong>
      {reason.text}
    </Callout>
  );
}

/** Upstream's own vocabulary and upstream's own release name, rendered plainly. */
function HistoryLine({ event }: { event: HistoryEvent }) {
  return (
    <>
      <span className="mono">{formatEventType(event.eventType)}</span>
      {'  '}
      <span className="subtle mono">{formatStamp(event.at)}</span>
      {event.sourceTitle ? <> · {event.sourceTitle}</> : null}
    </>
  );
}

/** `downloadFolderImported` → `download folder imported`. The word is theirs; only
 *  the casing is ours, and nothing is dropped. */
function formatEventType(eventType: string): string {
  return eventType.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Local time — it is the clock the operator compares against. */
function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
