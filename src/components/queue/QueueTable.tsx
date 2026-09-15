'use client';

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef } from 'react';

import { StatusBadge } from '@/components/ui';
import {
  STATE_ICON,
  STATE_LABEL,
  STATE_TONE,
  deriveState,
  etaOf,
  formatBytes,
  progressOf,
} from '@/lib/queue';
import type { QueueRecord } from '@/lib/types';

/**
 * The virtualized ARIA grid (REQ-QUEUE-016, ADR-6, ADR-7, T13 — deviation D4).
 *
 * Two properties carry the weight here and both are easy to lose silently:
 *
 * 1. **One tab stop.** Tab from above lands on exactly one row; Tab again
 *    leaves the grid. Movement inside it is the roving `tabindex`, never the
 *    browser's focus order.
 * 2. **True `aria-rowindex`.** Only the visible window is in the DOM, but each
 *    row reports its index in the *full* list, so a screen reader says "row 412
 *    of 5000" rather than "row 12 of 40". Invisible without a screen reader,
 *    which is why T24 asserts it.
 */

export const SORT_COLUMNS = ['state', 'title', 'target', 'progress', 'size', 'eta'] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];
export interface Sort { column: SortColumn; direction: 'asc' | 'desc' }

const ROW_HEIGHT = 34;
const OVERSCAN = 12;

interface Column {
  key: SortColumn | 'select' | 'peers';
  label: string;
  className?: string;
  sortable: boolean;
}

const COLUMNS: Column[] = [
  { key: 'select', label: 'Select', className: 'qgrid__cell--check', sortable: false },
  { key: 'state', label: 'State', sortable: true },
  { key: 'title', label: 'Release', sortable: true },
  { key: 'target', label: 'Target', className: 'qcol-target', sortable: true },
  { key: 'progress', label: 'Progress', className: 'qcol-progress', sortable: true },
  { key: 'size', label: 'Size', className: 'qcol-size qgrid__cell--num', sortable: true },
  { key: 'eta', label: 'ETA', className: 'qcol-eta qgrid__cell--num', sortable: true },
  { key: 'peers', label: 'Peers', className: 'qcol-peers qgrid__cell--num', sortable: false },
];

export interface QueueTableProps {
  records: QueueRecord[];
  cursor: number;
  onCursorChange: (index: number) => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (index: number) => void;
  pending: ReadonlySet<string>;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
}

