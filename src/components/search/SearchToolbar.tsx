'use client';

import { useMemo, type FormEvent, type RefObject } from 'react';

import Icon from '@/components/Icon';
import { ChipGroup, FilterChip } from '@/components/ui';
import type { IndexerRead, SearchCriteria } from '@/lib/types';

/**
 * The search toolbar (REQ-SEARCH-001, -002, -007; FR2, FR3; T15).
 *
 * Nothing here searches on its own. The query field, the chips and the category
 * select all edit a draft; only Submit — the button or Enter in the field —
 * turns that draft into a request. That is the whole of NFR1 in one component:
 * every indexer this screen can reach has a daily limit, and a toolbar that
 * queried on change would spend it on keystrokes.
 *
 * The one exception is the seeder threshold, which is not part of the draft at
 * all. It filters results already in hand, so it applies immediately and is
 * wired straight through.
 */

/**
 * The *arr category ids, as Prowlarr uses them. Coarse on purpose: a full
 * category tree is a Prowlarr concern, and the only distinction this screen
 * needs is the one between "the TV thing I am looking for" and everything else.
 */
const CATEGORIES: Array<{ label: string; ids: number[] }> = [
  { label: 'Any category', ids: [] },
  { label: 'Movies', ids: [2000] },
  { label: 'TV', ids: [5000] },
  { label: 'Music', ids: [3000] },
  { label: 'Books', ids: [7000] },
];

export interface SearchToolbarProps {
  /** The draft. Owned by the screen so a submitted search survives edits to it. */
  draft: SearchCriteria;
  onDraftChange: (draft: SearchCriteria) => void;
  onSubmit: () => void;
  indexers: IndexerRead[];
  /** Named per indexer by the last search, so a chip can say why it is inert. */
  indexerErrors: Record<number, string>;
  /** Prowlarr itself is unreachable — the whole toolbar goes inert (NFR4). */
  disabled: boolean;
  isFetching: boolean;
  /** The live threshold. Applies to results already fetched; never re-queries. */
  minSeeders: number;
  onMinSeedersChange: (value: number) => void;
  queryRef?: RefObject<HTMLInputElement | null>;
}

export default function SearchToolbar({
  draft,
  onDraftChange,
  onSubmit,
  indexers,
  indexerErrors,
  disabled,
  isFetching,
  minSeeders,
  onMinSeedersChange,
  queryRef,
}: SearchToolbarProps) {
  const selected = useMemo(() => new Set(draft.indexerIds), [draft.indexerIds]);
  const canSubmit = !disabled && !isFetching && draft.query.trim().length > 0;

  // Empty means all, which is also what the route sends upstream (ADR-1). The
  // "All" chip is therefore a clear, not a select-everything: listing all ten
  // ids explicitly would break the moment Prowlarr gains an eleventh.
  const allSelected = draft.indexerIds.length === 0;

  function toggleIndexer(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onDraftChange({ ...draft, indexerIds: [...next] });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmit) onSubmit();
  }

  const categoryValue = draft.categories.length === 0 ? '' : String(draft.categories[0]);

  return (
    <form className="stoolbar" onSubmit={submit} aria-label="Indexer search">
      <div className="stoolbar__query">
        <div className="search">
          <Icon name="search" size={13} />
          <label className="sr-only" htmlFor="search-query">
            What to search your indexers for
          </label>
          <input
            id="search-query"
            ref={queryRef}
            className="input mono"
            // `search` rather than `text` so the browser offers its own clear
            // control; `type=search` inside a form still submits on Enter.
            type="search"
            value={draft.query}
            placeholder="reacher s04"
            maxLength={512}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            onChange={(e) => onDraftChange({ ...draft, query: e.target.value })}
          />
          <span className="search__kbd"><kbd className="kbd">/</kbd></span>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit} aria-disabled={!canSubmit || undefined}>
          <Icon name="search" size={12} />
          {isFetching ? 'Searching…' : 'Search'}
        </button>
      </div>

      <div className="stoolbar__row">
        <span className="stoolbar__label">Indexers</span>
        <ChipGroup label="Indexers to search">
          <FilterChip
            label="All"
            selected={allSelected}
            onToggle={() => onDraftChange({ ...draft, indexerIds: [] })}
          />
          {indexers.map((indexer) => (
            <FilterChip
              key={indexer.id}
              label={indexer.name}
              selected={selected.has(indexer.id)}
              onToggle={() => toggleIndexer(indexer.id)}
              // Prowlarr's own backoff and this search's failures are the same
              // thing from here: an indexer that will not answer cannot be
              // scoped to. It stays visible and focusable so the reason is
              // reachable (FilterChip uses `aria-disabled`, not `disabled`).
              degraded={!indexer.healthy || indexerErrors[indexer.id] !== undefined}
              degradedReason={
                indexerErrors[indexer.id]
                ?? (indexer.healthy ? undefined : `${indexer.name} is currently failing in Prowlarr.`)
              }
            />
          ))}
        </ChipGroup>
      </div>

      <div className="stoolbar__row">
        <label className="stoolbar__label" htmlFor="search-category">Category</label>
        <select
          id="search-category"
          className="input stoolbar__select"
          value={categoryValue}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          onChange={(e) => onDraftChange({
            ...draft,
            categories: e.target.value === ''
              ? []
              : CATEGORIES.find((c) => String(c.ids[0]) === e.target.value)?.ids ?? [],
          })}
        >
          {CATEGORIES.map((category) => (
            <option key={category.label} value={category.ids[0] ?? ''}>
              {category.label}
            </option>
          ))}
        </select>

        <label className="stoolbar__label" htmlFor="search-min-seeders">Min seeders</label>
        <input
          id="search-min-seeders"
          className="input mono stoolbar__seeders"
          type="number"
          min={0}
          max={100000}
          step={1}
          value={minSeeders}
          // Deliberately not disabled by an outage: it filters what is already
          // on screen, and results from before Prowlarr went down are still
          // worth narrowing.
          onChange={(e) => {
            const parsed = Number(e.target.value);
            onMinSeedersChange(Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0);
          }}
        />
      </div>
    </form>
  );
}
