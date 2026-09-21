'use client';

import Icon from '@/components/Icon';
import { formatAge } from '@/lib/queue';
import type { IndexerError, IndexerRead, SearchAvailability } from '@/lib/types';

/**
 * The three things a search can tell the operator besides results
 * (REQ-SEARCH-007, -008, ADR-8, ADR-9; T17).
 *
 * All three are the same principle applied at three scopes: a partial answer is
 * still an answer, and helparr says exactly which part is missing. "Some
 * indexers failed" is not acceptable for the same reason "some instances are
 * unavailable" was not on the overview — the operator's next action differs per
 * indexer, and a banner that hides which one costs them the trip to find out.
 */

/**
 * One line per indexer that did not answer (REQ-SEARCH-007).
 *
 * `role="status"` / `aria-live="polite"`: it announces itself when a search
 * comes back degraded, without stealing focus from the grid below it.
 */
export function IndexerErrorBanner({
  errors,
  roster,
  shown,
  answered,
  queried,
  onRetry,
  retrying,
}: {
  errors: IndexerError[];
  /**
   * The roster the toolbar already holds. An explicitly scoped search never
   * reads it server-side, so the error can arrive carrying an id and no name —
   * and "Indexer 9 did not respond" is a worse sentence than the one the chip
   * the operator just clicked is labelled with.
   */
  roster: IndexerRead[];
  shown: number;
  answered: number;
  queried: number;
  onRetry: () => void;
  retrying: boolean;
}) {
  // Absent entirely when every indexer answered — it reserves no layout space
  // in the healthy case.
  if (errors.length === 0) return null;

  return (
    <div className="callout callout--warn banner" role="status" aria-live="polite">
      <Icon name="alert" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {errors.map((error) => (
          <div key={error.indexerId} className="banner__line">
            <span>
              <strong>
                {roster.find((indexer) => indexer.id === error.indexerId)?.name ?? error.indexer}
              </strong>
              {` did not respond — ${error.reason}`}
            </span>
          </div>
        ))}
        <div className="banner__line" style={{ marginTop: 'var(--space-1)' }}>
          <span className="subtle">
            {/* The screen never blanks: whatever answered still renders. */}
            {shown} result{shown === 1 ? '' : 's'} from the {answered} of {queried} indexer
            {queried === 1 ? '' : 's'} that answered {answered === 1 ? 'is' : 'are'} shown below.
          </span>
          {/* One retry for the whole search, not one per indexer: re-running a
              single indexer would produce a second result set that has to be
              merged with the first, and the merge is the server's job. */}
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={retrying}
            onClick={onRetry}
          >
            <Icon name="refresh" size={12} />
            {retrying ? 'Retrying…' : 'Retry search'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Prowlarr itself could not be asked (REQ-SEARCH-008, NFR4).
 *
 * This is a 200 from helparr's own route, not an error — so it is rendered as a
 * state of the screen, with the reason and the last successful contact, rather
 * than as a failure toast that disappears before it is read. The last sentence
 * is load-bearing: this screen is down, the application is not.
 */
export function OutageCallout({
  outage,
  onRetry,
  retrying,
}: {
  outage: SearchAvailability;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="callout callout--error banner" role="status" aria-live="polite">
      <Icon name="alert" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>Search is unavailable</strong>
        <p style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>
          {outage.instanceLabel === null ? (
            <>
              No Prowlarr instance is configured. Prowlarr is the only path to an aggregate
              indexer search, so this screen cannot work without one.
            </>
          ) : (
            <>
              <strong>{outage.instanceLabel}</strong>
              {outage.baseUrl ? <span className="mono subtle"> ({outage.baseUrl})</span> : null}
              {' is unreachable'}
              {outage.reason ? ` — ${outage.reason}` : ''}
              {`, last seen ${formatAge(outage.lastSeen)}.`}
              {' Prowlarr is the only path to an aggregate indexer search, so this screen '}
              cannot work without it.
            </>
          )}
        </p>
        <p className="subtle" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>
          Other screens are unaffected.
        </p>
        <div className="banner__line" style={{ marginTop: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <a className="btn btn-outline btn-sm" href="/settings">
            <Icon name="settings" size={12} />Settings
          </a>
          <button type="button" className="btn btn-outline btn-sm" disabled={retrying} onClick={onRetry}>
            <Icon name="refresh" size={12} />
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * helparr's own ceiling cut the merged set (ADR-8, NFR6).
 *
 * Never silent. A capped list that does not say it is capped is a list the
 * operator will read as "that is everything", and the release they wanted is
 * the one that did not fit.
 */
export function TruncationNotice({ cap }: { cap: number }) {
  return (
    <div className="callout" role="status" aria-live="polite">
      <Icon name="info" size={14} />
      <div>
        Showing the first {cap} releases. Prowlarr accepts a result limit and then ignores it,
        so helparr caps the merged set itself. Narrow the query or scope to fewer indexers to
        see the rest.
      </div>
    </div>
  );
}
