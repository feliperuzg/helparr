'use client';

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import DecisionExplainer from '@/components/decisions/DecisionExplainer';
import { useExplain } from '@/components/decisions/useExplain';
import Icon from '@/components/Icon';
import { Callout, InspectorGroup, StatusBadge } from '@/components/ui';
import type { DecisionCandidate, DecisionsFailureKind } from '@/lib/api';
import type { DecisionTarget } from '@/lib/decisions';
import type { Gap } from '@/lib/types';

/**
 * Gaps' "Evaluate releases" (ADR-13, REQ-DEC-006; T20).
 *
 * A gap has no candidate release until an interactive search runs, and that
 * search is the instance's own — it fans out to every indexer the instance
 * has, and each of those may count it against a daily API quota. So:
 *
 * 1. **Nothing runs on open.** The inspector mounts this group with a button
 *    and the quota warning beside it. The warning stays on screen for every
 *    run, retries included — each press is another search, and the sentence
 *    saying so is visible before every press, not only the first.
 * 2. **Every release is listed, rejected ones first.** Each rejected release
 *    is a disclosure that mounts the shared `DecisionExplainer` only when
 *    expanded (`explainOnMount` is safe precisely because the expand is the
 *    operator's explicit act — never on mount of the list, NFR2).
 * 3. **A failed search names the instance and the reason**, and offers a retry
 *    that says it spends another search.
 *
 * The caller keys this component on the gap, so moving down the grid with j/k
 * drops the previous item's releases rather than showing them under the next
 * item's title.
 */

export interface EvaluateReleasesProps {
  gap: Gap;
}

/** What each failure kind means, phrased as what went wrong with the instance. */
const FAILURE_TEXT: Record<DecisionsFailureKind, string> = {
  unreachable: 'the instance did not answer',
  unauthorized: 'the instance refused helparr\'s API key',
  'upstream-error': 'the instance answered with an error',
  timeout: 'the search did not finish in time',
  'no-instance': 'the instance is no longer configured in helparr',
  'not-decisions-client': 'this kind of instance has no release search to evaluate',
};

/**
 * The item, file and profile the explainer compares a candidate against.
 *
 * Without a profile id the thresholds cannot be named, so the comparison is
 * declared unavailable (and says why) rather than run against an invented
 * profile. The verbatim rejections still render in full.
 *
 * `fileId` is always `null`: every gap comes from `wanted/missing`, so the item
 * has no file on disk by construction.
 */
function decisionTarget(gap: Gap): { target: DecisionTarget | null; unavailable?: string } {
  if (gap.profileId === null) {
    return {
      target: null,
      unavailable:
        `${gap.instanceLabel} reported no quality profile for this ${gap.kind}, and the `
        + `comparison is checked against that profile's thresholds.`,
    };
  }
  return {
    target: {
      ...(gap.kind === 'movie' ? { movieId: gap.upstreamId } : { episodeId: gap.upstreamId }),
      fileId: null,
      profileId: gap.profileId,
    },
  };
}

