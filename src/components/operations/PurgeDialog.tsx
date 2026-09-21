'use client';

import { useCallback } from 'react';

import { Callout, Modal } from '@/components/ui';

/**
 * The only deletion helparr performs against the operation log (FR11, OQ-5).
 *
 * Retention is unlimited by decision, so this button is the sole path by which
 * a row ever leaves the table. That is why the confirmation states the state
 * change — "this deletes all 47 records, including the 6 that failed" — rather
 * than echoing the request back as a question, and why the destructive button
 * carries the count instead of the word "Confirm": friction matched to
 * severity.
 *
 * REQ-OPS-003 survives this intact. The log must not be modified or silently
 * deleted *in the course of normal use*; an operator-initiated purge of the
 * whole log is neither silent nor partial.
 */

export default function PurgeDialog({
  total,
  failures,
  busy,
  onCancel,
  onConfirm,
}: {
  total: number;
  /** Rejections and transport failures together — the rows worth losing least. */
  failures: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Stable identity: `Modal` restores focus on cleanup, so a fresh closure every
  // render would yank focus out of the dialog mid-interaction.
  const onClose = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);

  return (
    <Modal
      title="Purge the operation log"
      labelledBy="purge-title"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            onClick={onConfirm}
            disabled={busy || total === 0}
          >
            {busy ? 'Purging…' : `Purge ${total} row${total === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <p style={{ fontSize: 'var(--text-base)' }}>
        This deletes all {total} operation record{total === 1 ? '' : 's'}
        {failures > 0 ? `, including the ${failures} that did not succeed` : ''}. It cannot be
        undone, and it is the only deletion helparr performs against this log.
      </p>

      <Callout tone="info">Nothing on your instances changes.</Callout>
    </Modal>
  );
}
