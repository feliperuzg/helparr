'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';

import GrabDialog from '@/components/search/GrabDialog';
import ReleaseInspector from '@/components/search/ReleaseInspector';
import ResultsGrid, { DEFAULT_SORT, sortReleases, type Sort } from '@/components/search/ResultsGrid';
import SavedSearches from '@/components/search/SavedSearches';
import { IndexerErrorBanner, OutageCallout, TruncationNotice } from '@/components/search/SearchBanners';
import SearchToolbar from '@/components/search/SearchToolbar';
import {
  DEFAULT_CRITERIA,
  useDeleteSavedSearch,
  useGrab,
  useIndexers,
  useRenameSavedSearch,
  useSaveSearch,
  useSavedSearches,
  useSearch,
} from '@/components/search/useSearch';
import { useListKeyboard } from '@/components/useListKeyboard';
import {
  Callout, EmptyState, KeyboardHints, ScreenHead, ToastStack, useToasts,
} from '@/components/ui';
import { api, ApiError, type GrabInput } from '@/lib/api';
import { describeUnresolved, resolveSavedScope } from '@/lib/savedSearch';
import { SEARCH_RESULT_CAP } from '@/lib/types';
import type {
  IndexerRead, ReleaseRead, SavedScopeResolution, SavedSearchRead,
  SearchAvailability, SearchCriteria,
} from '@/lib/types';

/**
 * The search screen (REQ-SEARCH-001…-010, FR1…FR9, FR13, FR14; T19).
 *
 * The assembly is deliberately thin — the toolbar drafts, the grid renders, the
 * inspector explains and the dialog confirms — but three decisions live here and
 * nowhere else:
 *
 * 1. **The screen never searches on its own.** There is no mount query, no
 *    refetch on focus, no interval. Every indexer behind Prowlarr has a daily
 *    limit, and a screen that re-queries on navigation spends it (NFR1,
 *    REQ-SEARCH-009).
 * 2. **An outage disables this screen and nothing else.** Prowlarr being
 *    unreachable is a 200 describing a state, so it renders as a callout above
 *    an inert toolbar rather than as a thrown error (REQ-SEARCH-008, ADR-9).
 * 3. **The grab is confirmed here, not in the grid.** No results row carries a
 *    grab affordance: the path to a write runs row → inspector → dialog →
 *    confirm, and each step is a deliberate act (FR7).
 */

const HINTS: Array<[string[], string]> = [
  [['/'], 'focus search'],
  [['j', 'k'], 'move'],
  [['enter'], 'inspect'],
  [['esc'], 'close'],
];

