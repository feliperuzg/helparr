'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';

import Icon from '@/components/Icon';
import type { ImportPlanRow } from '@/lib/importPlan';
import { formatBytes } from '@/lib/queue';

/**
 * The force-import candidate grid (T17; FR6, FR7, ADR-4, ADR-8).
 *
 * One row per file the instance's own `manualimport` resolver returned, in the
 * instance's order. Not virtualized, unlike rename's `PlanGrid`: a force import
 * is one download, a handful of files, and each row needs room to state its
 * rejections in full — a fixed row height would have to clip the one text this
 * screen exists to show.
 *
 * The checkbox means **inclusion**, exactly as in rename: ticked is "this file
 * will be sent". Three row shapes follow from the plan, never from local state:
 *
 * - **replace-flagged** — the target already has a file. Starts unticked
 *   (ADR-8) and says, in words and numbers, which quality replaces which.
 * - **unmapped** — the instance resolved no target. The checkbox is present but
 *   disabled; "Change…" is the only way to make the row includable. There is no
 *   path to import a file with no destination.
 * - **operator-remapped** — "Mapped by" reads "you changed this" as text, not as
 *   a row tint (REQ-QUEUE-021's "indicate that the mapping differs").
 *
 * Rejections are rendered verbatim, one per line, attributed to the instance
 * that returned them (FR6). helparr's own readings (the replacement flag, the
 * no-target line) are attributed to helparr, so neither is mistaken for the
 * other.
 */

export type CandidateGridMode =
  /** `ready` on a writable instance: rows can be included and remapped. */
  | 'edit'
  /** A kind whose write is gated off (ADR-6, `writeEnabled`): candidates for reference only. */
  | 'readonly'
  /** The preview outlived its five minutes: still visible, nothing actionable. */
  | 'expired';

export interface CandidateGridProps {
  rows: ImportPlanRow[];
  mode: CandidateGridMode;
  /** Who resolved these candidates — named on every rejection and on "Mapped by". */
  instanceLabel: string;
  /** Radarr has nothing to remap against (one record, one movie), so no "Change…". */
  canRemap: boolean;
  cursor: number;
  onCursorChange: (index: number) => void;
  /**
   * Edit mode only. `shift` is true for a shift+click — a range from the
   * anchor to this row (REQ-QUEUE-025), which the screen sends as one edit.
   */
  onToggleIncluded?: (row: ImportPlanRow, shift: boolean) => void;
  /** Edit mode on a remappable instance only. */
  onChangeMapping?: (row: ImportPlanRow) => void;
  /** A row or bulk edit is in flight; the controls wait for it rather than queue a second. */
  busy?: boolean;
}

