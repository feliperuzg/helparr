'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';

import GrabDialog from '@/components/search/GrabDialog';
import ReleaseInspector from '@/components/search/ReleaseInspector';
import ResultsGrid, { DEFAULT_SORT, sortReleases, type Sort } from '@/components/search/ResultsGrid';
import { IndexerErrorBanner, OutageCallout, TruncationNotice } from '@/components/search/SearchBanners';
import SearchToolbar from '@/components/search/SearchToolbar';
import { DEFAULT_CRITERIA, useGrab, useIndexers, useSearch } from '@/components/search/useSearch';
import { useListKeyboard } from '@/components/useListKeyboard';
import {
  Callout, EmptyState, KeyboardHints, ScreenHead, ToastStack, useToasts,
} from '@/components/ui';
import { api, ApiError, type GrabInput } from '@/lib/api';
import { SEARCH_RESULT_CAP } from '@/lib/types';
import type { ReleaseRead, SearchAvailability, SearchCriteria } from '@/lib/types';

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

export default function SearchScreen() {
  const { toasts, push } = useToasts();
  const queryRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<SearchCriteria>(DEFAULT_CRITERIA);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [openGuid, setOpenGuid] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<ReleaseRead | null>(null);

  const indexers = useIndexers();
  const search = useSearch();
  const grab = useGrab();

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

  const roster = indexers.data?.indexers ?? [];

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

  const submit = useCallback(() => {
    // A new search invalidates the panel: the open release belongs to the
    // previous result set and may not be in this one.
    setOpenGuid(null);
    search.run({ ...draft, query: draft.query.trim() });
  }, [draft, search]);

  const retry = useCallback(() => {
    void indexers.refetch();
    search.retry();
  }, [indexers, search]);

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
          onDraftChange={setDraft}
          onSubmit={submit}
          indexers={roster}
          indexerErrors={indexerErrors}
          disabled={outage !== null}
          isFetching={searching}
          minSeeders={search.minSeeders}
          onMinSeedersChange={search.setMinSeeders}
          queryRef={queryRef}
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
