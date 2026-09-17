'use client';

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties,
} from 'react';

import type { Gap } from '@/lib/types';

/**
 * The virtualized, grouped gaps grid (REQ-GAPS-004, -005, NFR6; T13).
 *
 * The hard part is that **grouping is presentational while navigation is flat**.
 * The grid is handed one flat array; the series headings are derived at render
 * time and injected as extra rows the cursor cannot land on:
 *
 * ```
 * gaps       = [ g0, g1, g2, g3, g4 ]              ← the cursor indexes this
 * renderRows = [ HDR, g0, g1, g2, HDR, g3, g4 ]    ← the virtualizer measures this
 * ```
 *
 * Keeping the two apart is what makes `j` from the last row of one group land on
 * the first row of the next — never on a heading, and never skipping a gap.
 * Anything that indexes the wrong array is a silent off-by-one that only shows
 * up at a group boundary.
 *
 * Inherited from the queue and search grids, and as easy to lose here:
 * **one tab stop** (the roving `tabindex`), and **true `aria-rowindex`** — each
 * rendered row reports its position in the whole list, not in the window.
 */

const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 30;
/** A row is a tap target, so 36px would put the whole grid under 44px (NFR7). */
const TOUCH_ROW_HEIGHT = 48;
const TOUCH_HEADER_HEIGHT = 36;
const TOUCH_QUERY = '(max-width: 767px)';
/**
 * When the season button stacks onto its own line — and it is deliberately the
 * *union* of the two conditions that make it necessary, not one of them. A
 * narrow window needs the stack for width; a coarse pointer needs it for the
 * 44px target `globals.css` already gives `.btn-sm` there (NFR7). A tablet is
 * wide and coarse; a narrow desktop window is the reverse. Either alone is
 * enough to make a 30px header too short for the control inside it.
 */
const STACK_QUERY = '(max-width: 767px), (pointer: coarse)';
/** Title line, then a 44px button, plus the cell's own vertical padding. */
const STACKED_HEADER_HEIGHT = 88;
const OVERSCAN = 12;

/** Subscribed, not measured — a rotation must re-lay the grid out. */
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

/**
 * One season the group is missing something from, and how much.
 *
 * `missing` is helparr's own row count — how many gaps are listed under this
 * heading for that season — and nothing more. It is not "N of M": the total
 * episode count belongs to Sonarr and arrives with the pre-flight, so claiming a
 * denominator here would be inventing one.
 */
export interface SeasonTally {
  season: number;
  missing: number;
}

type HeaderRow = {
  type: 'header';
  key: string;
  groupTitle: string;
  instanceLabel: string;
  /** Radarr headers carry no season action — a film has no season (NFR4). */
  instanceKind: Gap['instanceKind'];
  count: number;
  /**
   * Any gap in the group, used as the group's handle: the season attach is
   * addressed by gap id, and every gap here names the same series on the same
   * instance. The first one is as good as the last.
   */
  anchor: Gap;
  /** The seasons this group is actually missing something from, ascending. */
  seasons: SeasonTally[];
};

type RenderRow =
  | HeaderRow
  | { type: 'gap'; key: string; gap: Gap; flatIndex: number };

/**
 * One pass over the flat list. A heading is emitted whenever the group changes,
 * keyed by instance *and* title: two Sonarrs can both hold a series called
 * `Reacher`, and merging them would put rows under a heading naming the wrong
 * instance.
 *
 * The input order decides the grouping — this does not sort. A list that is not
 * grouped by series would produce a heading per row, which is the honest render
 * of that ordering rather than a silent regroup.
 */
export function buildRenderRows(gaps: Gap[]): RenderRow[] {
  const rows: RenderRow[] = [];
  let groupKey: string | null = null;
  let header: HeaderRow | null = null;

  gaps.forEach((gap, flatIndex) => {
    const key = `${gap.instanceId}:${gap.groupTitle}`;
    if (key !== groupKey) {
      groupKey = key;
      header = {
        type: 'header',
        key: `hdr:${key}:${gap.id}`,
        groupTitle: gap.groupTitle,
        instanceLabel: gap.instanceLabel,
        instanceKind: gap.instanceKind,
        count: 0,
        anchor: gap,
        seasons: [],
      };
      rows.push(header);
    }
    // Counted as the group is built rather than by a second grouping pass, so
    // the number in the heading cannot disagree with the rows beneath it.
    if (header) {
      header.count += 1;
      // The chooser offers the seasons the operator can see are missing
      // something, and only those. A season Sonarr never reported a number for
      // is left out rather than guessed at from the item code.
      if (gap.seasonNumber !== null) {
        const tally = header.seasons.find((entry) => entry.season === gap.seasonNumber);
        if (tally) tally.missing += 1;
        else header.seasons.push({ season: gap.seasonNumber, missing: 1 });
      }
    }
    rows.push({ type: 'gap', key: gap.id, gap, flatIndex });
  });

  // Sorted rather than trusted: the list arrives ordered by season already, but
  // the chooser's order is a promise to the operator and the grouping pass makes
  // no such guarantee.
  rows.forEach((row) => {
    if (row.type === 'header') row.seasons.sort((a, b) => a.season - b.season);
  });

  return rows;
}

