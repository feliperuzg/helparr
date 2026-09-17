'use client';

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties,
} from 'react';

import Icon from '@/components/Icon';
import { DiffCell } from '@/components/rename/PathDiff';
import {
  rowStatus, titleKeyOf, WARNING_COPY, type GridMode,
} from '@/components/rename/planView';
import { StatusBadge } from '@/components/ui';
import type { RenamePlanRow } from '@/lib/types';

/**
 * The plan grid (T12, FR3, FR4, FR6, FR7, FR8, NFR2).
 *
 * Structurally the gaps grid: one flat array, headings injected at render time
 * as rows the cursor cannot land on, a roving `tabindex`, and true
 * `aria-rowindex`. NFR2 asks it to hold five thousand rows and still scroll,
 * which is why it is virtualized rather than paginated — a plan split across
 * pages is a plan nobody reads to the end of before typing the count.
 *
 * What is new here is the checkbox's meaning. It is **inclusion**, not
 * selection: ticked means this file will be sent. Unticking it is the FR7
 * exclusion, it round-trips to the server immediately, and the total the typed
 * count is checked against moves with it. There is no second "selected" concept
 * layered on top — one source of truth, so the number on the button and the
 * ticks in the grid cannot disagree.
 */

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 30;
const TOUCH_ROW_HEIGHT = 48;
const TOUCH_HEADER_HEIGHT = 44;
const TOUCH_QUERY = '(max-width: 767px)';
const OVERSCAN = 12;

