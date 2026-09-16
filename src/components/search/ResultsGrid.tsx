'use client';

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties,
} from 'react';

import { formatBytes } from '@/lib/queue';
import type { ReleaseRead } from '@/lib/types';

/**
 * The virtualized results grid (REQ-SEARCH-003, -004, NFR6; T14).
 *
 * Structurally the queue's grid without the multi-select column: search has no
 * bulk action, so there is no checkbox, no `aria-multiselectable`, and no row
 * that can be "selected" without being opened. The three properties that carry
 * the weight are the same ones, and are as easy to lose silently:
 *
 * 1. **One tab stop.** Tab from above lands on exactly one row; Tab again
 *    leaves the grid. Movement inside it is the roving `tabindex`.
 * 2. **True `aria-rowindex`.** Only the visible window is in the DOM, but each
 *    row reports its index in the *full* list — "row 287 of 300", not
 *    "row 12 of 40".
 * 3. **No grab affordance.** There is deliberately no per-row button here
 *    (FR7). A grab is reachable only from the inspector's confirmation, so a
 *    mis-aimed click in a 300-row list cannot hand a release to a download
 *    client.
 */

export const SORT_COLUMNS = ['title', 'indexer', 'size', 'seeders', 'leechers', 'age'] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];
export interface Sort { column: SortColumn; direction: 'asc' | 'desc' }

/** Seeders, descending — the only ordering that answers "which one will land". */
export const DEFAULT_SORT: Sort = { column: 'seeders', direction: 'desc' };

const ROW_HEIGHT = 34;
/**
 * Touch rows are taller because a row *is* the tap target here — opening the
 * inspector is the only thing a row does, so 34px would put the whole grid
 * under the 44px minimum on a phone (NFR7).
 *
 * The number lives in JS rather than only in CSS because the virtualizer
 * positions rows from it. A CSS-only override would leave every row painted at
 * one height and positioned at another.
 */
const TOUCH_ROW_HEIGHT = 46;
const TOUCH_QUERY = '(max-width: 767px)';
const OVERSCAN = 12;

/**
 * Subscribed rather than measured, so a rotation or a resize re-lays the grid
 * out instead of leaving it at the height it happened to mount with. The server
 * snapshot is `false`: SSR has no viewport, and guessing "phone" would make the
 * first paint jump on every desktop load.
 */
function useTouchRows(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(TOUCH_QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(TOUCH_QUERY).matches,
    () => false,
  );
}

interface Column {
  key: SortColumn;
  label: string;
  /** Read aloud instead of the label when the label is an abbreviation. */
  fullLabel?: string;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: 'title', label: 'Release' },
  { key: 'indexer', label: 'Indexer', className: 'rcol-indexer' },
  { key: 'size', label: 'Size', className: 'rcol-size rgrid__cell--num' },
  { key: 'seeders', label: 'See', fullLabel: 'Seeders', className: 'rcol-seeders rgrid__cell--num' },
  { key: 'leechers', label: 'Leech', fullLabel: 'Leechers', className: 'rcol-leechers rgrid__cell--num' },
  { key: 'age', label: 'Age', className: 'rcol-age rgrid__cell--num' },
];

export interface ResultsGridProps {
  results: ReleaseRead[];
  cursor: number;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  /** The guid of the release the inspector is showing, if any. */
  openGuid: string | null;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
}

