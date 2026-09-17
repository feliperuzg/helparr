'use client';

import { useCallback, useMemo, useState } from 'react';

import Icon from '@/components/Icon';
import { warningCount, warningKinds, WARNING_COPY } from '@/components/rename/planView';
import { Callout, Modal } from '@/components/ui';
import type { RenamePlanRow } from '@/lib/types';

/**
 * The typed-count gate (T13, FR9, REQ-RENAME-010, ADR-8).
 *
 * The operator types the number of files the plan will touch. Not a word, not a
 * checkbox: the number is the one piece of information that cannot be produced
 * without having looked at what is on the screen, which is the whole point of a
 * gate in front of an irreversible bulk write.
 *
 * ADR-8, and it is the reason this component has no `settings` prop: **there is
 * no way to turn this off.** No preference disables it, none is planned, and
 * the dialog does not hint at one — a bypass would make the gate a formality
 * for exactly the operators who have renamed enough files to stop reading.
 *
 * The count is captured **once, when the dialog opens**, and held in state from
 * there. A count that moved underneath a half-typed number would either reject
 * a correct answer or — far worse — accept one the operator typed about a
 * different plan.
 */

export interface ConfirmApplyDialogProps {
  /** Every row in the plan, so the dialog can describe what is excluded too. */
  rows: RenamePlanRow[];
  /** `plan.affectedFiles` — non-excluded rows, per FR7. */
  affectedFiles: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typedCount: number) => void;
}

export default function ConfirmApplyDialog({
  rows, affectedFiles, busy, onCancel, onConfirm,
}: ConfirmApplyDialogProps) {
  // Frozen at open: a `useState` initializer runs once for the life of the
  // component and is never recomputed, so the poll that fires a second later
  // cannot move the target out from under a half-typed number. The dialog is
  // mounted only while it is open, so "once" and "at open" are the same moment.
  const [expected] = useState(affectedFiles);
  const [typed, setTyped] = useState('');

  const matches = typed.trim() === String(expected);
  const touched = typed.trim() !== '';

  const flagged = useMemo(() => warningCount(rows), [rows]);
  const kinds = useMemo(() => warningKinds(rows), [rows]);
  const excluded = rows.length - rows.filter((row) => !row.excluded).length;
  const movesFolders = useMemo(
    () => rows.filter((row) => !row.excluded && row.warnings.includes('moves-directory')).length,
    [rows],
  );

  // Stable, because `Modal` restores focus in the cleanup of an effect keyed on
  // it — a new function each render would restore focus on every keystroke.
  const close = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);

  return (
    <Modal
      title="Rename these files?"
      labelledBy="rename-confirm-title"
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            // Disabled, never hidden: the operator has to be able to see the
            // control they have not yet earned, or the number they are typing
            // has no visible purpose.
            disabled={!matches || busy}
            onClick={() => onConfirm(expected)}
          >
            <Icon name="rename" size={13} />
            {busy ? 'Sending…' : `Rename ${expected} file${expected === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <p className="modal__lead">
        {/* Said plainly, because it is the fact the operator most needs and the
            one a progress screen is about to make untrue. */}
        <strong>Nothing has been renamed yet.</strong> Zero files have moved. This plan has only
        been read from your instances — the rename happens when you press the button below,
        and not before.
      </p>

      <ul className="confirm-facts">
        <li>
          <Icon name="rename" size={13} />
          <span>
            <strong className="mono">{expected}</strong> file{expected === 1 ? '' : 's'} will be
            renamed by the instance that holds {expected === 1 ? 'it' : 'them'}.
          </span>
        </li>
        {movesFolders > 0 ? (
          <li>
            <Icon name="folder" size={13} />
            <span>
              <strong className="mono">{movesFolders}</strong> of{' '}
              {expected === 1 ? 'them' : 'those'} will also be <strong>moved</strong> into a
              different folder.
            </span>
          </li>
        ) : null}
        {excluded > 0 ? (
          <li>
            <Icon name="x" size={13} />
            <span>
              <strong className="mono">{excluded}</strong> file
              {excluded === 1 ? '' : 's'} you excluded will not be sent at all.
            </span>
          </li>
        ) : null}
        <li>
          <Icon name="alert" size={13} />
          <span>
            Renaming <strong>cannot be undone</strong> from helparr. Putting a file back means
            renaming it again, by hand, on the instance.
          </span>
        </li>
      </ul>

      {flagged > 0 ? (
        <Callout tone="warn">
          {flagged} of these {expected} file{expected === 1 ? '' : 's'} carry a flag helparr
          derived itself — neither Sonarr nor Radarr warns about any of them:
          <ul className="msg-list">
            {kinds.map((kind) => (
              <li key={kind}>
                <strong>{WARNING_COPY[kind].label}</strong> — {WARNING_COPY[kind].summary}.
              </li>
            ))}
          </ul>
          Cancel and exclude them if any of that is not what you meant.
        </Callout>
      ) : null}

      <div className="confirm-gate">
        <label className="confirm-gate__label" htmlFor="rename-typed-count">
          Type <strong className="mono">{expected}</strong> to confirm you have read the plan
        </label>
        <input
          id="rename-typed-count"
          className="input mono confirm-gate__input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={busy}
          aria-describedby="rename-typed-hint"
          aria-invalid={touched && !matches}
        />
        {/* Three states, and none of them mentions a way to skip this step —
            there is none to mention (ADR-8). */}
        <p
          id="rename-typed-hint"
          className={`confirm-gate__hint${touched && !matches ? ' is-wrong' : ''}`}
          role="status"
        >
          {!touched
            ? `Nothing is sent until this field reads ${expected}.`
            : matches
              ? 'Matches. The button below will rename these files.'
              : `That is not ${expected}. The rename stays disabled until it matches.`}
        </p>
      </div>
    </Modal>
  );
}