export default function EvaluateReleases({ gap }: EvaluateReleasesProps) {
  const { evaluate, evaluateResult, evaluating, evaluateError } = useExplain();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const listId = useId();

  const label = gap.instanceLabel;
  const hasRun = evaluating || evaluateResult !== undefined || evaluateError !== null;

  const run = () => {
    // `aria-disabled` rather than `disabled`, so the button keeps focus while
    // the search runs; the guard is therefore here.
    if (evaluating) return;
    setExpanded(new Set());
    const target = gap.kind === 'episode'
      ? { instanceId: gap.instanceId, episodeId: gap.upstreamId }
      : { instanceId: gap.instanceId, movieId: gap.upstreamId };
    evaluate(target)
      .catch(() => undefined) // kept in `evaluateError`, rendered below
      .finally(() => {
        // Only reclaim focus that was lost. An operator who tabbed elsewhere
        // during a minute-long search keeps their place.
        const active = document.activeElement;
        if (!active || active === document.body) summaryRef.current?.focus();
      });
  };

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const releases = evaluateResult?.ok ? evaluateResult.value : null;
  const rejected = releases?.filter((release) => release.rejections.length > 0) ?? [];
  const accepted = releases?.filter((release) => release.rejections.length === 0) ?? [];
  const { target, unavailable } = decisionTarget(gap);

  return (
    <InspectorGroup title={`Releases (from ${label})`}>
      <div style={STACK} aria-busy={evaluating}>
        <Callout tone="warn">
          <p>
            This runs {label}&apos;s own interactive search for this {gap.kind} against every
            indexer it has configured, and counts against any daily quota they enforce.
            {hasRun ? ' Running it again spends another search.' : ' Nothing is searched until you press the button.'}
          </p>
        </Callout>

        <div>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={run}
            onKeyDown={stopListKeys}
            aria-disabled={evaluating}
            aria-describedby={`${listId}-status`}
          >
            <Icon name={hasRun ? 'refresh' : 'search'} size={12} />
            {evaluating
              ? 'Evaluating…'
              : evaluateError || (evaluateResult && !evaluateResult.ok)
                ? 'Retry'
                : hasRun ? 'Evaluate again' : 'Evaluate releases'}
          </button>
        </div>

        {/* One polite region for the outcome, so a result is announced once —
            not the whole list read aloud as it lands. */}
        <p
          id={`${listId}-status`}
          ref={summaryRef}
          tabIndex={-1}
          role="status"
          className={hasRun ? 'subtle' : 'sr-only'}
          style={NOTE}
        >
          {evaluating
            ? `Asking ${label}… this runs a live search and can take a minute.`
            : evaluateError
              ? `The evaluate request did not complete.`
              : evaluateResult && !evaluateResult.ok
                ? `${label}'s search did not complete.`
                : releases
                  ? summarise(label, gap.kind, rejected.length, accepted.length)
                  : ''}
        </p>

        {evaluating ? null : evaluateError ? (
          <Callout tone="error">
            <p>
              The request to evaluate releases did not complete: {evaluateError.message}. No
              releases are shown. Retrying spends another search on {label}.
            </p>
          </Callout>
        ) : evaluateResult && !evaluateResult.ok ? (
          <Callout tone="error">
            <p>
              {label}&apos;s search did not complete — {FAILURE_TEXT[evaluateResult.error.kind]}.
              No releases are shown. Retrying spends another search.
            </p>
            <p className="mono" style={{ ...NOTE, marginTop: 'var(--space-2)', overflowWrap: 'anywhere' }}>
              {evaluateResult.error.reason}
            </p>
          </Callout>
        ) : releases ? (
          <>
            {rejected.length > 0 ? (
              <div>
                <h4 className="eyebrow" style={SUBHEAD}>Rejected releases ({rejected.length})</h4>
                <ul style={LIST} aria-label={`Releases ${label} rejected`}>
                  {rejected.map((release, i) => {
                    const key = rowKey(release, i);
                    const open = expanded.has(key);
                    const panelId = `${listId}-rejected-${i}`;
                    return (
                      <li key={key} style={ROW}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-expanded={open}
                          aria-controls={panelId}
                          onClick={() => toggle(key)}
                          onKeyDown={stopListKeys}
                          style={DISCLOSURE}
                        >
                          <Icon
                            name="chevronRight"
                            size={12}
                            style={{
                              flex: 'none',
                              marginTop: 'var(--space-1)',
                              transform: open ? 'rotate(90deg)' : 'none',
                              transition: 'transform var(--duration-fast) var(--ease-productive)',
                            }}
                          />
                          <ReleaseSummary release={release} />
                        </button>
                        {open ? (
                          <div id={panelId} style={PANEL}>
                            <DecisionExplainer
                              key={release.guid ?? release.title}
                              instanceId={gap.instanceId}
                              instanceLabel={label}
                              candidate={release}
                              target={target}
                              unavailable={unavailable}
                              explainOnMount
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {accepted.length > 0 ? (
              <div>
                <h4 className="eyebrow" style={SUBHEAD}>Would be accepted ({accepted.length})</h4>
                <ul style={LIST} aria-label={`Releases ${label} would accept`}>
                  {accepted.map((release, i) => (
                    <li key={rowKey(release, i)} style={{ ...ROW, padding: 'var(--space-2)' }}>
                      <ReleaseSummary release={release} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </InspectorGroup>
  );
}

/** Title, then indexer · quality · score · rejection count — the same order on every row. */
function ReleaseSummary({ release }: { release: DecisionCandidate }) {
  const count = release.rejections.length;
  return (
    <span style={SUMMARY}>
      <span className="mono" style={TITLE}>{release.title}</span>
      <span className="subtle" style={META}>
        <span className="mono">{release.indexer ?? 'indexer not reported'}</span>
        <span aria-hidden="true">·</span>
        <span className="mono">{release.quality?.quality.name ?? 'quality not reported'}</span>
        <span aria-hidden="true">·</span>
        {/* ADR-12: a candidate's score on a search result comes from its release
            name, and says so. Absent is stated in words, never as 0. */}
        <span>
          {release.customFormatScore === null
            ? 'CF score not reported'
            : <>CF score <span className="num">{release.customFormatScore}</span> (from release name)</>}
        </span>
        {count > 0 ? (
          <StatusBadge tone="warn">{count} rejection{count === 1 ? '' : 's'}</StatusBadge>
        ) : (
          <StatusBadge tone="ok">no rejections</StatusBadge>
        )}
      </span>
    </span>
  );
}

function summarise(label: string, kind: Gap['kind'], rejected: number, accepted: number): string {
  const total = rejected + accepted;
  if (total === 0) return `${label}'s search returned no releases for this ${kind}.`;
  return `${label} returned ${total} release${total === 1 ? '' : 's'} for this ${kind} — `
    + `${rejected} rejected, ${accepted} it would accept.`;
}

/**
 * Stable per row and unique even when two indexers list the same title with no
 * guid — expansion state must not open two rows at once.
 */
function rowKey(release: DecisionCandidate, index: number): string {
  return release.guid ?? `${index}:${release.indexer ?? ''}:${release.title}`;
}

/**
 * The gaps list's keyboard layer is bound to the window and claims Enter and
 * Space; stopped here so these buttons stay keyboard-operable inside the
 * inspector (same reason as GapsGrid's season button).
 */
function stopListKeys(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' };
const NOTE: CSSProperties = { fontSize: 'var(--text-sm)' };
const SUBHEAD: CSSProperties = { margin: '0 0 var(--space-2)' };
const LIST: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
};
const ROW: CSSProperties = {
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)',
  minWidth: 0,
};
// A full-width, left-aligned, wrapping row target — release names are long and
// must not be truncated, and the row clears the 44px touch target.
const DISCLOSURE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  height: 'auto',
  justifyContent: 'flex-start',
  alignItems: 'flex-start',
  textAlign: 'left',
  padding: 'var(--space-2)',
  fontWeight: 400,
  whiteSpace: 'normal',
  color: 'var(--color-foreground)',
};
const PANEL: CSSProperties = {
  padding: 'var(--space-3)',
  borderTop: '1px solid var(--color-border-subtle)',
};
const SUMMARY: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 };
const TITLE: CSSProperties = { fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' };
const META: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--space-1) var(--space-2)',
  fontSize: 'var(--text-xs)',
};