export default function QueueTable({
  records,
  cursor,
  onCursorChange,
  selected,
  onToggleSelect,
  onOpen,
  pending,
  sort,
  onSortChange,
}: QueueTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  /**
   * Keep the cursor row rendered even when it is scrolled out of view. Without
   * this the grid loses its only tab stop the moment the operator scrolls with
   * the mouse, and Tab would then skip the grid entirely.
   */
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    indexes.add(cursorRef.current);
    return [...indexes].sort((a, b) => a - b);
  }, []);

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  // Follow the cursor, but only for keyboard-driven moves — `auto` leaves the
  // row where it is when it is already on screen, so clicking a row does not
  // yank the viewport.
  useEffect(() => {
    if (records.length > 0) virtualizer.scrollToIndex(cursor, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, records.length]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  function toggleSort(column: SortColumn) {
    onSortChange(
      sort.column === column
        ? { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  }

  return (
    <div
      className="qgrid card"
      style={{ padding: 0, overflow: 'hidden' }}
      role="grid"
      aria-label="In-flight grabs and imports across every connected instance"
      aria-rowcount={records.length + 1}
      aria-multiselectable="true"
    >
      <div className="qgrid__row qgrid__head" role="row" aria-rowindex={1}>
        {COLUMNS.map((column) => {
          const active = column.sortable && sort.column === column.key;
          return (
            <span
              key={column.key}
              role="columnheader"
              className={`qgrid__cell ${column.className ?? ''}`}
              // Every sortable column reports `none` when it is not the sort —
              // omitting the attribute would make AT announce it as unsortable.
              aria-sort={
                column.sortable
                  ? (active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none')
                  : undefined
              }
            >
              {column.key === 'select' ? (
                <span className="sr-only">{column.label}</span>
              ) : column.sortable ? (
                <button
                  type="button"
                  className="qgrid__sort"
                  onClick={() => toggleSort(column.key as SortColumn)}
                >
                  {column.label}
                  {active ? (
                    <span className="sort-caret" aria-hidden="true">
                      {sort.direction === 'asc' ? '▲' : '▼'}
                    </span>
                  ) : null}
                </button>
              ) : (
                column.label
              )}
            </span>
          );
        })}
      </div>

      <div
        className="qgrid__scroll"
        ref={scrollRef}
        // Stated, never derived. The scroll area is size-contained for paint
        // cost (see globals.css), so an `auto` height resolves to zero, the
        // virtualizer's visible window comes back empty, and the grid renders
        // no rows at all — silently, because the header still looks right.
        // CSS clamps this to the viewport; below the clamp the grid is exactly
        // as tall as its rows.
        style={{ height: Math.max(totalSize, ROW_HEIGHT) }}
      >
        <div className="qgrid__canvas" style={{ height: totalSize }}>
          {items.map((item) => (
            <Row
              key={records[item.index].id}
              record={records[item.index]}
              index={item.index}
              offset={item.start}
              isCursor={item.index === cursor}
              isSelected={selected.has(records[item.index].id)}
              isPending={pending.has(records[item.index].id)}
              onCursorChange={onCursorChange}
              onToggleSelect={onToggleSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  record: QueueRecord;
  index: number;
  offset: number;
  isCursor: boolean;
  isSelected: boolean;
  isPending: boolean;
  onCursorChange: (index: number) => void;
  onToggleSelect: (id: string) => void;
  onOpen: (index: number) => void;
}

function Row({
  record,
  index,
  offset,
  isCursor,
  isSelected,
  isPending,
  onCursorChange,
  onToggleSelect,
  onOpen,
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const state = deriveState(record);
  const progress = progressOf(record);
  const tone = STATE_TONE[state];

  // Move DOM focus with the cursor, but only when focus is already inside the
  // grid. Stealing it otherwise would drag the operator out of the search field
  // every time a keystroke moved the cursor.
  useEffect(() => {
    if (!isCursor) return;
    const node = ref.current;
    if (!node) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && node.parentElement?.contains(active)) node.focus();
  }, [isCursor]);

  const barTone = tone === 'warn' ? ' progress__bar--warn'
    : tone === 'error' ? ' progress__bar--error'
      : progress === 100 ? ' progress__bar--ok' : '';

  return (
    <div
      ref={ref}
      role="row"
      // The index in the full list, not in the rendered window. This is the one
      // thing virtualization gets wrong by default.
      aria-rowindex={index + 2}
      aria-selected={isSelected}
      tabIndex={isCursor ? 0 : -1}
      className={[
        'qgrid__row qgrid__body-row',
        isCursor ? 'is-cursor' : '',
        isSelected ? 'is-selected' : '',
        isPending ? 'is-pending' : '',
      ].filter(Boolean).join(' ')}
      style={{ transform: `translateY(${offset}px)` }}
      onClick={() => { onCursorChange(index); onOpen(index); }}
    >
      <span
        role="gridcell"
        className="qgrid__cell qgrid__cell--check"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          className="checkbox"
          checked={isSelected}
          disabled={isPending}
          onChange={() => onToggleSelect(record.id)}
          aria-label={`Select ${record.title}`}
          tabIndex={-1}
        />
      </span>
      <span role="gridcell" className="qgrid__cell">
        <StatusBadge tone={tone} icon={isPending ? 'clock' : STATE_ICON[state]}>
          {isPending ? 'Removing…' : STATE_LABEL[state]}
        </StatusBadge>
      </span>
      <span role="gridcell" className="qgrid__cell mono" title={record.title}>
        {record.title}
      </span>
      <span role="gridcell" className="qgrid__cell qcol-target" title={record.targetLabel}>
        {record.targetLabel}
      </span>
      <span role="gridcell" className="qgrid__cell qcol-progress">
        <div className="progress" title={`${progress}%`}>
          <div className={`progress__bar${barTone}`} style={{ width: `${progress}%` }} />
        </div>
        <span className="mono subtle">{progress}%</span>
      </span>
      <span role="gridcell" className="qgrid__cell qcol-size qgrid__cell--num">
        {formatBytes(record.size)}
      </span>
      <span role="gridcell" className="qgrid__cell qcol-eta qgrid__cell--num">
        {etaOf(record)}
      </span>
      <span role="gridcell" className="qgrid__cell qcol-peers qgrid__cell--num">
        {record.torrent ? `↑${record.torrent.numSeeds}` : '—'}
      </span>
    </div>
  );
}

/** Sorting is ours, never the upstream's (`plan.md`, Key Design Decisions). */
export function sortRecords(records: QueueRecord[], sort: Sort): QueueRecord[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => direction * compare(a, b, sort.column));
}

function compare(a: QueueRecord, b: QueueRecord, column: SortColumn): number {
  switch (column) {
    case 'state':
      return STATE_LABEL[deriveState(a)].localeCompare(STATE_LABEL[deriveState(b)]);
    case 'title':
      return a.title.localeCompare(b.title);
    case 'target':
      return a.targetLabel.localeCompare(b.targetLabel);
    case 'progress':
      return progressOf(a) - progressOf(b);
    case 'size':
      return a.size - b.size;
    case 'eta':
      return (a.torrent?.eta ?? Number.MAX_SAFE_INTEGER) - (b.torrent?.eta ?? Number.MAX_SAFE_INTEGER);
    default:
      return 0;
  }
}

/** Filtering is ours too — the upstream `status` filter returns everything when
 *  it matches nothing, which produces a view that is silently wrong. */
export function filterRecords(records: QueueRecord[], query: string): QueueRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return records;
  return records.filter((r) =>
    r.title.toLowerCase().includes(needle)
    || r.targetLabel.toLowerCase().includes(needle)
    || r.instanceLabel.toLowerCase().includes(needle)
    || (r.indexer?.toLowerCase().includes(needle) ?? false));
}