/**
 * Does this heading get the season button? Sonarr only (NFR4), and only when
 * there is a season to offer — a group whose gaps carry no season number has
 * nothing to put in the chooser.
 */
export function hasSeasonAction(row: HeaderRow): boolean {
  return row.instanceKind === 'sonarr' && row.seasons.length > 0;
}

interface Column {
  label: string;
  /** Read instead of the label when the label is an abbreviation. */
  fullLabel?: string;
  /** Attached to the header cell — the em-dash column needs one (ADR-5). */
  description?: string;
  className?: string;
}

const COLUMNS: Column[] = [
  { label: 'Item', className: 'gcol-code' },
  { label: 'Title' },
  { label: 'Aired', className: 'gcol-aired' },
  { label: 'Wanted', className: 'gcol-wanted' },
  {
    label: 'Last srch',
    fullLabel: 'Last searched',
    description: 'Sonarr does not report search state, so Sonarr rows show an em dash.',
    className: 'gcol-search',
  },
];

export interface GapsGridProps {
  gaps: Gap[];
  cursor: number;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  /** The id of the gap the inspector is showing, if any. */
  openGapId: string | null;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** Selects or clears every gap currently listed — never the unfiltered set. */
  onToggleAll: () => void;
  /**
   * Opens the season confirmation for a series group (ADR-6). Omitted, the
   * heading is the inert label it has always been.
   */
  onAttachSeason?: (anchor: Gap, seasons: SeasonTally[]) => void;
  loading?: boolean;
}

