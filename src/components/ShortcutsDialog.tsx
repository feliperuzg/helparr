'use client';

import { Modal } from './ui';

/**
 * The keyboard shortcut reference (FR14 / REQ-A11Y-003, T20).
 *
 * Not a route — a dialog reachable from the topbar on every screen, and from
 * the `?` key anywhere that is not a text field.
 *
 * It reuses `Modal` despite DESIGN.md §5 reserving modals for genuinely
 * blocking confirmations, which this is not. Named here as the deliberate
 * exception it is: building a second focus-containment mechanism for one
 * read-only dialog would duplicate `Modal`'s tab trap for no behaviour the
 * operator would ever notice.
 */

type Row = [keys: string[], description: string];

const EVERYWHERE: Row[] = [
  [['?'], 'Open this reference'],
  [['1', '…', '6'], 'Jump to Overview … Settings'],
  [['7'], 'Jump to Unmapped'],
  [['Esc'], 'Close the closest open thing — a panel, a dialog, a selection'],
];

const LISTS: Row[] = [
  [['/'], 'Focus the filter or search field'],
  [['j', '↓'], 'Move the cursor down one row'],
  [['k', '↑'], 'Move the cursor up one row'],
  [['Home', 'End'], 'Jump to the first / last row'],
  [['PgUp', 'PgDn'], 'Move ten rows at once'],
  [['Space'], 'Toggle the row under the cursor and make it the range anchor *'],
  [['Shift', 'J', '↓'], 'Extend the selection down one row *'],
  [['Shift', 'K', '↑'], 'Extend the selection up one row *'],
  [['Shift', 'Space'], 'Select from the anchor to the cursor *'],
  [['Shift', 'click'], 'Select from the anchor to the clicked row *'],
  [['Enter'], 'Open the row — inspector or detail; on Unmapped, its indexer search'],
  [['e'], 'Expand or collapse the open inspector'],
  [['Esc'], 'Collapse an expanded inspector, then close it'],
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={onClose}
      labelledBy="shortcuts-title"
      // Taller than a short viewport, and nothing in it but the Close button
      // in the footer: the body has to be a stop of its own to be scrolled.
      focusableBody
      // A real focusable dismissal, not just Escape and the backdrop: this is
      // the one dialog an operator opens *because* they are not sure which keys
      // work, so it cannot be one that only closes if you already know.
      footer={<button type="button" className="btn btn-primary btn-sm" onClick={onClose}>Close</button>}
    >
      <div className="shortcuts">
        <Section title="Everywhere" rows={EVERYWHERE} />

        {/* Two sections rather than one flat list. Activity and Settings do not
            use the list keyboard layer, so they are correctly absent here
            rather than padded in for symmetry. */}
        <Section title="Any list screen (Overview, Search, Gaps, Rename, Force import, Unmapped)" rows={LISTS} />

        {/* The asterisk is load-bearing. The bindings are consistent across
            every list screen with exactly one exception, and a reference that
            hid it to look more consistent than the app is would be lying about
            the only thing an operator could get caught by. */}
        <p className="shortcuts__note subtle">
          * Search and Unmapped have no bulk selection — <kbd className="kbd">Space</kbd>
          scrolls there instead, the same as on any page. On Force import, selecting a
          candidate includes it in the import.
        </p>
        <p className="shortcuts__note subtle">
          All of the above is suppressed while a dialog is open — the dialog owns the
          keyboard until it closes.
        </p>
      </div>
    </Modal>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="shortcuts__section">
      <h3 className="shortcuts__heading">{title}</h3>
      <dl className="shortcuts__list">
        {rows.map(([keys, description]) => (
          <div className="shortcuts__row" key={description}>
            <dt className="shortcuts__keys">
              {keys.map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}
            </dt>
            <dd className="shortcuts__desc">{description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