export default function ResultsGrid({
  results,
  cursor,
  onCursorChange,
  onOpen,
  openGuid,
  sort,
  onSortChange,
}: ResultsGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const touch = useTouchRows();
  const rowHeight = touch ? TOUCH_ROW_HEIGHT : ROW_HEIGHT;

  // Keep the cursor row rendered even when it is scrolled out of view —
  // otherwise the grid loses its only tab stop the moment the operator scrolls
  // with the mouse, and Tab skips the grid entirely.
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    indexes.add(cursorRef.current);
    return [...indexes].sort((a, b) => a - b);
  }, []);

  const estimateSize = useCallback(() => rowHeight, [rowHeight]);

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  // `auto` leaves the row where it is when it is already on screen, so clicking
  // a row does not yank the viewport out from under the pointer.
  useEffect(() => {
    if (results.length > 0) virtualizer.scrollToIndex(cursor, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, results.length]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Hand the resolved height back to CSS as a local override of the global
  // `--row-height` token, so the painted row and the positioned row are the
  // same number by construction rather than by two definitions agreeing.
  const style = useMemo(
    () => ({ padding: 0, overflow: 'hidden', '--row-height': `${rowHeight}px` } as CSSProperties),
    [rowHeight],
  );

  function toggleSort(column: SortColumn) {
    onSortChange(
      sort.column === column
        ? { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        // Numbers start high: a first click on Seeders that showed the *fewest*
        // seeders first would be a sort nobody asked for.
        : { column, direction: NUMERIC.has(column) ? 'desc' : 'asc' },
    );
  }

  return (
    <div
      className="rgrid card"
      role="grid"
      aria-label="Releases returned by the selected indexers"
      aria-rowcount={results.length + 1}
      style={style}
    >
      <div className="rgrid__row rgrid__head" role="row" aria-rowindex={1}>
        {COLUMNS.map((column) => {
          const active = sort.column === column.key;
          return (
            <span
              key={column.key}
              role="columnheader"
              className={`rgrid__cell ${column.className ?? ''}`}
              // Every column here is sortable, so a column that is not the
              // current sort still reports `none` — omitting the attribute
              // would make AT announce it as unsortable.
              aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              <button
                type="button"
                className="rgrid__sort"
                onClick={() => toggleSort(column.key)}
              >
                {column.fullLabel ? (
                  <>
                    <span aria-hidden="true">{column.label}</span>
                    <span className="sr-only">{column.fullLabel}</span>
                  </>
                ) : column.label}
                {active ? (
                  <span className="sort-caret" aria-hidden="true">
                    {sort.direction === 'asc' ? '▲' : '▼'}
                  </span>
                ) : null}
              </button>
            </span>
          );
        })}
      </div>

      <div
        className="rgrid__scroll"
        ref={scrollRef}
        // Stated, never derived. The scroll area is size-contained for paint
        // cost, so an `auto` height resolves to zero, the virtualizer's visible
        // window comes back empty, and the grid renders no rows at all —
        // silently, because the header still looks right.
        style={{ height: Math.max(totalSize, rowHeight) }}
      >
        <div className="rgrid__canvas" style={{ height: totalSize }}>
          {items.map((item) => (
            <Row
              key={results[item.index].guid}
              release={results[item.index]}
              index={item.index}
              offset={item.start}
              isCursor={item.index === cursor}
              isOpen={results[item.index].guid === openGuid}
              onCursorChange={onCursorChange}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  release: ReleaseRead;
  index: number;
  offset: number;
  isCursor: boolean;
  isOpen: boolean;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
}

function Row({ release, index, offset, isCursor, isOpen, onCursorChange, onOpen }: RowProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Move DOM focus with the cursor, but only when focus is already inside the
  // grid. Stealing it otherwise would drag the operator out of the search field
  // on every keystroke that moved the cursor.
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
      // The index in the full list, not in the rendered window. This is the one
      // thing virtualization gets wrong by default.
      aria-rowindex={index + 2}
      tabIndex={isCursor ? 0 : -1}
      className={[
        'rgrid__row rgrid__body-row',
        isCursor ? 'is-cursor' : '',
        isOpen ? 'is-open' : '',
      ].filter(Boolean).join(' ')}
      style={{ transform: `translateY(${offset}px)` }}
      onClick={() => { onCursorChange(index); onOpen(index); }}
    >
      <span role="gridcell" className="rgrid__cell mono" title={release.title}>
        {release.title}
      </span>
      <span role="gridcell" className="rgrid__cell rcol-indexer" title={release.indexer}>
        {release.indexer}
        {/* A text badge, never a colour — freeleech has to survive a monochrome
            screen and a colour-blind reader (DESIGN.md §7, REQ-SEARCH-003). */}
        {release.freeleech ? (
          <span className="rgrid__flag" title="Freeleech — this release does not count against your ratio">
            FL
          </span>
        ) : null}
      </span>
      <span role="gridcell" className="rgrid__cell rcol-size rgrid__cell--num">
        {formatBytes(release.size)}
      </span>
      <span role="gridcell" className="rgrid__cell rcol-seeders rgrid__cell--num">
        {formatPeers(release.seeders)}
      </span>
      <span role="gridcell" className="rgrid__cell rcol-leechers rgrid__cell--num">
        {formatPeers(release.leechers)}
      </span>
      <span role="gridcell" className="rgrid__cell rcol-age rgrid__cell--num">
        {formatAgeHours(release.ageHours)}
      </span>
    </div>
  );
}

/**
 * Usenet has no seeders at all, which is not the same as having zero of them.
 * An em dash says "this number does not apply here"; a `0` would read as a
 * release nobody is carrying.
 */
export function formatPeers(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** Coarse on purpose: nobody grabs based on 37 vs 39 days. */
export function formatAgeHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return '<1h';
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

const NUMERIC = new Set<SortColumn>(['size', 'seeders', 'leechers', 'age']);

/**
 * Sorting is ours, not Prowlarr's.
 *
 * The merged set spans several indexers, each of which ordered its own answer
 * independently — so there is no upstream order to preserve, and the ordering
 * the operator sees has to be computed over the union or it means nothing.
 */
export function sortReleases(results: ReleaseRead[], sort: Sort): ReleaseRead[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...results].sort((a, b) => direction * compare(a, b, sort.column));
}

function compare(a: ReleaseRead, b: ReleaseRead, column: SortColumn): number {
  switch (column) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'indexer':
      return a.indexer.localeCompare(b.indexer) || a.title.localeCompare(b.title);
    case 'size':
      return a.size - b.size;
    // `null` sorts as -1 so usenet lands below every seeded torrent under the
    // default descending sort, rather than above everything as `0` would under
    // ascending and below nothing under descending.
    case 'seeders':
      return (a.seeders ?? -1) - (b.seeders ?? -1);
    case 'leechers':
      return (a.leechers ?? -1) - (b.leechers ?? -1);
    case 'age':
      return a.ageHours - b.ageHours;
    default:
      return 0;
  }
}