function useMediaMatch(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

interface TitleHeaderRow {
  type: 'header';
  key: string;
  titleLabel: string;
  instanceLabel: string;
  count: number;
  /** Row ids under this heading, for the group tick. */
  rowIds: string[];
  includedCount: number;
}

type RenderRow =
  | TitleHeaderRow
  | { type: 'row'; key: string; row: RenamePlanRow; flatIndex: number };

/** One pass, grouping on the order the rows arrive in — this does not sort. */
export function buildRenderRows(rows: RenamePlanRow[]): RenderRow[] {
  const out: RenderRow[] = [];
  let groupKey: string | null = null;
  let header: TitleHeaderRow | null = null;

  rows.forEach((row, flatIndex) => {
    const key = titleKeyOf(row);
    if (key !== groupKey) {
      groupKey = key;
      header = {
        type: 'header',
        key: `hdr:${key}:${row.id}`,
        titleLabel: row.titleLabel,
        instanceLabel: row.instanceLabel,
        count: 0,
        rowIds: [],
        includedCount: 0,
      };
      out.push(header);
    }
    if (header) {
      header.count += 1;
      header.rowIds.push(row.id);
      if (!row.excluded) header.includedCount += 1;
    }
    out.push({ type: 'row', key: row.id, row, flatIndex });
  });

  return out;
}

export interface PlanGridProps {
  rows: RenamePlanRow[];
  mode: GridMode;
  cursor: number;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  openRowId: string | null;
  /** Only supplied while the plan can still be edited (`preview`). */
  onSetExcluded?: (rowIds: string[], excluded: boolean) => void;
  busy?: boolean;
}

export default function PlanGrid({
  rows, mode, cursor, onCursorChange, onOpen, openRowId, onSetExcluded, busy = false,
}: PlanGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const touch = useMediaMatch(TOUCH_QUERY);
  const rowHeight = touch ? TOUCH_ROW_HEIGHT : ROW_HEIGHT;
  const headerHeight = touch ? TOUCH_HEADER_HEIGHT : HEADER_HEIGHT;

  const editable = mode === 'preview' && onSetExcluded !== undefined;

  const renderRows = useMemo(() => buildRenderRows(rows), [rows]);

  const renderIndexOf = useMemo(() => {
    const map = new Int32Array(rows.length);
    renderRows.forEach((entry, index) => {
      if (entry.type === 'row') map[entry.flatIndex] = index;
    });
    return map;
  }, [renderRows, rows.length]);

  const cursorRenderRef = useRef(0);
  cursorRenderRef.current = rows.length > 0
    ? renderIndexOf[Math.min(cursor, rows.length - 1)]
    : 0;

  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    indexes.add(cursorRenderRef.current);
    return [...indexes].sort((a, b) => a - b);
  }, []);

  const estimateSize = useCallback(
    (index: number) => (renderRows[index]?.type === 'header' ? headerHeight : rowHeight),
    [renderRows, headerHeight, rowHeight],
  );

  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  useEffect(() => {
    if (rows.length > 0) virtualizer.scrollToIndex(cursorRenderRef.current, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, rows.length, renderRows.length]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const style = useMemo(
    () => ({
      padding: 0,
      overflow: 'hidden',
      '--row-height': `${rowHeight}px`,
      '--group-height': `${headerHeight}px`,
    } as CSSProperties),
    [rowHeight, headerHeight],
  );

  const includedTotal = rows.filter((row) => !row.excluded).length;
  const allIncluded = rows.length > 0 && includedTotal === rows.length;
  const someIncluded = !allIncluded && includedTotal > 0;

  return (
    <div
      className="pgrid card"
      role="grid"
      aria-label={
        mode === 'preview' || mode === 'expired'
          ? 'Proposed renames'
          : 'Renames and what each one did'
      }
      aria-multiselectable={editable || undefined}
      aria-rowcount={renderRows.length + 1}
      aria-busy={busy || undefined}
      style={style}
    >
      <div className="pgrid__row pgrid__head" role="row" aria-rowindex={1}>
        <span role="columnheader" className="pgrid__cell pgrid__cell--check">
          {editable ? (
            <input
              type="checkbox"
              className="checkbox"
              checked={allIncluded}
              ref={(node) => { if (node) node.indeterminate = someIncluded; }}
              onChange={() => onSetExcluded(rows.map((row) => row.id), allIncluded)}
              aria-label={
                allIncluded
                  ? 'Exclude every file from this plan'
                  : 'Include every file in this plan'
              }
            />
          ) : (
            <span className="sr-only">Included</span>
          )}
        </span>
        <span role="columnheader" className="pgrid__cell">
          Rename
          <span className="sr-only">
            . The current filename, then the one the instance proposed.
          </span>
        </span>
        <span role="columnheader" className="pgrid__cell pcol-warn">
          Flags
          {/* ADR-9, spoken and not only hovered: a badge in this column is
              helparr's own reading of the plan, and an operator who took it for
              relayed upstream text would blame the wrong program for it. */}
          <span className="sr-only">
            . Warnings helparr derived itself by comparing the plan against the
            files on disk. Neither Sonarr nor Radarr reports any of them.
          </span>
        </span>
        <span role="columnheader" className="pgrid__cell pcol-status">Status</span>
      </div>

      <div
        className="pgrid__scroll"
        ref={scrollRef}
        // Stated, not derived: `contain: strict` resolves an `auto` height to
        // zero and the grid silently renders nothing.
        style={{ height: Math.max(totalSize, rowHeight) }}
      >
        <div className="pgrid__canvas" style={{ height: totalSize }}>
          {items.map((item) => {
            const entry = renderRows[item.index];
            if (!entry) return null;
            if (entry.type === 'header') {
              return (
                <GroupHeader
                  key={entry.key}
                  header={entry}
                  renderIndex={item.index}
                  offset={item.start}
                  onSetExcluded={editable ? onSetExcluded : undefined}
                />
              );
            }
            return (
              <Row
                key={entry.key}
                row={entry.row}
                mode={mode}
                flatIndex={entry.flatIndex}
                renderIndex={item.index}
                offset={item.start}
                isCursor={entry.flatIndex === cursor}
                isOpen={entry.row.id === openRowId}
                editable={editable}
                onCursorChange={onCursorChange}
                onOpen={onOpen}
                onSetExcluded={editable ? onSetExcluded : undefined}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GroupHeader({
  header,
  renderIndex,
  offset,
  onSetExcluded,
}: {
  header: TitleHeaderRow;
  renderIndex: number;
  offset: number;
  onSetExcluded?: (rowIds: string[], excluded: boolean) => void;
}) {
  const all = header.includedCount === header.count;
  const some = !all && header.includedCount > 0;

  return (
    <div
      role="row"
      aria-rowindex={renderIndex + 2}
      className="pgrid__row pgrid__group"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <span role="gridcell" className="pgrid__cell pgrid__group-cell">
        {onSetExcluded ? (
          <input
            type="checkbox"
            className="checkbox"
            checked={all}
            ref={(node) => { if (node) node.indeterminate = some; }}
            onChange={() => onSetExcluded(header.rowIds, all)}
            onKeyDown={(event) => {
              // `useListKeyboard` preventDefaults Space on the window, or j/k
              // would die the moment focus left the grid. A checkbox inside the
              // grid is the one place that costs something.
              if (event.key === ' ') event.stopPropagation();
            }}
            aria-label={
              all
                ? `Exclude every file under ${header.titleLabel}`
                : `Include every file under ${header.titleLabel}`
            }
          />
        ) : null}
        <span className="pgrid__group-title">{header.titleLabel}</span>
        <span className="pgrid__group-meta mono">
          {header.includedCount === header.count
            ? `${header.count} file${header.count === 1 ? '' : 's'}`
            : `${header.includedCount} of ${header.count} included`}
        </span>
        <span className="pgrid__group-instance">{header.instanceLabel}</span>
      </span>
    </div>
  );
}

interface RowProps {
  row: RenamePlanRow;
  mode: GridMode;
  flatIndex: number;
  renderIndex: number;
  offset: number;
  isCursor: boolean;
  isOpen: boolean;
  editable: boolean;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  onSetExcluded?: (rowIds: string[], excluded: boolean) => void;
}

function Row({
  row, mode, flatIndex, renderIndex, offset, isCursor, isOpen, editable,
  onCursorChange, onOpen, onSetExcluded,
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const status = rowStatus(row, mode);

  useEffect(() => {
    if (!isCursor) return;
    const node = ref.current;
    if (!node) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && node.parentElement?.contains(active)) node.focus();
  }, [isCursor]);

  return (
    <div
      ref={ref}
      role="row"
      aria-rowindex={renderIndex + 2}
      aria-selected={editable ? !row.excluded : undefined}
      tabIndex={isCursor ? 0 : -1}
      className={[
        'pgrid__row pgrid__body-row',
        isCursor ? 'is-cursor' : '',
        isOpen ? 'is-open' : '',
        row.excluded ? 'is-excluded' : '',
      ].filter(Boolean).join(' ')}
      style={{ transform: `translateY(${offset}px)` }}
      onClick={() => { onCursorChange(flatIndex); onOpen(flatIndex); }}
    >
      <span
        role="gridcell"
        className="pgrid__cell pgrid__cell--check"
        onClick={(e) => e.stopPropagation()}
      >
        {onSetExcluded ? (
          <input
            type="checkbox"
            className="checkbox"
            checked={!row.excluded}
            onChange={() => onSetExcluded([row.id], !row.excluded)}
            aria-label={`Include ${row.existingPath} in this plan`}
            tabIndex={-1}
          />
        ) : null}
      </span>

      <span role="gridcell" className="pgrid__cell pgrid__cell--path">
        <DiffCell existingPath={row.existingPath} proposedPath={row.proposedPath} />
      </span>

      <span role="gridcell" className="pgrid__cell pcol-warn">
        {row.warnings.length === 0 ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">no flags</span>
          </>
        ) : (
          row.warnings.map((warning) => (
            <span
              key={warning}
              className="pgrid__flag"
              // ADR-9: named as helparr's own reading everywhere it appears,
              // including the hover text, which is the form most operators
              // will actually meet.
              title={`helparr’s reading — ${WARNING_COPY[warning].detail}`}
            >
              <Icon name="alert" size={11} />
              <span className="pgrid__flag-label">{WARNING_COPY[warning].label}</span>
            </span>
          ))
        )}
      </span>

      <span role="gridcell" className="pgrid__cell pcol-status">
        <StatusBadge tone={status.tone} icon={status.icon}>
          <span aria-hidden="true">{status.label}</span>
          <span className="sr-only">{status.spoken}</span>
        </StatusBadge>
      </span>
    </div>
  );
}
