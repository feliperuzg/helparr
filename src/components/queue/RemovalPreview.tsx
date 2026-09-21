'use client';

import { useCallback, useState } from 'react';

import { Callout, Modal } from '@/components/ui';
import type { QueueRecord, RemovalRequest } from '@/lib/types';

/**
 * The confirmed preview (REQ-QUEUE-013, -014, ADR-4, T18 — deviation D1).
 *
 * Nothing is sent until the operator confirms. The prototype's fixed preset with
 * a prose warning is replaced by three explicit checkboxes, because a
 * destructive action whose side effects are implied by prose is one the operator
 * did not actually choose.
 *
 * The three flags are the ones the *arr queue DELETE endpoint genuinely exposes.
 * The proposal named `deleteFiles`; no such parameter exists — deleting the
 * payload is what `removeFromClient` does — so a fourth checkbox would have been
 * a control that did nothing.
 */

/** Defaults are the non-destructive ones, and they are not remembered across
 *  invocations: state that persists is state the operator stops reading. */
const INITIAL: RemovalRequest = {
  removeFromClient: true,
  blocklist: false,
  skipRedownload: false,
};

interface FlagSpec {
  key: keyof RemovalRequest;
  label: string;
  note: string;
  warn?: boolean;
}

const FLAGS: FlagSpec[] = [
  {
    key: 'removeFromClient',
    label: 'Remove from download client',
    note: 'deletes the partial download — cannot be undone',
    warn: true,
  },
  {
    key: 'blocklist',
    label: 'Add release to blocklist',
    note: 'prevents this release being grabbed again',
  },
  {
    key: 'skipRedownload',
    label: 'Skip the automatic re-search',
    note: 'removal otherwise triggers a new search immediately',
  },
];

/** Above this many rows the list scrolls. It is never summarised to "and N
 *  more" — every affected item is named (REQ-QUEUE-013). */
const SCROLL_AFTER = 20;

export default function RemovalPreview({
  records,
  onCancel,
  onConfirm,
  busy,
}: {
  records: QueueRecord[];
  onCancel: () => void;
  onConfirm: (flags: RemovalRequest) => void;
  busy: boolean;
}) {
  const [flags, setFlags] = useState<RemovalRequest>(INITIAL);
  const count = records.length;

  // Escape and backdrop-click are inert while the requests are in flight —
  // they cannot recall what has already been sent, and dismissing the dialog
  // would hide the per-item outcomes that are about to arrive. Stable identity
  // matters: `Modal` restores focus on cleanup, so a fresh closure every render
  // would yank focus out of the dialog mid-interaction.
  const onClose = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);

  return (
    <Modal
      title={`Remove ${count} item${count === 1 ? '' : 's'} from the queue?`}
      labelledBy="removal-title"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            onClick={() => onConfirm(flags)}
            disabled={busy}
          >
            {busy ? 'Removing…' : `Remove ${count} item${count === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <p style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
        {count === 1 ? 'This item' : `These ${count} items`} will be affected:
      </p>

      <ul
        className="removal-list"
        style={count > SCROLL_AFTER ? { maxHeight: 260, overflowY: 'auto' } : undefined}
      >
        {records.map((record) => (
          <li key={record.id}>
            <span className="mono truncate">{record.title}</span>
            <span className="subtle truncate">
              {record.instanceLabel} · {record.targetLabel}
            </span>
          </li>
        ))}
      </ul>

      <fieldset className="removal-flags">
        <legend className="sr-only">Removal side effects</legend>
        {FLAGS.map((flag) => (
          <label key={flag.key} className="removal-flag">
            <input
              type="checkbox"
              className="checkbox"
              checked={flags[flag.key]}
              disabled={busy}
              onChange={(e) => setFlags((f) => ({ ...f, [flag.key]: e.target.checked }))}
            />
            <span>
              {flag.label}
              <span className={flag.warn ? 'text-error' : 'subtle'}> — {flag.note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Callout tone="info">Nothing is sent until you confirm.</Callout>
    </Modal>
  );
}
