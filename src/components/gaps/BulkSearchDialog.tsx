'use client';

import { useMemo } from 'react';

import { Callout, Modal } from '@/components/ui';
import type { Gap } from '@/lib/types';

/**
 * The bulk-search confirmation (FR9; REQ-GAPS-008, -009; D7; T16).
 *
 * A search command is cheap for helparr and expensive for the operator: each one
 * queries every indexer Prowlarr manages, and trackers with a daily API limit
 * count it. So nothing on the gaps screen issues one implicitly — this dialog is
 * the only path, and it exists to make the size of the request impossible to
 * misread.
 *
 * The count appears three times — title, body, button — and **all three read the
 * same `gaps.length`**, which is the same array the confirm handler sends. There
 * is no second source for it to drift from. The items are listed rather than
 * merely counted, so "5" is auditable rather than asserted.
 */

export interface BulkSearchDialogProps {
  /**
   * Captured when the dialog opened, by the screen. If the filter changes
   * underneath, the screen closes the dialog rather than silently re-scoping
   * it — a confirmation whose subject moved is not a confirmation.
   */
  gaps: Gap[];
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}

export default function BulkSearchDialog({
  gaps,
  onCancel,
  onConfirm,
  busy,
}: BulkSearchDialogProps) {
  const count = gaps.length;

  // Collapsed for reading only — `Reacher — S04E02, S04E03, S04E07` is one line
  // the operator can check against what they selected, where three lines of
  // near-identical text is not. The request still carries every id.
  //
  // Films do not collapse: every Radarr gap sits under the literal group `Films`
  // (FR5), so grouping by it would merge unrelated films into one line named
  // after the group rather than after any of them. A film is its own title.
  const lines = useMemo(() => {
    const byGroup = new Map<string, { key: string; label: string; instance: string; codes: string[] }>();
    for (const gap of gaps) {
      const key = gap.kind === 'movie'
        ? `${gap.instanceId}:movie:${gap.upstreamId}`
        : `${gap.instanceId}:${gap.groupTitle}`;
      const entry = byGroup.get(key) ?? {
        key,
        label: gap.kind === 'movie' ? gap.title : gap.groupTitle,
        instance: gap.instanceLabel,
        codes: [],
      };
      if (gap.kind === 'episode') entry.codes.push(gap.itemCode);
      byGroup.set(key, entry);
    }
    return [...byGroup.values()];
  }, [gaps]);

  return (
    <Modal
      title={`Search for ${count} ${count === 1 ? 'gap' : 'gaps'}`}
      labelledBy="bulk-search-title"
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={busy || count === 0}
          >
            {busy ? 'Asking…' : `Search ${count} ${count === 1 ? 'gap' : 'gaps'}`}
          </button>
        </>
      )}
    >
      <p style={{ fontSize: 13 }}>
        helparr will ask each instance to search automatically for {count === 1 ? 'this' : 'these'}{' '}
        {count} {count === 1 ? 'item' : 'items'}:
      </p>

      <ul className="bulk-list">
        {lines.map((line) => (
          <li key={line.key}>
            <span className="bulk-list__group">{line.label}</span>
            {line.codes.length > 0 ? (
              <span className="bulk-list__codes mono"> — {line.codes.join(', ')}</span>
            ) : null}
            <span className="bulk-list__instance">{line.instance}</span>
          </li>
        ))}
      </ul>

      <Callout tone="warn">
        Each search queries every indexer Prowlarr manages. Trackers with a daily API limit count
        these against it. {count} {count === 1 ? 'search' : 'searches'} now.
      </Callout>

      {/* What the command does and does not do. The instance searches; helparr
          only asked, and the gaps stay listed either way. */}
      <p className="subtle" style={{ fontSize: 11 }}>
        The instances run the searches themselves. helparr reports whether each one accepted the
        command, not what it found — anything grabbed shows up in the queue.
      </p>

      {busy ? (
        <p className="subtle" aria-busy="true" role="status" style={{ fontSize: 12 }}>
          Sending the commands…
        </p>
      ) : null}
    </Modal>
  );
}