export default function SearchScreen({ initialQuery = '' }: { initialQuery?: string } = {}) {
  const { toasts, push } = useToasts();
  const queryRef = useRef<HTMLInputElement>(null);

  // Seeded once, deliberately. A link from the gaps inspector arrives with the
  // item already typed — but rule 1 above still holds, so it is typed and not
  // run. The operator presses Search, exactly as if they had typed it.
  const [draft, setDraft] = useState<SearchCriteria>(
    () => (initialQuery ? { ...DEFAULT_CRITERIA, query: initialQuery } : DEFAULT_CRITERIA),
  );
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [openGuid, setOpenGuid] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<ReleaseRead | null>(null);

  // Which saved search the toolbar is currently showing. Cleared the moment the
  // draft is edited: once the query or the scope differs from what was stored,
  // the toolbar is no longer that saved search, and leaving it selected would
  // let Search re-run the stored definition instead of what is on screen.
  const [savedId, setSavedId] = useState<string | null>(null);

  const indexers = useIndexers();
  const search = useSearch();
  const grab = useGrab();

  const saved = useSavedSearches();
  const saveSearch = useSaveSearch();
  const renameSaved = useRenameSavedSearch();
  const deleteSaved = useDeleteSavedSearch();

  // The same key the shell polls, so the destination roster in the dialog and
  // the health badges in the sidebar can never disagree.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });

  // Only the two kinds that can accept a release. A download client has no
  // notion of "what this release belongs to", and Prowlarr is the source.
  const destinations = useMemo(
    () => (health.data?.instances ?? []).filter((i) => i.kind === 'sonarr' || i.kind === 'radarr'),
    [health.data],
  );

  const read = search.data?.available ? search.data : undefined;

  /**
   * Prowlarr is unreachable. Either read can discover it — the roster call on
   * mount, or the search itself — and the later answer wins, because a search
   * that just failed is more current than a roster that succeeded a minute ago.
   */
  const outage: SearchAvailability | null =
    search.data && !search.data.available
      ? search.data
      : indexers.data && !indexers.data.available
        ? indexers.data
        : null;

  // Memoized rather than defaulted inline: the saved-search resolution depends
  // on it, and a fresh `[]` every render would re-resolve on every keystroke.
  const roster = useMemo(() => indexers.data?.indexers ?? EMPTY_ROSTER, [indexers.data]);

  const indexerErrors = useMemo(() => {
    const byId: Record<number, string> = {};
    for (const error of read?.errors ?? []) byId[error.indexerId] = error.reason;
    return byId;
  }, [read]);

  // Sorting is local and total: the server orders by seeders so the cap cuts
  // the right end, but every re-sort after that is over results already held.
  const visible = useMemo(() => sortReleases(search.results, sort), [search.results, sort]);

  const openRelease = openGuid ? visible.find((r) => r.guid === openGuid) ?? null : null;

  const onOpen = useCallback((index: number) => {
    setOpenGuid(visible[index]?.guid ?? null);
  }, [visible]);

  // One Escape does one thing. With no multi-select on this screen, closing the
  // inspector is the only thing it has to do.
  const onEscape = useCallback(() => {
    if (openGuid === null) return false;
    setOpenGuid(null);
    return true;
  }, [openGuid]);

  const { cursor, setCursor } = useListKeyboard({
    count: visible.length,
    onOpen,
    onEscape,
    searchRef: queryRef,
    // The confirmation owns the keyboard while it is up: j/k moving a cursor
    // behind a dialog is how the wrong release gets grabbed.
    enabled: grabbing === null,
  });

  const savedSearches = saved.data ?? EMPTY_SAVED;
  const selectedSaved = savedId
    ? savedSearches.find((s) => s.id === savedId) ?? null
    : null;

  /**
   * What the selected saved search means against the roster in hand.
   *
   * The server's own resolution wins once a run has produced one, because it
   * was computed against a roster read at run time rather than on mount — but
   * only while it still describes *this* saved search. Selecting a different
   * one falls back to the local resolution until it is run.
   */
  const savedResolution = useMemo(() => {
    if (!selectedSaved) return null;
    if (search.resolution && search.submittedSavedId === selectedSaved.id) {
      return search.resolution;
    }
    // Before the first run there is nothing to resolve against but the roster
    // the chips were drawn from. While Prowlarr is unreachable that roster is
    // empty, and claiming every reference is gone on that basis would be a
    // fabrication — so nothing is claimed until it answers again.
    if (!indexers.data?.available) return null;
    return resolveSavedScope(selectedSaved, roster);
  }, [selectedSaved, search.resolution, search.submittedSavedId, indexers.data, roster]);

  /**
   * Editing the toolbar detaches it from the saved search it was filled from.
   * Anything else would let Search re-run a stored definition that no longer
   * matches what the operator is looking at.
   */
  const changeDraft = useCallback((next: SearchCriteria) => {
    setDraft(next);
    setSavedId(null);
  }, []);

  /** Restores a definition. Deliberately runs nothing (REQ-SEARCH-012). */
  const selectSaved = useCallback((entry: SavedSearchRead) => {
    const resolution = indexers.data?.available
      ? resolveSavedScope(entry, indexers.data.indexers)
      : null;

    setDraft({
      query: entry.query,
      // The resolved ids when the roster is known, the saved ones when it is
      // not: a chip for an indexer that has since gone is better than silently
      // dropping the scope to "all" behind the operator's back.
      indexerIds: resolution ? resolution.criteria.indexerIds : entry.indexers.map((r) => r.indexerId),
      categories: entry.categories,
      minSeeders: entry.minSeeders,
    });
    search.setMinSeeders(entry.minSeeders);
    setSavedId(entry.id);
    setOpenGuid(null);
  }, [indexers.data, search]);

  const submit = useCallback(() => {
    // A new search invalidates the panel: the open release belongs to the
    // previous result set and may not be in this one.
    setOpenGuid(null);
    const criteria = { ...draft, query: draft.query.trim() };
    // A saved search runs through its own route so the scope is re-resolved
    // server-side against the roster as it is *now* — the ids in the draft were
    // resolved when it was selected, which may have been a while ago (ADR-6).
    if (savedId !== null) search.runSaved(savedId, criteria);
    else search.run(criteria);
  }, [draft, savedId, search]);

  const retry = useCallback(() => {
    void indexers.refetch();
    search.retry();
  }, [indexers, search]);

  const saveCurrent = useCallback((name: string) => {
    saveSearch.mutate(
      {
        name,
        query: draft.query.trim(),
        // Names as well as ids, from the roster the chips were drawn from. The
        // server cannot re-derive these later — by the time it would matter,
        // the indexer is gone (ADR-6, REQ-SEARCH-014).
        indexers: draft.indexerIds.map((id) => ({
          indexerId: id,
          name: roster.find((indexer) => indexer.id === id)?.name ?? `Indexer ${id}`,
        })),
        categories: draft.categories,
        minSeeders: search.minSeeders,
      },
      {
        onSuccess: (entry) => {
          setSavedId(entry.id);
          push(`Saved as "${entry.name}".`, 'ok');
        },
        onError: (error) => push(
          error instanceof ApiError ? error.message : 'The search was not saved.',
          'error',
        ),
      },
    );
  }, [draft, roster, search.minSeeders, saveSearch, push]);

  const renameCurrent = useCallback((id: string, name: string) => {
    renameSaved.mutate({ id, name }, {
      onSuccess: (entry) => push(`Renamed to "${entry.name}".`, 'ok'),
      onError: (error) => push(
        error instanceof ApiError ? error.message : 'The rename did not go through.',
        'error',
      ),
    });
  }, [renameSaved, push]);

  const deleteCurrent = useCallback((entry: SavedSearchRead) => {
    deleteSaved.mutate(entry.id, {
      onSuccess: () => {
        // The toolbar keeps whatever is in it — the operator deleted a
        // shortcut, not the search they are in the middle of.
        setSavedId(null);
        push(`Deleted "${entry.name}".`, 'ok');
      },
      onError: (error) => push(
        error instanceof ApiError ? error.message : 'The saved search was not deleted.',
        'error',
      ),
    });
  }, [deleteSaved, push]);

  function confirmGrab(input: GrabInput) {
    grab.mutate(input, {
      onSuccess: (outcome) => {
        // The dialog closes on the response and the outcome arrives here —
        // never the other way round (FR8, REQ-OPS-006).
        setGrabbing(null);
        const label = destinations.find((d) => d.instanceId === input.instanceId)?.label
          ?? 'the instance';
        if (outcome.status === 'succeeded') {
          push(`Grabbed into ${label}${outcome.entityRef ? ` — ${outcome.entityRef}` : ''}`, 'ok');
        } else if (outcome.rejected) {
          // The count, not the reasons: a toast that vanishes in four seconds
          // is no place for text the operator has to read carefully. The
          // reasons are written verbatim to the operation log, which is where
          // Activity shows them (REQ-SEARCH-006).
          const n = outcome.rejections.length;
          push(`${label} declined the release — ${n} reason${n === 1 ? '' : 's'}. See Activity.`, 'warn');
        } else {
          push(`${label} — ${outcome.detail ?? 'the grab failed'}. See Activity.`, 'error');
        }
      },
      onError: (error) => {
        // helparr itself failed, so no operation was logged and the dialog
        // stays up: the operator can retry the same confirmation.
        push(error instanceof ApiError ? error.message : 'The grab did not complete.', 'error');
      },
    });
  }

  const searching = search.isFetching;
  const answered = read ? `${read.indexersAnswered} of ${read.indexersQueried} indexers answered` : '';

  /**
   * A saved run that came back without a search at all.
   *
   * Every indexer the saved scope named is gone, so nothing was asked of
   * Prowlarr. The alternative — dropping the scope to an empty list — reads as
   * *every* indexer to the search route (ADR-1), which is the opposite of what
   * was saved. So it is refused, and the refusal is a state with its own words
   * rather than an empty result set the operator would read as "nothing found".
   */
  const refused = !searching
    && search.error === null
    && search.data === undefined
    && search.resolution !== null
    && !search.resolution.runnable;

  return (
    <main className={`main${openRelease ? ' has-inspector' : ''}`} id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Indexer Search"
          sub="Free-text across every indexer Prowlarr manages. helparr searches only when you ask — indexers have daily limits."
        />

        {outage ? (
          <section className="section">
            <OutageCallout outage={outage} onRetry={retry} retrying={indexers.isFetching || searching} />
          </section>
        ) : null}

        <SearchToolbar
          draft={draft}
          onDraftChange={changeDraft}
          onSubmit={submit}
          indexers={roster}
          indexerErrors={indexerErrors}
          // A scope that has gone entirely stale makes Search a request the
          // server is going to refuse — so it is refused here, next to the
          // sentence that says why, instead of costing a round trip to find out.
          disabled={outage !== null || savedResolution?.runnable === false}
          isFetching={searching}
          minSeeders={search.minSeeders}
          onMinSeedersChange={search.setMinSeeders}
          queryRef={queryRef}
        />

        <SavedSearches
          searches={savedSearches}
          selectedId={savedId}
          resolution={savedResolution}
          onSelect={selectSaved}
          onSave={saveCurrent}
          onRename={renameCurrent}
          onDelete={deleteCurrent}
          // Saving needs a query; it does not need Prowlarr. A definition is
          // stored verbatim and resolved at run time (ADR-6), so an outage is
          // no reason to refuse to write one down.
          canSave={draft.query.trim().length > 0}
          busy={saveSearch.isPending || renameSaved.isPending || deleteSaved.isPending}
        />

        <div className="content__scroll">
          {read && read.errors.length > 0 ? (
            <section className="section">
              <IndexerErrorBanner
                errors={read.errors}
                roster={roster}
                shown={visible.length}
                answered={read.indexersAnswered}
                queried={read.indexersQueried}
                onRetry={search.retry}
                retrying={searching}
              />
            </section>
          ) : null}

          {read?.truncated ? (
            <section className="section">
              <TruncationNotice cap={SEARCH_RESULT_CAP} />
            </section>
          ) : null}

          <section className="section" aria-busy={searching || undefined}>
            {/* Rendered in every state, because a live region inserted along
                with its content announces nothing. It carries the two moments
                a sighted operator reads off the button and the heading: the
                search starting, and what came back (NFR5). */}
            <p className="sr-only" role="status">
              {searching
                ? 'Searching your indexers…'
                : read
                  ? `${visible.length} result${visible.length === 1 ? '' : 's'} · ${answered}`
                  : ''}
            </p>

            {read ? (
              <h2 className="section__title">
                {visible.length} result{visible.length === 1 ? '' : 's'}
                <span className="subtle" style={{ fontWeight: 400 }}>· {answered}</span>
                {search.hiddenBySeeders > 0 ? (
                  <span className="subtle" style={{ fontWeight: 400 }}>
                    · {search.hiddenBySeeders} below the seeder threshold
                  </span>
                ) : null}
              </h2>
            ) : null}

            {search.error ? (
              <Callout tone="error">
                {search.error instanceof ApiError
                  ? search.error.message
                  : 'The search did not complete.'}
              </Callout>
            ) : searching ? (
              <ResultsSkeleton />
            ) : refused ? (
              <EmptyState title="This search was not run">
                {/* The same sentence the callout above the results carries, so
                    the operator reads one explanation and not two that have to
                    be reconciled (REQ-SEARCH-014). */}
                {describeUnresolved(search.resolution as SavedScopeResolution)}
                {' '}Pick different indexers in the toolbar and search again, or delete the
                saved search.
              </EmptyState>
            ) : search.submitted === null ? (
              <EmptyState title="Search your indexers">
                Type a query and press Search. helparr never searches on its own — every indexer
                behind Prowlarr has a daily limit.
              </EmptyState>
            ) : visible.length === 0 ? (
              <EmptyState title={`No results for "${search.submitted.query}"`}>
                {answered ? `${answered}. ` : ''}
                Try a broader query
                {search.minSeeders > 0 ? ', clear the seeder filter' : ''}
                {' '}or widen the indexer scope.
              </EmptyState>
            ) : (
              <ResultsGrid
                results={visible}
                cursor={cursor}
                onCursorChange={setCursor}
                onOpen={onOpen}
                openGuid={openGuid}
                sort={sort}
                onSortChange={setSort}
              />
            )}
          </section>

          <section className="section">
            <KeyboardHints items={HINTS} />
          </section>
        </div>
      </div>

      {openRelease ? (
        <ReleaseInspector
          release={openRelease}
          destinations={destinations}
          onClose={() => setOpenGuid(null)}
          onGrab={() => setGrabbing(openRelease)}
        />
      ) : null}

      {grabbing ? (
        <GrabDialog
          release={grabbing}
          destinations={destinations}
          busy={grab.isPending}
          onCancel={() => setGrabbing(null)}
          onConfirm={confirmGrab}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </main>
  );
}

/** Stable, so "no saved searches yet" is not a new identity on every render. */
const EMPTY_SAVED: SavedSearchRead[] = [];
const EMPTY_ROSTER: IndexerRead[] = [];

/** Shown only while a search the operator asked for is in flight. */
function ResultsSkeleton() {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }} aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div className="qgrid__skeleton" key={i}>
          <span style={{ width: `${[54, 71, 48, 66, 59, 44, 63, 51][i]}%` }} />
        </div>
      ))}
    </div>
  );
}