export default function CandidateGrid({
  rows, mode, instanceLabel, canRemap, cursor, onCursorChange,
  onToggleIncluded, onChangeMapping, busy = false,
}: CandidateGridProps) {
  const editable = mode === 'edit' && onToggleIncluded !== undefined;
  const remappable = editable && canRemap && onChangeMapping !== undefined;
  const showCheck = mode !== 'readonly';
  const showMappedBy = mode !== 'readonly';

  return (
    <div className="card table-wrap" style={{ padding: 0, overflowX: 'auto' }}>
      <table
        className="table"
        role="grid"
        aria-label={
          mode === 'readonly'
            ? `Candidates ${instanceLabel} resolved, for reference only`
            : `Candidates ${instanceLabel} resolved for this download`
        }
        aria-multiselectable={editable || undefined}
        aria-readonly={!editable || undefined}
        aria-busy={busy || undefined}
      >
        <thead>
          <tr>
            {showCheck ? (
              <th scope="col" className="col-check">
                <span className="sr-only">Included</span>
              </th>
            ) : null}
            <th scope="col" className="col-grow">File</th>
            <th scope="col" className="col-num">Size</th>
            <th scope="col">Quality</th>
            <th scope="col">Target</th>
            {showMappedBy ? <th scope="col">Mapped by</th> : null}
            {remappable ? (
              <th scope="col"><span className="sr-only">Change mapping</span></th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <CandidateRow
              key={row.ordinal}
              row={row}
              index={index}
              mode={mode}
              instanceLabel={instanceLabel}
              showCheck={showCheck}
              showMappedBy={showMappedBy}
              editable={editable}
              remappable={remappable}
              isCursor={index === cursor}
              busy={busy}
              onCursorChange={onCursorChange}
              onToggleIncluded={onToggleIncluded}
              onChangeMapping={onChangeMapping}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The filename alone; the full path is the hover text and the spoken label. */
export function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at < 0 ? path : path.slice(at + 1);
}

/** "Bluray-1080p → WEBDL-1080p" — never a bare "replaces existing file" with no numbers (ADR-8). */
export function replacementSwap(row: ImportPlanRow): string | null {
  if (!row.replacesExisting) return null;
  const from = row.replacesExisting.quality ?? 'unknown quality';
  const to = row.quality.name ?? 'unknown quality';
  return `${from} → ${to}`;
}

interface CandidateRowProps {
  row: ImportPlanRow;
  index: number;
  mode: CandidateGridMode;
  instanceLabel: string;
  showCheck: boolean;
  showMappedBy: boolean;
  editable: boolean;
  remappable: boolean;
  isCursor: boolean;
  busy: boolean;
  onCursorChange: (index: number) => void;
  onToggleIncluded?: (row: ImportPlanRow, shift: boolean) => void;
  onChangeMapping?: (row: ImportPlanRow) => void;
}

/**
 * `useListKeyboard` listens on the window and preventDefaults Space and Enter
 * there; a control inside the grid is the one place that costs something, so
 * its own keys stop at the control (same treatment as `PlanGrid`'s group tick).
 */
function keepKeysLocal(event: KeyboardEvent<HTMLElement>) {
  if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
}

function CandidateRow({
  row, index, mode, instanceLabel, showCheck, showMappedBy, editable, remappable,
  isCursor, busy, onCursorChange, onToggleIncluded, onChangeMapping,
}: CandidateRowProps) {
  const ref = useRef<HTMLTableRowElement>(null);
  const name = baseName(row.path);
  const unmapped = row.mapping === null;
  const swap = replacementSwap(row);
  // Dimmed by colour token, not opacity: an excluded row is still a row the
  // operator has to be able to read, just not one that will be sent.
  const quiet = mode === 'expired' || (mode === 'edit' && !row.included);

  // Focus follows the cursor only while focus is already inside the grid —
  // otherwise j/k would drag focus out of wherever the operator left it.
  useEffect(() => {
    if (!isCursor) return;
    const node = ref.current;
    if (!node) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && node.parentElement?.contains(active)) node.focus();
  }, [isCursor]);

  return (
    <tr
      ref={ref}
      tabIndex={isCursor ? 0 : -1}
      aria-selected={editable ? row.included : undefined}
      className={isCursor ? 'is-cursor' : undefined}
      onClick={() => onCursorChange(index)}
      style={{ verticalAlign: 'top', color: quiet ? 'var(--color-text-muted)' : undefined }}
    >
      {showCheck ? (
        <td className="col-check" style={{ paddingBlock: 'var(--space-2)' }}>
          {editable && onToggleIncluded ? (
            <input
              type="checkbox"
              className="checkbox"
              checked={row.included}
              // Present but disabled on an unmapped row: the operator can see
              // the control exists and why it cannot be used yet.
              disabled={unmapped || busy}
              // No focus on press: a focused input reads as typing to the list
              // keyboard (j/k stop), and a shift-press would paint a text selection.
              onMouseDown={(event) => event.preventDefault()}
              // `change` is dispatched from the click, so the click's shift is on it.
              onChange={(event) => onToggleIncluded(row, (event.nativeEvent as MouseEvent).shiftKey === true)}
              onKeyDown={keepKeysLocal}
              onClick={(event) => event.stopPropagation()}
              tabIndex={-1}
              aria-label={
                unmapped
                  ? `${name} has no target and cannot be included until it is mapped`
                  : `Include ${name} in this import`
              }
            />
          ) : (
            <input
              type="checkbox"
              className="checkbox"
              checked={row.included}
              disabled
              tabIndex={-1}
              aria-label={`${name} was ${row.included ? 'included' : 'excluded'} when the preview expired`}
            />
          )}
        </td>
      ) : null}

      <td className="col-grow" style={{ paddingBlock: 'var(--space-2)' }}>
        <span className="mono truncate" style={{ display: 'block' }} title={row.path}>
          {name}
        </span>
        <CandidateNotes
          row={row}
          instanceLabel={instanceLabel}
          swap={swap}
          unmapped={unmapped}
          showInclusion={mode === 'edit'}
        />
      </td>

      <td className="col-num" style={{ paddingBlock: 'var(--space-2)' }}>
        {formatBytes(row.size)}
      </td>

      <td className="mono" style={{ paddingBlock: 'var(--space-2)' }}>
        {row.quality.name ?? '—'}
      </td>

      <td style={{ paddingBlock: 'var(--space-2)', whiteSpace: 'normal' }}>
        {row.mapping ? (
          <span>{row.mapping.label}</span>
        ) : (
          <span className="subtle">
            <span aria-hidden="true">— unmapped —</span>
            <span className="sr-only">no target</span>
          </span>
        )}
      </td>

      {showMappedBy ? (
        <td style={{ paddingBlock: 'var(--space-2)' }}>
          <MappedBy row={row} instanceLabel={instanceLabel} />
        </td>
      ) : null}

      {remappable && onChangeMapping ? (
        <td style={{ paddingBlock: 'var(--space-1)' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={(event) => {
              event.stopPropagation();
              onCursorChange(index);
              onChangeMapping(row);
            }}
            onKeyDown={keepKeysLocal}
            disabled={busy}
            // Roving, like the row: Tab from the cursor row reaches its own
            // button, not every button in the grid.
            tabIndex={isCursor ? 0 : -1}
            aria-label={`Change what ${name} is mapped to`}
          >
            Change…
          </button>
        </td>
      ) : null}
    </tr>
  );
}

/**
 * "instance" vs "you changed this" — the mapping's owner in words (ADR-4),
 * because a row tint alone says nothing to a screen reader or to an operator
 * who cannot tell the two tints apart.
 */
function MappedBy({ row, instanceLabel }: { row: ImportPlanRow; instanceLabel: string }) {
  if (row.mapping === null) {
    return (
      <span className="subtle">
        <span aria-hidden="true">—</span>
        <span className="sr-only">not mapped</span>
      </span>
    );
  }
  if (row.mappingSource === 'operator') {
    return (
      <span className="badge badge-neutral" title={`Differs from what ${instanceLabel} resolved`}>
        <Icon name="rename" size={11} />
        you changed this
      </span>
    );
  }
  return (
    <span className="badge badge-idle" title={`${instanceLabel}'s own resolution, unmodified`}>
      <Icon name="plug" size={11} />
      {instanceLabel}
    </span>
  );
}

/**
 * Everything said about one candidate beneath its filename. Order is fixed:
 * helparr's replacement warning first (it is the destructive case), then the
 * no-target line, then the instance's own rejections verbatim.
 */
function CandidateNotes({
  row, instanceLabel, swap, unmapped, showInclusion,
}: {
  row: ImportPlanRow;
  instanceLabel: string;
  swap: string | null;
  unmapped: boolean;
  showInclusion: boolean;
}) {
  return (
    <div
      style={{
        whiteSpace: 'normal',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
        marginTop: 'var(--space-1)',
      }}
    >
      {swap ? (
        <p
          style={{
            margin: 0,
            display: 'flex',
            gap: 'var(--space-1)',
            alignItems: 'flex-start',
            color: 'var(--color-status-warn)',
          }}
        >
          <Icon name="alert" size={11} />
          <span>
            <strong>Replaces existing file: </strong>
            <span className="mono">{swap}</span>
            <span className="subtle"> — helparr&rsquo;s reading; {instanceLabel} calls any replacement an upgrade.</span>
            {showInclusion ? (
              <span style={{ display: 'block', color: 'var(--color-foreground)' }}>
                {row.included
                  ? 'You included it — the existing file will be replaced.'
                  : 'Starts excluded — include it explicitly to replace that file.'}
              </span>
            ) : null}
          </span>
        </p>
      ) : null}

      {unmapped ? (
        <p style={{ margin: 0 }} className="subtle">
          No target — {instanceLabel} could not resolve a destination for this file.
          {showInclusion ? ' Map it with “Change…” before it can be included.' : ''}
        </p>
      ) : null}

      {row.rejections.length === 0 ? (
        <p style={{ margin: 0 }} className="subtle">no rejections</p>
      ) : (
        <div>
          <span className="subtle">{instanceLabel} rejected it, verbatim:</span>
          <ul className="msg-list msg-list--nested" style={{ marginTop: 0 }}>
            {row.rejections.map((rejection, at) => (
              // Rejections can repeat word for word; the index keeps both.
              <li key={`${at}:${rejection}`}>{rejection}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
