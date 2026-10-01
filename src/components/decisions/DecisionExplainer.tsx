'use client';

import { useEffect, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import Icon from '@/components/Icon';
import { Callout, KV, StatusBadge, type Tone } from '@/components/ui';
import type { DecisionCandidate, ExplainFailureKind } from '@/lib/api';
import type {
  DecisionComparison,
  DecisionSide,
  DecisionTarget,
  VerdictKind,
} from '@/lib/decisions';
import { formatAge } from '@/lib/queue';

import { useExplain } from './useExplain';

/**
 * The decision explainer (REQ-DEC-001..008, REQ-SEARCH-006; ADR-10..ADR-14;
 * T18).
 *
 * One panel, three mount points — Search's `ReleaseInspector`, Queue's
 * `QueueInspector` (T19) and Gaps' `GapInspector` (T20) — so the same fields
 * land in the same arrangement wherever a verdict is explained (REQ-DEC-006).
 *
 * The order is the contract:
 *
 * 1. **The instance's own words, first and always.** Every rejection reason,
 *    verbatim, one per line — including when the comparison below cannot be
 *    built. Nothing here abbreviates or replaces them (REQ-DEC-001, -008).
 * 2. **The comparison, only where it has something to say.** A reason that
 *    concerns neither an existing file nor a score threshold gets no
 *    comparison section at all, not an empty one (REQ-DEC-001's second
 *    scenario).
 * 3. **Nothing is read until asked.** The explain call costs a config-cache
 *    read plus at most one file read, so it runs from a button — or on mount
 *    when the caller mounts this only after an explicit expand
 *    (`explainOnMount`). Never on mount of a list (NFR2, REQ-DEC-007).
 *
 * Callers should give the component a `key` that changes with the candidate
 * (its `guid` or `title`), so a reused inspector never shows the previous
 * row's comparison under the next row's reasons.
 */

export type { DecisionTarget };

export interface DecisionExplainerProps {
  /** The *arr instance whose decision engine produced the verdict. */
  instanceId: string;
  /** Human name for that instance, used in every sentence that attributes a number or a reason. */
  instanceLabel: string;
  /**
   * The instance's own evaluation of the release. Its `rejections` are the
   * verbatim reasons printed first. `null` when the caller holds only the
   * reasons (pass them in `rejections`) — the comparison is then explained
   * as unavailable rather than built from invented data.
   */
  candidate: DecisionCandidate | null;
  /** The item, file and profile to compare against; `null` when the caller cannot name them. */
  target: DecisionTarget | null;
  /** Verbatim reasons when `candidate` is `null`. Ignored when a candidate is given. */
  rejections?: string[];
  /**
   * Why `candidate` or `target` is `null`, phrased as what the caller could
   * not supply. Shown in the degraded note so the gap is named, not blank.
   */
  unavailable?: string;
  /**
   * Run the explain call as soon as this mounts. Only for callers that mount
   * the panel in response to an explicit operator action (a row expanded in
   * Gaps' "Evaluate releases" list) — never for a panel that is on screen by
   * default.
   */
  explainOnMount?: boolean;
}

/**
 * Whether any reason concerns an existing file or a score threshold — the
 * cases REQ-DEC-001 says a comparison accompanies. Matched on the phrases the
 * *arr decision engines use ("Existing file meets cutoff", "Not an upgrade for
 * existing episode file(s)", "Custom Formats … have score … below … minimum",
 * "Quality … is not wanted in profile"). An empty list counts: an accepted
 * release can still be compared against what it would replace.
 */
export function reasonsConcernComparison(rejections: string[]): boolean {
  if (rejections.length === 0) return true;
  return rejections.some((reason) => COMPARISON_REASON.test(reason));
}

const COMPARISON_REASON = /existing|cutoff|custom format|upgrade|score|quality|profile/i;

export default function DecisionExplainer({
  instanceId,
  instanceLabel,
  candidate,
  target,
  rejections: rejectionsProp,
  unavailable,
  explainOnMount = false,
}: DecisionExplainerProps) {
  const rejections = candidate?.rejections ?? rejectionsProp ?? [];
  const relevant = reasonsConcernComparison(rejections);

  return (
    <div style={STACK}>
      <Reasons instanceLabel={instanceLabel} rejections={rejections} />
      {!relevant ? null : candidate && target ? (
        <Comparison
          instanceId={instanceId}
          instanceLabel={instanceLabel}
          candidate={candidate}
          target={target}
          explainOnMount={explainOnMount}
        />
      ) : rejections.length > 0 ? (
        // Only for a reason that *would* carry a comparison: an accepted
        // release with nothing to compare against needs no apology.
        <Callout tone="info">
          <p>
            The side-by-side comparison is not available here
            {unavailable ? <> — {unavailable}</> : '.'} The reason
            {rejections.length === 1 ? ' above is' : 's above are'} {instanceLabel}&apos;s own,
            unchanged.
          </p>
        </Callout>
      ) : null}
    </div>
  );
}

/* ── 1. The instance's own words ──────────────────────────────────────────── */

/**
 * Extracted from `ReleaseInspector`'s `Verdict` (ADR-14) — same wording, same
 * placement, so adding the comparison changed nothing an operator already
 * reads (REQ-SEARCH-006).
 */
function Reasons({ instanceLabel, rejections }: { instanceLabel: string; rejections: string[] }) {
  if (rejections.length === 0) {
    return (
      <Callout tone="ok">
        {instanceLabel} would accept this release — its decision engine raised no objection.
      </Callout>
    );
  }

  return (
    <div>
      <Callout tone="warn">
        Rejected by {instanceLabel} — {rejections.length} reason{rejections.length === 1 ? '' : 's'}.
      </Callout>
      {/* Verbatim, one per line, unabridged. Summarising here would delete the
          one sentence that tells the operator what to change (REQ-SEARCH-006). */}
      <ul className="msg-list" style={{ marginTop: 'var(--space-3)' }}>
        {rejections.map((reason, i) => <li key={`${i}-${reason}`}>{reason}</li>)}
      </ul>
    </div>
  );
}

/* ── 2. The comparison ────────────────────────────────────────────────────── */

/** What each failure kind could not read, named for the degraded callout (REQ-DEC-008). */
export const UNREADABLE: Record<ExplainFailureKind, string> = {
  'config-unavailable': 'its custom formats and quality profiles could not be read',
  'existing-file-unavailable': 'the file on disk for this item could not be read',
  unreachable: 'the instance did not answer',
  unauthorized: 'the instance refused helparr\'s API key',
  'upstream-error': 'the instance answered with an error',
  timeout: 'the instance did not answer in time',
  'no-instance': 'the instance is no longer configured in helparr',
  'not-decisions-client': 'this kind of instance has no decision engine to explain',
};

function Comparison({
  instanceId,
  instanceLabel,
  candidate,
  target,
  explainOnMount,
}: {
  instanceId: string;
  instanceLabel: string;
  candidate: DecisionCandidate;
  target: DecisionTarget;
  explainOnMount: boolean;
}) {
  const {
    explain,
    explainResult,
    explaining,
    explainError,
    refreshConfig,
    refreshConfigResult,
    refreshingConfig,
  } = useExplain();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const run = () => {
    // A thrown error is a malformed or unsendable request; the hook keeps it
    // in `explainError`, which renders below. Nothing to do here but not let
    // it escape as an unhandled rejection.
    explain({ instanceId, ...target, candidate }).catch(() => undefined);
  };

  // Mount-time explain is opt-in and only for panels mounted by an explicit
  // expand (see `explainOnMount`). Deliberately mount-only: a changed
  // candidate is a new panel, keyed by the caller.
  useEffect(() => {
    if (explainOnMount) run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    setRefreshError(null);
    refreshConfig(instanceId)
      .then((result) => {
        // A fresh cache means a fresh comparison: re-run it rather than leave
        // the old numbers under a new timestamp.
        if (result.ok) run();
      })
      .catch((error: unknown) => {
        setRefreshError(error instanceof Error ? error.message : 'The refresh did not complete.');
      });
  };

  let body: ReactNode;
  if (explaining) {
    body = (
      <p className="subtle" role="status" style={NOTE}>
        Reading {instanceLabel}&apos;s quality profile, custom formats and the file on disk…
      </p>
    );
  } else if (explainError) {
    body = (
      <>
        <Callout tone="error">
          <p>
            The comparison request did not complete: {explainError.message}. The reason
            above is unchanged; only the side-by-side breakdown is missing.
          </p>
        </Callout>
        <ExplainButton label="Try again" onClick={run} />
      </>
    );
  } else if (explainResult && !explainResult.ok) {
    body = (
      <>
        <Callout tone="warn">
          <p>
            The comparison could not be built — {instanceLabel}:{' '}
            {UNREADABLE[explainResult.error.kind]}. The reason above is unchanged; only the
            side-by-side breakdown is missing.
          </p>
          <p className="mono" style={{ ...NOTE, marginTop: 'var(--space-2)' }}>
            {explainResult.error.reason}
          </p>
        </Callout>
        <ExplainButton label="Try again" onClick={run} />
      </>
    );
  } else if (explainResult?.ok) {
    body = (
      <ComparisonView
        comparison={explainResult.value}
        instanceLabel={instanceLabel}
        profileId={target.profileId}
        refreshing={refreshingConfig}
        onRefresh={refresh}
        refreshFailure={
          refreshError
          ?? (refreshConfigResult && !refreshConfigResult.ok ? refreshConfigResult.error.reason : null)
        }
      />
    );
  } else {
    body = (
      <>
        <p className="subtle" style={NOTE}>
          Compare this release with the file on disk: both sides&apos; quality, every matched
          custom format with its score, and the profile thresholds {instanceLabel} applies.
        </p>
        <ExplainButton label="Compare with file on disk" onClick={run} />
      </>
    );
  }

  return (
    <section aria-label="Candidate compared with the file on disk" aria-busy={explaining} style={STACK}>
      {body}
    </section>
  );
}

/**
 * Gaps and Queue bind their keyboard layer to the window and claim Enter and
 * Space; stopping them here keeps the explainer's buttons keyboard-operable
 * wherever the panel is mounted.
 */
export function keepActivationKeys(event: ReactKeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

function ExplainButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div>
      <button type="button" className="btn btn-outline btn-sm" onClick={onClick} onKeyDown={keepActivationKeys}>
        <Icon name="eye" size={12} />
        {label}
      </button>
    </div>
  );
}

function ComparisonView({
  comparison,
  instanceLabel,
  profileId,
  refreshing,
  onRefresh,
  refreshFailure,
}: {
  comparison: DecisionComparison;
  instanceLabel: string;
  profileId: number;
  refreshing: boolean;
  onRefresh: () => void;
  refreshFailure: string | null;
}) {
  const { configFetchedAt } = comparison;

  return (
    <>
      <ComparisonBreakdown
        comparison={comparison}
        instanceLabel={instanceLabel}
        missingProfile={(
          <Callout tone="warn">
            <p>
              Quality profile <span className="num">{profileId}</span> was not found among{' '}
              {instanceLabel}&apos;s profiles, so its thresholds cannot be stated and helparr
              cannot sum the per-format scores.
            </p>
          </Callout>
        )}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
          Config <time dateTime={configFetchedAt}>{formatAge(configFetchedAt)}</time>
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRefresh}
          onKeyDown={keepActivationKeys}
          disabled={refreshing}
          aria-label={`Re-read ${instanceLabel}'s custom formats and quality profiles`}
        >
          <Icon name="refresh" size={12} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {refreshFailure ? (
        <Callout tone="error">
          <p>
            {instanceLabel}&apos;s configuration could not be re-read: {refreshFailure}. The
            comparison above is from the earlier read.
          </p>
        </Callout>
      ) : null}
    </>
  );
}

