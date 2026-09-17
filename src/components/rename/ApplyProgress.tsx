'use client';

import { useMemo } from 'react';

import Icon from '@/components/Icon';
import PlanGrid from '@/components/rename/PlanGrid';
import { summarize } from '@/components/rename/planView';
import { Callout, StatusBadge } from '@/components/ui';
import type { RenamePlanDto } from '@/lib/types';

/**
 * Applying, and done (T14, FR12, FR13, ADR-7).
 *
 * One component for both phases because they are the same screen with more
 * results in it — the rows fill in progressively and the summary sharpens as
 * they do. Splitting them would mean two places that count outcomes, and a
 * count that can disagree with itself is exactly the failure FR13 is about.
 *
 * The rules this screen exists to hold:
 *
 * - **No row says "renamed" before its own result has landed** (FR12). Every
 *   status comes from `row.outcome`; a row still `pending` reads *waiting*.
 *   Nothing is optimistic, nothing is inferred from the row above it.
 * - **The summary is counted from those same outcomes** (FR13, ADR-7), never
 *   from what a command said about itself. The spike measured Sonarr reporting
 *   a command `completed` and `successful` having renamed no file at all; a
 *   summary built from that report would be confidently, silently wrong.
 * - **A row that finished with no outcome is its own line.** Folding it into
 *   `succeeded` would be the lie; folding it into `failed` asserts something
 *   equally unobserved.
 */

export interface ApplyProgressProps {
  plan: RenamePlanDto;
  cursor: number;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  openRowId: string | null;
  onStartOver: () => void;
}

export default function ApplyProgress({
  plan, cursor, onCursorChange, onOpen, openRowId, onStartOver,
}: ApplyProgressProps) {
  const applying = plan.phase === 'applying';
  const summary = useMemo(() => summarize(plan.rows), [plan.rows]);
  const percent = summary.sent === 0
    ? 100
    : Math.round((summary.resolved / summary.sent) * 100);

  const tone = summary.failed > 0 || summary.unreported > 0 ? 'warn' : 'ok';

  return (
    <>
      <div
        className={`ribbon ribbon--${applying ? 'applying' : 'done'}`}
        role="status"
        aria-live="polite"
      >
        {applying
          ? <span className="spinner" aria-hidden="true" />
          : <Icon name="check" size={14} />}
        <span className="ribbon__title">
          {applying
            ? 'APPLYING — files are being renamed now'
            : 'APPLY COMPLETE — these files have been renamed'}
        </span>
        <span className="ribbon__spacer" />
        <span className="ribbon__timer mono">
          {summary.resolved} of {summary.sent} reported
        </span>
      </div>

      <div className="content__scroll">
        <section className="section">
          <div
            className="progress"
            role="progressbar"
            // Named as well as valued: `aria-valuetext` says what the number
            // means, and without a name a reader announces the number alone.
            aria-label={applying ? 'Rename in progress' : 'Rename results reported'}
            aria-valuemin={0}
            aria-valuemax={summary.sent}
            aria-valuenow={summary.resolved}
            aria-valuetext={`${summary.resolved} of ${summary.sent} files reported a result`}
          >
            <span
              className={`progress__bar progress__bar--${tone === 'ok' ? 'ok' : 'warn'}`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <div className="tally" role="group" aria-label="Outcomes so far">
            <StatusBadge tone="ok" icon="check">
              {summary.succeeded} renamed
            </StatusBadge>
            <StatusBadge tone={summary.failed > 0 ? 'error' : 'idle'} icon="alert">
              {summary.failed} failed
            </StatusBadge>
            <StatusBadge tone="idle" icon="x">
              {summary.skipped} skipped
            </StatusBadge>
            {summary.unreported > 0 ? (
              <StatusBadge tone={applying ? 'idle' : 'warn'} icon="clock">
                {summary.unreported} {applying ? 'waiting' : 'no outcome reported'}
              </StatusBadge>
            ) : null}
          </div>

          {applying ? (
            <Callout tone="idle">
              Each file is counted only once its own result has come back. A row still reading{' '}
              <strong>waiting</strong> has been sent and has not been reported on — it is not a
              file that has been renamed, and it is not one that has failed. Leaving this screen
              does not stop the rename.
            </Callout>
          ) : (
            <Summary
              succeeded={summary.succeeded}
              failed={summary.failed}
              unreported={summary.unreported}
              plan={plan}
            />
          )}
        </section>

        <section className="section">
          <PlanGrid
            rows={plan.rows}
            mode={applying ? 'applying' : 'done'}
            cursor={cursor}
            onCursorChange={onCursorChange}
            onOpen={onOpen}
            openRowId={openRowId}
            busy={applying}
          />
        </section>
      </div>

      {!applying ? (
        <div className="bulkbar bulkbar--apply" role="region" aria-label="After the rename">
          <span className="bulkbar__count mono">
            {summary.succeeded} file{summary.succeeded === 1 ? '' : 's'} renamed
          </span>
          <span className="bulkbar__spacer" />
          <button type="button" className="btn btn-primary btn-sm" onClick={onStartOver}>
            <Icon name="refresh" size={12} />Rename something else
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The closing statement (FR13).
 *
 * Three things it must say and does: what happened, that it cannot be undone
 * from here, and **who did it** — helparr asked, the instance performed the
 * rename and owns the resulting files. An operator chasing a file that is not
 * where they expect needs to know which program to look at.
 */
function Summary({
  succeeded, failed, unreported, plan,
}: {
  succeeded: number;
  failed: number;
  unreported: number;
  plan: RenamePlanDto;
}) {
  const instances = useMemo(() => {
    const names = new Set(plan.rows.filter((row) => !row.excluded).map((row) => row.instanceLabel));
    return [...names];
  }, [plan.rows]);

  const named = instances.length === 0
    ? 'the instance'
    : instances.length === 1
      ? instances[0]
      : `${instances.slice(0, -1).join(', ')} and ${instances[instances.length - 1]}`;

  return (
    <>
      <Callout tone={failed > 0 || unreported > 0 ? 'warn' : 'ok'}>
        <strong>
          {succeeded} file{succeeded === 1 ? '' : 's'} {succeeded === 1 ? 'was' : 'were'} renamed.
        </strong>
        {' '}
        {/* Attribution, per ADR-7: helparr never touched the filesystem. It
            asked, and it then re-read the instance to find out what actually
            happened — which is why these numbers are per file rather than one
            verdict copied off a command's own status. */}
        helparr did not rename anything itself — it asked {named} to, and then read{' '}
        {instances.length > 1 ? 'them' : 'it'} back file by file to find out what actually
        changed. The numbers above are that reading, not what the command said about itself.
        {failed > 0 ? (
          <>
            {' '}
            {failed} file{failed === 1 ? '' : 's'} {failed === 1 ? 'was' : 'were'} not renamed;
            open {failed === 1 ? 'it' : 'them'} in the list below for what the instance said.
          </>
        ) : null}
        {unreported > 0 ? (
          <>
            {' '}
            {unreported} file{unreported === 1 ? '' : 's'} {unreported === 1 ? 'was' : 'were'}{' '}
            sent and never reported on. helparr does not know whether{' '}
            {unreported === 1 ? 'it' : 'they'} moved, and is not going to guess — check{' '}
            {named} directly.
          </>
        ) : null}
      </Callout>

      <Callout tone="idle" icon="alert">
        <strong>This cannot be undone from helparr.</strong> There is no revert: putting a file
        back where it was means renaming it again yourself, on the instance that holds it. The
        old paths are recorded in Activity if you need them.
      </Callout>
    </>
  );
}
