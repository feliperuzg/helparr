'use client';

import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import AttachDialog from '@/components/gaps/AttachDialog';
import BulkSearchDialog from '@/components/gaps/BulkSearchDialog';
import GapInspector from '@/components/gaps/GapInspector';
import GapsGrid, { type SeasonTally } from '@/components/gaps/GapsGrid';
import SeasonAttachDialog from '@/components/gaps/SeasonAttachDialog';
import {
  useAttachGap, useAttachSeason, useBulkSearch, useGapsList,
} from '@/components/gaps/useGaps';
import Icon from '@/components/Icon';
import DegradedBanner from '@/components/queue/DegradedBanner';
import { useListKeyboard, useSelection } from '@/components/useListKeyboard';
import {
  BulkBar, Callout, ChipGroup, EmptyState, FilterChip, KeyboardHints, ScreenHead, SearchField,
  ToastStack, useToasts,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatAge } from '@/lib/queue';
import type { Gap, GrabOutcome } from '@/lib/types';

/**
 * The gaps screen (REQ-GAPS-001…-017; FR1…FR9, FR16; T17).
 *
 * The assembly is thin — grid renders, inspector explains, dialogs confirm — and
 * four decisions live here and nowhere else:
 *
 * 1. **Nothing reads on its own past the first paint.** A gaps read is a
 *    *library-scale* read of Sonarr and Radarr. There is no poll, no refetch on
 *    focus; freshness is the Refresh button (REQ-GAPS-016).
 * 2. **The count the operator sees is the count the bulk action sends.**
 *    `N of M shown` updates on every keystroke, the selection is narrowed to
 *    what is listed, and the dialog is handed that exact array (REQ-GAPS-008).
 * 3. **Both writes are confirmed, never fired from a row.** Row → inspector →
 *    dialog → confirm, for the attach and for the search alike (D7).
 * 4. **Nothing is optimistic.** A gap stays listed after an accepted attach:
 *    only a later library read can say the file now exists (REQ-GAPS-011).
 *
 * The season attach (FR1..FR10) is a fifth dialog under the same four rules. It
 * is opened from a group header rather than from a row, which is the only thing
 * that makes it different from here: same confirm-then-write, same
 * closes-on-response, same keyboard suppression while it is up.
 */

const HINTS: Array<[string[], string]> = [
  [['/'], 'filter'],
  [['j', 'k'], 'move'],
  [['space'], 'select'],
  [['enter'], 'inspect'],
  [['esc'], 'close'],
  [['?'], 'all shortcuts'],
];

type Scope = 'all' | 'sonarr' | 'radarr';

/** Series title, item code and episode/film title — the three things typed. */
function matches(gap: Gap, needle: string): boolean {
  if (needle === '') return true;
  const q = needle.toLowerCase();
  return gap.groupTitle.toLowerCase().includes(q)
    || gap.itemCode.toLowerCase().includes(q)
    || gap.title.toLowerCase().includes(q);
}