/**
 * The side-by-side itself — both sides, the per-format table, the profile
 * thresholds, the verdict and the attribution note — without the config line,
 * so the queue's per-file list can render the same fields in the same order
 * under one shared Refresh (REQ-DEC-006).
 */
export function ComparisonBreakdown({
  comparison,
  instanceLabel,
  missingProfile,
  headingLevel = 'h4',
}: {
  comparison: DecisionComparison;
  instanceLabel: string;
  /** What to say when the profile is not among the instance's — the caller knows what it can name. */
  missingProfile: ReactNode;
  headingLevel?: 'h4' | 'h5';
}) {
  const { candidate, existing, profile, verdict } = comparison;
  const Heading = headingLevel;

  return (
    <>
      <div>
        <Heading className="eyebrow" style={SUBHEAD}>Candidate vs. on disk</Heading>
        <div style={TWO_COLUMNS}>
          <SideColumn title="Candidate" side={candidate} instanceLabel={instanceLabel} />
          <SideColumn title="On disk" side={existing} instanceLabel={instanceLabel} />
        </div>
      </div>

      {[candidate, existing].map((side) => (side.sumMatches === false ? (
        <Callout key={side.label} tone="warn">
          <p>
            helparr&apos;s sum ({side.helparrSum}) does not match {instanceLabel}&apos;s reported{' '}
            {side.label === 'candidate' ? 'candidate' : 'on-disk'} total ({side.reportedScore}) —
            reported value shown, not overridden.
          </p>
        </Callout>
      ) : null))}

      <FormatTable candidate={candidate} existing={existing} />

      <div>
        <Heading className="eyebrow" style={SUBHEAD}>
          {profile ? <>Profile: <span className="mono">{profile.name}</span></> : 'Profile'}
        </Heading>
        {profile ? (
          <KV
            rows={[
              ['Cutoff quality', profile.cutoff ?? 'not named by the instance'],
              ['Min. CF score', <span key="min" className="num">{profile.minFormatScore}</span>],
              ['Cutoff CF score', <span key="cut" className="num">{profile.cutoffFormatScore}</span>],
              ['Upgrades', profile.upgradeAllowed ? 'allowed' : 'not allowed'],
            ]}
          />
        ) : missingProfile}
      </div>

      <div>
        <Heading className="eyebrow" style={SUBHEAD}>Verdict</Heading>
        <p style={{ ...NOTE, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
          <StatusBadge tone={VERDICT_TONE[verdict.kind]}>{VERDICT_LABEL[verdict.kind]}</StatusBadge>
          <span>{verdict.reason}</span>
        </p>
      </div>

      <p className="inspector__note">
        The per-format breakdown above is helparr&apos;s arithmetic over {instanceLabel}&apos;s
        custom format profile, not {instanceLabel}&apos;s own answer. Where the two totals
        disagree, {instanceLabel}&apos;s reported total is the one it acts on.
      </p>
    </>
  );
}

const SOURCE_TEXT: Record<DecisionSide['scoreSource'], string> = {
  releaseName: 'from release name',
  filename: 'from filename',
  unknown: 'score source unknown',
};

function SideColumn({
  title,
  side,
  instanceLabel,
}: {
  title: string;
  side: DecisionSide;
  instanceLabel: string;
}) {
  return (
    <div style={COLUMN}>
      <div className="eyebrow">{title}</div>
      {side.present ? (
        <KV
          rows={[
            ['Quality', side.quality ?? 'not reported'],
            [
              'Total CF',
              <span key="total">
                {side.reportedScore === null
                  ? <>not reported by {instanceLabel}</>
                  : <span className="num">{side.reportedScore}</span>}
                {' '}<span className="subtle">({SOURCE_TEXT[side.scoreSource]})</span>
              </span>,
            ],
            [
              'helparr sum',
              side.helparrSum === null
                ? <span key="sum" className="subtle">not computable</span>
                : <span key="sum" className="num">{side.helparrSum}</span>,
            ],
          ]}
        />
      ) : (
        // Stated as prose, never a zero in the score cell (REQ-DEC-002).
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <p style={{ fontWeight: 600 }}>No file on disk</p>
          <p className="subtle" style={{ marginTop: 'var(--space-1)' }}>
            This item has no existing file to compare against.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One row per format that matched on *either* side. A one-sided match carries
 * a glyph **and** words — two independent non-colour channels (REQ-DEC-005,
 * ADR-10). The two glyphs are different shapes so they are not confused.
 */
function FormatTable({ candidate, existing }: { candidate: DecisionSide; existing: DecisionSide }) {
  const rows = new Map<number, { name: string; candidate?: number | null; existing?: number | null }>();
  for (const line of candidate.formats) {
    rows.set(line.formatId, { name: line.name, candidate: line.score });
  }
  for (const line of existing.formats) {
    const row = rows.get(line.formatId);
    if (row) row.existing = line.score;
    else rows.set(line.formatId, { name: line.name, existing: line.score });
  }

  return (
    <div>
      <h4 className="eyebrow" style={SUBHEAD}>Custom formats</h4>
      {rows.size === 0 ? (
        <p className="subtle" style={NOTE}>
          No custom format matched {existing.present ? 'either side' : 'the candidate'}.
        </p>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table">
            <caption className="sr-only">Custom format scores, candidate and file on disk</caption>
            <thead>
              <tr>
                <th scope="col">Format</th>
                <th scope="col" className="col-num">Candidate</th>
                <th scope="col" className="col-num">On disk</th>
              </tr>
            </thead>
            <tbody>
              {[...rows.entries()].map(([formatId, row]) => {
                const onCandidate = row.candidate !== undefined;
                const onDisk = row.existing !== undefined;
                // Only meaningful with a file present; with none, every
                // format is trivially "only candidate" and saying so is noise.
                const oneSided = existing.present && onCandidate !== onDisk;
                return (
                  <tr key={formatId} style={STATIC_ROW}>
                    <th scope="row" style={{ ...CELL, fontWeight: 400, textAlign: 'left' }}>
                      <span className="mono">{row.name}</span>
                      {oneSided ? (
                        <span className="subtle" style={{ display: 'block' }}>
                          <span aria-hidden="true">{onCandidate ? '⬗' : '⬖'}</span>{' '}
                          {onCandidate ? 'only candidate' : 'only on disk'}
                        </span>
                      ) : null}
                    </th>
                    <td className="col-num" style={CELL}>
                      <ScoreCell present={onCandidate} score={row.candidate} />
                    </td>
                    <td className="col-num" style={CELL}>
                      {existing.present
                        ? <ScoreCell present={onDisk} score={row.existing} />
                        : <span className="subtle">no file</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScoreCell({ present, score }: { present: boolean; score: number | null | undefined }) {
  if (!present) {
    return <><span aria-hidden="true">—</span><span className="sr-only">not matched</span></>;
  }
  // `null`: the format matched, but the profile gives it no score — said in
  // words rather than as a false zero (FormatScoreLine.score).
  if (score === null || score === undefined) return <span className="subtle">not in profile</span>;
  return <>{score}</>;
}

const VERDICT_LABEL: Record<VerdictKind, string> = {
  upgrade: 'Upgrade',
  'not-upgrade': 'Not an upgrade',
  rejected: 'Rejected',
  'no-existing': 'No existing file',
  unknown: 'Undetermined',
};

const VERDICT_TONE: Record<VerdictKind, Tone> = {
  upgrade: 'ok',
  'not-upgrade': 'warn',
  rejected: 'warn',
  'no-existing': 'idle',
  unknown: 'idle',
};

/* ── Layout ───────────────────────────────────────────────────────────────── */

const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' };
const NOTE: CSSProperties = { fontSize: 'var(--text-sm)' };
const SUBHEAD: CSSProperties = { margin: '0 0 var(--space-2)' };
const TWO_COLUMNS: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
  gap: 'var(--space-3)',
};
const COLUMN: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  padding: 'var(--space-3)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-surface-sunken)',
  minWidth: 0,
};
// `.table` rows are styled as clickable list rows; these are not.
const STATIC_ROW: CSSProperties = { cursor: 'default', height: 'auto' };
const CELL: CSSProperties = { whiteSpace: 'normal', padding: 'var(--space-1) var(--space-2)' };
