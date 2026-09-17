'use client';

import { useCallback, useState } from 'react';

import Icon from '@/components/Icon';
import { Callout, ChipGroup, FilterChip, Modal } from '@/components/ui';
import { describeUnresolved, SAVED_SEARCH_NAME_MAX } from '@/lib/savedSearch';
import type { SavedScopeResolution, SavedSearchRead } from '@/lib/types';

/**
 * Saved searches in the toolbar (FR11, FR12; REQ-SEARCH-011, -012, -014, -015;
 * T15).
 *
 * Selecting one restores a draft and nothing more. No indexer is queried by a
 * click here — that is REQ-SEARCH-012, and it is the same rule the rest of this
 * screen already lives by: a search runs when the operator presses Search.
 *
 * What a selection *does* do immediately is say what is missing. The resolution
 * is computed against the roster the screen already holds, so an indexer that
 * has left Prowlarr is named before the operator spends a query discovering it
 * — and named, not counted, because "1 indexer is gone" only tells them to go
 * and find out which.
 */

export interface SavedSearchesProps {
  searches: SavedSearchRead[];
  selectedId: string | null;
  /** The selected search resolved against the roster in hand, or null. */
  resolution: SavedScopeResolution | null;
  onSelect: (saved: SavedSearchRead) => void;
  onSave: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (saved: SavedSearchRead) => void;
  /** False when there is no query to save, or Prowlarr is unreachable. */
  canSave: boolean;
  busy: boolean;
}

export default function SavedSearches({
  searches,
  selectedId,
  resolution,
  onSelect,
  onSave,
  onRename,
  onDelete,
  canSave,
  busy,
}: SavedSearchesProps) {
  const [prompt, setPrompt] = useState<'save' | 'rename' | 'delete' | null>(null);

  const selected = selectedId ? searches.find((s) => s.id === selectedId) ?? null : null;
  const note = resolution ? describeUnresolved(resolution) : null;

  const close = useCallback(() => { if (!busy) setPrompt(null); }, [busy]);

  return (
    <>
      {/* Its own band below the toolbar rather than a row inside it. A saved
          search is not a field of the form — selecting one fills the form, and
          putting it among the fields would read as another thing to set before
          pressing Search. */}
      <div className="saved">
        <div className="stoolbar__row">
          <span className="stoolbar__label">Saved</span>

          {searches.length === 0 ? (
            <span className="subtle saved__empty">
              None yet — run a search and save it to come back to it.
            </span>
          ) : (
            <ChipGroup label="Saved searches">
              {searches.map((saved) => (
                <FilterChip
                  key={saved.id}
                  label={saved.name}
                  selected={saved.id === selectedId}
                  onToggle={() => onSelect(saved)}
                />
              ))}
            </ChipGroup>
          )}

          <div className="saved__actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canSave || busy}
              aria-disabled={!canSave || busy || undefined}
              title={canSave ? undefined : 'Type a query first — a saved search needs one.'}
              onClick={() => setPrompt('save')}
            >
              <Icon name="plus" size={12} />
              Save this search
            </button>

            {selected ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setPrompt('rename')}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setPrompt('delete')}
                >
                  <Icon name="x" size={12} />
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </div>

        {note ? (
          // `runnable` is the difference between a search that will still do
          // something and one that cannot: an inert scope is an error tone,
          // because pressing Search is about to be refused.
          <Callout tone={resolution?.runnable ? 'warn' : 'error'}>{note}</Callout>
        ) : null}
      </div>

      {prompt === 'save' ? (
        <NamePrompt
          title="Save this search"
          confirmLabel="Save"
          initial=""
          busy={busy}
          onCancel={close}
          onConfirm={(name) => onSave(name)}
        >
          The query, the indexers you picked and the seeder filter are stored under this name.
          helparr never re-runs it on its own — a saved search is a shortcut, not a schedule.
        </NamePrompt>
      ) : null}

      {prompt === 'rename' && selected ? (
        <NamePrompt
          title={`Rename "${selected.name}"`}
          confirmLabel="Rename"
          initial={selected.name}
          busy={busy}
          onCancel={close}
          onConfirm={(name) => onRename(selected.id, name)}
        >
          Only the name changes. What this search looks for stays exactly as it was saved.
        </NamePrompt>
      ) : null}

      {prompt === 'delete' && selected ? (
        <Modal
          title="Delete this saved search?"
          labelledBy="saved-delete-title"
          onClose={close}
          footer={(
            <>
              <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                disabled={busy}
                onClick={() => onDelete(selected)}
              >
                <Icon name="x" size={13} />
                {busy ? 'Deleting…' : `Delete "${selected.name}"`}
              </button>
            </>
          )}
        >
          {/* The name, in the sentence and on the button. A confirmation that
              says "delete this?" is a confirmation the operator answers about
              whichever row they think is selected (REQ-SEARCH-015). */}
          <p className="modal__lead">
            <strong>{selected.name}</strong> will be removed from the list.
          </p>
          <p className="subtle">
            The query itself is only a shortcut — nothing that was searched, grabbed or
            downloaded is affected. You can save it again at any time.
          </p>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * The one text prompt, used for both saving and renaming.
 *
 * No `autoFocus`: `Modal` moves focus to the dialog itself on mount, so an
 * input that grabbed it first would lose it a tick later and leave the operator
 * typing into nothing.
 */
function NamePrompt({
  title,
  confirmLabel,
  initial,
  busy,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  confirmLabel: string;
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void;
  children: React.ReactNode;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= SAVED_SEARCH_NAME_MAX;

  return (
    <Modal
      title={title}
      labelledBy="saved-name-title"
      onClose={onCancel}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || busy}
            onClick={() => onConfirm(trimmed)}
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </>
      )}
    >
      <p className="modal__lead">{children}</p>
      <label className="confirm-gate__label" htmlFor="saved-search-name">
        Name
      </label>
      <input
        id="saved-search-name"
        className="input"
        type="text"
        autoComplete="off"
        maxLength={SAVED_SEARCH_NAME_MAX}
        value={name}
        disabled={busy}
        aria-invalid={name.length > 0 && !valid}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          // Enter submits, because this dialog holds exactly one field and
          // reaching for the mouse to confirm a name is friction with no
          // safety value — unlike the rename gate, nothing here is destructive.
          if (event.key === 'Enter' && valid && !busy) {
            event.preventDefault();
            onConfirm(trimmed);
          }
        }}
      />
    </Modal>
  );
}