export default function GapsScreen() {
  const { toasts, push } = useToasts();
  const searchRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<Gap | null>(null);
  // The anchor gap and the seasons its group is missing, captured when the
  // header button was pressed — not re-derived while the dialog is up.
  const [seasonAttach, setSeasonAttach] = useState<
    { gap: Gap; seasons: SeasonTally[] } | null
  >(null);
  const [searching, setSearching] = useState<Gap[] | null>(null);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set());

  const gapsList = useGapsList();
  const attach = useAttachGap();
  const attachSeason = useAttachSeason();
  const bulkSearch = useBulkSearch();
  const { selected, toggle, clear, reconcile } = useSelection();

  const gaps = useMemo(() => gapsList.data?.gaps ?? [], [gapsList.data]);

  const visible = useMemo(
    () => gaps.filter((gap) => (
      (scope === 'all' || gap.instanceKind === scope) && matches(gap, query.trim())
    )),
    [gaps, scope, query],
  );

  // Selection is keyed on the composite gap id, so it survives a refetch — but
  // an id that vanished from the library read must not keep being counted by a
  // bulk bar whose command would then name nothing.
  const presentIds = useMemo(() => new Set(gaps.map((gap) => gap.id)), [gaps]);
  useEffect(() => { reconcile(presentIds); }, [presentIds, reconcile]);

  // Derived, not synced: the panel shows the open gap only while it is still
  // listed, so a filter that excludes it closes it with no effect needed.
  const openGap = openId ? visible.find((gap) => gap.id === openId) ?? null : null;

  const narrow = useCallback((next: string) => {
    setQuery(next);
    setOpenId(null);
    // A confirmation whose subject can move underneath it is not a
    // confirmation. Re-scoping silently would be worse than closing.
    setSearching(null);
    setSeasonAttach(null);
  }, []);

  const onOpen = useCallback((index: number) => {
    setOpenId(visible[index]?.id ?? null);
  }, [visible]);

  const onToggleIndex = useCallback((index: number) => {
    const gap = visible[index];
    if (gap) toggle(gap.id);
  }, [visible, toggle]);

  // Selects or clears exactly what is listed — never the unfiltered set, which
  // is the whole point of narrowing before a quota-spending command.
  const toggleAll = useCallback(() => {
    const allOn = visible.length > 0 && visible.every((gap) => selected.has(gap.id));
    if (allOn) { clear(); return; }
    visible.forEach((gap) => { if (!selected.has(gap.id)) toggle(gap.id); });
  }, [visible, selected, clear, toggle]);

  const onEscape = useCallback(() => {
    if (openId === null) return false;
    setOpenId(null);
    return true;
  }, [openId]);

  const { cursor, setCursor } = useListKeyboard({
    count: visible.length,
    onToggleSelect: onToggleIndex,
    onOpen,
    onEscape,
    onClearSelection: clear,
    searchRef,
    // A dialog owns the keyboard while it is up: j/k moving a cursor behind a
    // confirmation is how the wrong item gets attached.
    enabled: attaching === null && searching === null && seasonAttach === null,
  });

  const errors = gapsList.data?.errors ?? [];
  const lastReadAt = gapsList.data?.lastReadAt ?? {};
  const totalFailure = gaps.length === 0 && errors.length > 0;

  const retry = useMutation({
    mutationFn: (instanceId: string) => api.retryInstance(instanceId),
    onMutate: (instanceId) => { setRetrying((s) => new Set(s).add(instanceId)); },
    onSuccess: (_data, instanceId) => {
      const label = errors.find((e) => e.instanceId === instanceId)?.instanceLabel ?? instanceId;
      push(`${label} will be contacted on the next read.`, 'ok');
      void gapsList.refresh();
    },
    onError: (error) => {
      push(error instanceof ApiError ? error.message : 'Could not force a retry.', 'error');
    },
    onSettled: (_data, _error, instanceId) => {
      setRetrying((s) => { const next = new Set(s); next.delete(instanceId); return next; });
    },
  });

  const selectedGaps = useMemo(
    () => visible.filter((gap) => selected.has(gap.id)),
    [visible, selected],
  );

  /**
   * One report for both attaches. The scope differs; what the instance said
   * about it does not, and two copies of this would drift on the next change to
   * the rejection wording.
   */
  function reportAttach(instanceLabel: string, outcome: GrabOutcome) {
    if (outcome.status === 'succeeded') {
      push(
        `Attached to ${instanceLabel}`
          + (outcome.entityRef ? ` — will import as ${outcome.entityRef}` : ''),
        'ok',
      );
    } else if (outcome.rejected) {
      // The count here, the reasons verbatim in the operation log. A toast
      // that disappears in four seconds is the wrong place for text the
      // operator has to read carefully (REQ-GAPS-013).
      const n = outcome.rejections.length;
      push(
        `${instanceLabel} declined the release`
          + ` — ${n} reason${n === 1 ? '' : 's'}. See Activity.`,
        'warn',
      );
    } else {
      push(
        `${instanceLabel} — ${outcome.detail ?? 'the attach failed'}. See Activity.`,
        'error',
      );
    }
  }

  function confirmAttach(link: string) {
    const gap = attaching;
    if (!gap) return;

    attach.mutate({ gapId: gap.id, link }, {
      onSuccess: (outcome) => {
        // The dialog closes on the response and the outcome arrives here —
        // never the other way round (FR8, REQ-GAPS-011).
        setAttaching(null);
        reportAttach(gap.instanceLabel, outcome);
      },
      // helparr itself failed, so no operation was logged and the dialog stays
      // up: the operator can retry the same confirmation.
      onError: (error) => {
        push(error instanceof ApiError ? error.message : 'The attach did not complete.', 'error');
      },
    });
  }

  function confirmSeasonAttach(season: number, link: string) {
    const target = seasonAttach;
    if (!target) return;

    attachSeason.mutate({ gapId: target.gap.id, season, link }, {
      onSuccess: (outcome) => {
        setSeasonAttach(null);
        reportAttach(target.gap.instanceLabel, outcome);
      },
      onError: (error) => {
        push(error instanceof ApiError ? error.message : 'The attach did not complete.', 'error');
      },
    });
  }

  function confirmSearch() {
    const targets = searching ?? [];
    if (targets.length === 0) return;

    bulkSearch.mutate(targets.map((gap) => gap.id), {
      onSuccess: (outcomes) => {
        setSearching(null);
        // One line per instance, never one verdict for the batch: "queued" when
        // the second instance refused is the report being wrong about the one
        // thing it exists to report.
        outcomes.forEach((outcome) => {
          if (outcome.status === 'queued') {
            push(
              `${outcome.instanceLabel} queued a search for ${outcome.count}`
                + ` item${outcome.count === 1 ? '' : 's'}.`,
              'ok',
            );
          } else {
            push(`${outcome.instanceLabel} — ${outcome.reason ?? 'the command failed'}`, 'error');
          }
        });
        clear();
      },
      onError: (error) => {
        setSearching(null);
        push(error instanceof ApiError ? error.message : 'The search did not complete.', 'error');
      },
    });
  }

  const counts = useMemo(() => ({
    all: gaps.length,
    sonarr: gaps.filter((gap) => gap.instanceKind === 'sonarr').length,
    radarr: gaps.filter((gap) => gap.instanceKind === 'radarr').length,
  }), [gaps]);

  // The oldest cached series join across instances — the honest number, because
  // it is the one that bounds how stale the screen can be.
  const oldestSeriesRead = useMemo(() => {
    const stamps = Object.values(gapsList.data?.seriesReadAt ?? {}).sort();
    return stamps[0] ?? null;
  }, [gapsList.data]);

  return (
    <main className={`main${openGap ? ' has-inspector' : ''}`} id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Gaps"
          sub="Everything monitored with no file, across Sonarr and Radarr."
          actions={(
            <>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                // Forced: the point of this button is to bypass the cached
                // series join, not to re-serve it (ADR-4, REQ-GAPS-016).
                onClick={() => { void gapsList.refresh({ force: true }); }}
                disabled={gapsList.isFetching}
                title={
                  oldestSeriesRead
                    ? `Series list ${formatAge(oldestSeriesRead)}`
                    : 'No series list cached yet'
                }
              >
                <Icon name="refresh" size={12} />
                {gapsList.isFetching ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={toggleAll}
                disabled={visible.length === 0}
              >
                {visible.length > 0 && visible.every((gap) => selected.has(gap.id))
                  ? 'Clear selection'
                  : 'Select all'}
              </button>
            </>
          )}
        />

        <div className="toolbar">
          <SearchField
            inputRef={searchRef}
            value={query}
            onChange={narrow}
            label="Filter the gaps"
            placeholder="Filter by series, code or title…"
          />
        </div>

        <div className="toolbar">
          <ChipGroup label="Source">
            {(['all', 'sonarr', 'radarr'] as const).map((option) => (
              <FilterChip
                key={option}
                label={option === 'all' ? 'All' : option === 'sonarr' ? 'Sonarr' : 'Radarr'}
                selected={scope === option}
                count={counts[option]}
                onToggle={() => {
                  setScope(option);
                  setOpenId(null);
                  setSearching(null);
                  setSeasonAttach(null);
                }}
              />
            ))}
          </ChipGroup>
          <span className="toolbar__spacer" />
          {/* The number the bulk action will act on, updated on every keystroke
              — so "Search 5 gaps" can be checked against it before it is
              pressed (D8). */}
          <span className="subtle" style={{ fontSize: 12 }} role="status">
            {visible.length} of {gaps.length} shown
          </span>
        </div>

        <div className="content__scroll">
          {errors.length > 0 && !totalFailure ? (
            <section className="section">
              <DegradedBanner
                errors={errors}
                lastReadAt={lastReadAt}
                shownRows={gaps.length}
                onRetry={retry.mutate}
                retrying={retrying}
              />
            </section>
          ) : null}

          <section className="section">
            {gapsList.isPending ? (
              <GapsGrid
                gaps={[]}
                cursor={0}
                onCursorChange={setCursor}
                onOpen={onOpen}
                openGapId={null}
                selected={selected}
                onToggleSelect={toggle}
                onToggleAll={toggleAll}
                loading
              />
            ) : gapsList.isError ? (
              <Callout tone="error">
                {gapsList.error instanceof ApiError
                  ? gapsList.error.message
                  : 'Could not read the library.'}
              </Callout>
            ) : totalFailure ? (
              // The total-failure branch of REQ-GAPS-015. Each instance is named
              // with its own reason — "no instance answered" without saying
              // which, or why, costs the operator the trip to find out.
              <EmptyState title="No instance answered">
                <ul className="msg-list" style={{ textAlign: 'left' }}>
                  {errors.map((error) => (
                    <li key={error.instanceId}>{error.instanceLabel} — {error.reason}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginTop: 'var(--space-4)' }}
                  onClick={() => { void gapsList.refresh({ force: true }); }}
                >
                  <Icon name="refresh" size={12} />Retry
                </button>
              </EmptyState>
            ) : visible.length === 0 ? (
              <NothingMissing query={query.trim()} scope={scope} />
            ) : (
              <GapsGrid
                gaps={visible}
                cursor={cursor}
                onCursorChange={setCursor}
                onOpen={onOpen}
                openGapId={openGap?.id ?? null}
                selected={selected}
                onToggleSelect={toggle}
                onToggleAll={toggleAll}
                onAttachSeason={(gap, seasons) => setSeasonAttach({ gap, seasons })}
              />
            )}
          </section>

          <section className="section">
            <KeyboardHints items={HINTS} />
          </section>
        </div>

        <BulkBar count={selectedGaps.length} noun="gap" onClear={clear}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            // Opens the confirmation. It never issues the command directly —
            // every search spends indexer quota (D7, REQ-GAPS-009).
            onClick={() => setSearching(selectedGaps)}
            disabled={bulkSearch.isPending}
          >
            <Icon name="search" size={12} />Search automatically
          </button>
        </BulkBar>
      </div>

      {openGap ? (
        <GapInspector
          gap={openGap}
          onClose={() => setOpenId(null)}
          onAttach={() => setAttaching(openGap)}
          onSearch={() => setSearching([openGap])}
        />
      ) : null}

      {attaching ? (
        <AttachDialog
          gap={attaching}
          busy={attach.isPending}
          onCancel={() => setAttaching(null)}
          onConfirm={confirmAttach}
        />
      ) : null}

      {seasonAttach ? (
        <SeasonAttachDialog
          gap={seasonAttach.gap}
          seasons={seasonAttach.seasons}
          busy={attachSeason.isPending}
          onCancel={() => setSeasonAttach(null)}
          onConfirm={confirmSeasonAttach}
        />
      ) : null}

      {searching ? (
        <BulkSearchDialog
          gaps={searching}
          busy={bulkSearch.isPending}
          onCancel={() => setSearching(null)}
          onConfirm={confirmSearch}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </main>
  );
}


/**
 * The empty states, and the second sentence of the unfiltered one is
 * load-bearing (REQ-GAPS-003).
 *
 * Measured on live hardware: a naive `monitored && !hasFile` filter found two
 * films, one of them `status: announced` with no cinema, digital or physical
 * release date. helparr excludes those, and says so here — otherwise the
 * operator concludes helparr missed them.
 */
function NothingMissing({ query, scope }: { query: string; scope: Scope }) {
  // A typed filter that matches nothing is the operator's doing, and saying
  // "no gaps" there would read as a claim about the library.
  if (query !== '') {
    return (
      <EmptyState title="Nothing matches that filter">
        No missing item mentions &ldquo;{query}&rdquo;. Clear the filter to see everything.
      </EmptyState>
    );
  }

  const where = scope === 'all' ? '' : ` on ${scope === 'sonarr' ? 'Sonarr' : 'Radarr'}`;

  return (
    <EmptyState title={`No gaps${where}`}>
      Every monitored, released {scopeNoun(scope)} already has a file.
      {' '}
      {scope === 'sonarr' ? null : (
        <>
          Films that have been announced but not yet released are not listed — there is nothing to
          search for yet.
        </>
      )}
    </EmptyState>
  );
}

function scopeNoun(scope: Scope): string {
  if (scope === 'sonarr') return 'episode';
  if (scope === 'radarr') return 'film';
  return 'episode and film';
}