export default function GapsGrid({
  gaps,
  cursor,
  onCursorChange,
  onOpen,
  openGapId,
  selected,
  onToggleSelect,
  onToggleAll,
  onAttachSeason,
  loading = false,
}: GapsGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const touch = useMediaMatch(TOUCH_QUERY);
  const stacked = useMediaMatch(STACK_QUERY);
  const rowHeight = touch ? TOUCH_ROW_HEIGHT : ROW_HEIGHT;
  const headerHeight = touch ? TOUCH_HEADER_HEIGHT : HEADER_HEIGHT;
  // Only the headings that actually carry a button grow. A Radarr group in the
  // same list keeps the height it had (NFR4).
  const actionHeaderHeight = onAttachSeason !== undefined && stacked
    ? STACKED_HEADER_HEIGHT
    : headerHeight;

  const rows = useMemo(() => buildRenderRows(gaps), [gaps]);

  // Flat index → render index. The cursor speaks flat; the virtualizer speaks
  // render; this is the only translation between them, so it is the only place
  // the two can drift.
  const renderIndexOf = useMemo(() => {
    const map = new Int32Array(gaps.length);
    rows.forEach((row, index) => {
      if (row.type === 'gap') map[row.flatIndex] = index;
    });
    return map;
  }, [rows, gaps.length]);

  const cursorRenderRef = useRef(0);
  cursorRenderRef.current = gaps.length > 0 ? renderIndexOf[Math.min(cursor, gaps.length - 1)] : 0;

  // Keep the cursor row rendered even when scrolled out of view — otherwise the
  // grid loses its only tab stop the moment the operator scrolls with a mouse,
  // and Tab skips the grid entirely.
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = new Set(defaultRangeExtractor(range));
    indexes.add(cursorRenderRef.current);
    return [...indexes].sort((a, b) => a - b);
  }, []);

  const estimateSize = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row?.type !== 'header') return rowHeight;
      return hasSeasonAction(row) ? actionHeaderHeight : headerHeight;
    },
    [rows, headerHeight, actionHeaderHeight, rowHeight],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  // `auto` leaves the row where it is when it is already on screen, so clicking
  // a row does not yank the viewport out from under the pointer.
  useEffect(() => {
    if (gaps.length > 0) virtualizer.scrollToIndex(cursorRenderRef.current, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, gaps.length, rows.length]);

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // The resolved height is handed back to CSS as a local override of the global
  // `--row-height` token, so the painted row and the positioned row are the same
  // number by construction rather than by two definitions agreeing.
  const style = useMemo(
    () => ({
      padding: 0,
      overflow: 'hidden',
      '--row-height': `${rowHeight}px`,
      '--group-height': `${headerHeight}px`,
      '--group-action-height': `${actionHeaderHeight}px`,
    } as CSSProperties),
    [rowHeight, headerHeight, actionHeaderHeight],
  );

  const allSelected = gaps.length > 0 && gaps.every((gap) => selected.has(gap.id));
  const someSelected = !allSelected && gaps.some((gap) => selected.has(gap.id));

  return (
    <div
      className="ggrid card"
      role="grid"
      aria-label="Monitored items with no file"
      aria-multiselectable="true"
      aria-rowcount={rows.length + 1}
      aria-busy={loading || undefined}
      style={style}
    >
      <div className="ggrid__row ggrid__head" role="row" aria-rowindex={1}>
        <span role="columnheader" className="ggrid__cell ggrid__cell--check">
          <input
            type="checkbox"
            className="checkbox"
            checked={allSelected}
            // Neither checked nor unchecked is true of a partial selection, and
            // rendering it as unchecked would make "select all" the only way to
            // find out what it would do.
            ref={(node) => { if (node) node.indeterminate = someSelected; }}
            onChange={onToggleAll}
            aria-label={allSelected ? 'Clear the selection' : 'Select every listed gap'}
            disabled={gaps.length === 0}
          />
        </span>
        {COLUMNS.map((column) => (
          <span
            key={column.label}
            role="columnheader"
            className={`ggrid__cell ${column.className ?? ''}`}
            title={column.description}
          >
            {column.fullLabel ? (
              <>
                <span aria-hidden="true">{column.label}</span>
                <span className="sr-only">{column.fullLabel}</span>
              </>
            ) : column.label}
            {/* Spoken, not only hovered. The em dash in this column means
                "not reported", and a reader who never sees the tooltip would
                otherwise hear it as "never searched" (ADR-5). */}
            {column.description ? <span className="sr-only">. {column.description}</span> : null}
          </span>
        ))}
      </div>

      {loading ? (
        <div className="ggrid__loading" aria-hidden="true">
          {/* Headings are omitted: the grouping is unknown until the data is,
              and inventing one would move the rows once it arrives. */}
          {SKELETON_ROWS.map((width, index) => (
            <div className="ggrid__skeleton" key={index}>
              <span style={{ width }} />
            </div>
          ))}
        </div>
      ) : (
        <div
          className="ggrid__scroll"
          ref={scrollRef}
          // Stated, never derived. The scroll area is size-contained for paint
          // cost, so an `auto` height resolves to zero and the grid silently
          // renders no rows at all.
          style={{ height: Math.max(totalSize, rowHeight) }}
        >
          <div className="ggrid__canvas" style={{ height: totalSize }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              if (row.type === 'header') {
                return (
                  <GroupHeader
                    key={row.key}
                    row={row}
                    renderIndex={item.index}
                    offset={item.start}
                    onAttachSeason={onAttachSeason}
                  />
                );
              }
              return (
                <Row
                  key={row.key}
                  gap={row.gap}
                  flatIndex={row.flatIndex}
                  renderIndex={item.index}
                  offset={item.start}
                  isCursor={row.flatIndex === cursor}
                  isOpen={row.gap.id === openGapId}
                  isSelected={selected.has(row.gap.id)}
                  onCursorChange={onCursorChange}
                  onOpen={onOpen}
                  onToggleSelect={onToggleSelect}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const SKELETON_ROWS = ['62%', '48%', '71%', '39%', '56%', '44%', '66%', '51%'];

/**
 * Still not a cursor stop (REQ-GAPS-005, ADR-6). The heading has one focusable
 * control now, and that is the whole extent of the change: no `tabindex` on the
 * row, no click handler on the row, nothing `j`/`k` can land on. The button is
 * reached by `Tab` like any other control, which is why no key had to be bound
 * in `useListKeyboard` — a binding there would exist on Queue, Search and
 * Activity too.
 */
function GroupHeader({
  row,
  renderIndex,
  offset,
  onAttachSeason,
}: {
  row: HeaderRow;
  renderIndex: number;
  offset: number;
  onAttachSeason?: (anchor: Gap, seasons: SeasonTally[]) => void;
}) {
  const action = onAttachSeason !== undefined && hasSeasonAction(row);

  return (
    <div
      role="row"
      aria-rowindex={renderIndex + 2}
      className={`ggrid__row ggrid__group${action ? ' ggrid__group--action' : ''}`}
      style={{ transform: `translateY(${offset}px)` }}
    >
      <span role="gridcell" className="ggrid__cell ggrid__group-cell">
        <span className="ggrid__group-title">{row.groupTitle}</span>
        <span className="ggrid__group-meta">
          {row.count} missing
        </span>
        <span className="ggrid__group-instance">{row.instanceLabel}</span>
        {action ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm ggrid__group-action"
            // Named, because a list of these reads as a column of identical
            // buttons otherwise — and the series is the only thing that tells
            // one from the next.
            aria-label={`Attach a season pack to ${row.groupTitle}`}
            // `useListKeyboard` is bound to the window and `preventDefault`s
            // Enter and Space — it has to be, or `j`/`k`/Space would go inert
            // the moment focus left the grid. A button *inside* the grid is the
            // one place that costs something: the layer would swallow the two
            // keys that press it and leave this mouse-only. Stopped here rather
            // than excluded there, because the chips outside the grid keep
            // their current behaviour — Space after clicking one still selects
            // rows (NFR7).
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }}
            onClick={() => onAttachSeason(row.anchor, row.seasons)}
          >
            Attach season pack
          </button>
        ) : null}
      </span>
    </div>
  );
}

interface RowProps {
  gap: Gap;
  flatIndex: number;
  renderIndex: number;
  offset: number;
  isCursor: boolean;
  isOpen: boolean;
  isSelected: boolean;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  onToggleSelect: (id: string) => void;
}

function Row({
  gap,
  flatIndex,
  renderIndex,
  offset,
  isCursor,
  isOpen,
  isSelected,
  onCursorChange,
  onOpen,
  onToggleSelect,
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Move DOM focus with the cursor, but only when focus is already inside the
  // grid. Stealing it otherwise would drag the operator out of the filter field
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
      // The index in the whole rendered list, headings included — what is on
      // screen at position N is what "row N" has to mean.
      aria-rowindex={renderIndex + 2}
      aria-selected={isSelected}
      tabIndex={isCursor ? 0 : -1}
      className={[
        'ggrid__row ggrid__body-row',
        isCursor ? 'is-cursor' : '',
        isOpen ? 'is-open' : '',
        isSelected ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ transform: `translateY(${offset}px)` }}
      onClick={() => { onCursorChange(flatIndex); onOpen(flatIndex); }}
    >
      <span
        role="gridcell"
        className="ggrid__cell ggrid__cell--check"
        // Selecting is not opening. Without this a click aimed at the checkbox
        // also opens the inspector, which is the wrong action in a list whose
        // bulk operation spends indexer quota.
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          className="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(gap.id)}
          aria-label={`Select ${gap.groupTitle} ${gap.itemCode}`}
          tabIndex={-1}
        />
      </span>
      <span role="gridcell" className="ggrid__cell gcol-code mono">{gap.itemCode}</span>
      <span role="gridcell" className="ggrid__cell" title={gap.title}>{gap.title}</span>
      <span role="gridcell" className="ggrid__cell gcol-aired mono">
        {formatAirDate(gap.airDate)}
      </span>
      <span role="gridcell" className="ggrid__cell gcol-wanted mono" title={gap.wantedQuality ?? undefined}>
        {gap.wantedQuality ?? '—'}
      </span>
      <span role="gridcell" className="ggrid__cell gcol-search mono">
        {gap.lastSearchAt === null ? (
          <>
            <span aria-hidden="true">—</span>
            {/* The dash is a statement about the data, not about the item, and
                Sonarr and Radarr differ in what it can mean here. */}
            <span className="sr-only">
              {gap.instanceKind === 'sonarr'
                ? 'not reported by Sonarr'
                : 'never searched'}
            </span>
          </>
        ) : formatSearchAge(gap.lastSearchAt)}
      </span>
    </div>
  );
}

/** ISO date only. A missing air date is a fact about the record, not a zero. */
export function formatAirDate(iso: string | null): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '—' : new Date(at).toISOString().slice(0, 10);
}

/**
 * Coarse, and past tense. The column answers "has anything looked for this
 * lately", which a day-level answer settles.
 */
export function formatSearchAge(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const hours = Math.max(0, (now - at) / 3_600_000);
  if (hours < 1) return '<1h ago';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}
