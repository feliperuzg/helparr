'use client';

import Link from 'next/link';
import { useMemo } from 'react';

import Icon from '@/components/Icon';
import { baseName } from '@/components/import/CandidateGrid';
import { Callout, StatusBadge, type Tone } from '@/components/ui';
import type { IconName } from '@/components/Icon';
import type { ImportPlanRow } from '@/lib/importPlan';
import type { ImportPlanRead } from '@/lib/api';

/**
 * Applying, and done (T17; FR10, ADR-7, REQ-QUEUE-022).
 *
 * One component for both phases, as rename's `ApplyProgress` is: they are the
 * same screen with more results in it, and splitting them would mean two places
 * that count outcomes.
 *
 * The rules this screen holds:
 *
 * - **No row reads "imported" before its own evidence exists.** Every status
 *   comes from `row.outcome`, which the server writes only after reading
 *   history (`droppedPath`) or re-reading the candidates. A row with no outcome
 *   yet reads *waiting* — not imported, not failed.
 * - **The summary is counted from those same outcomes**, never from the
 *   `ManualImport` command's own verdict, which is whole-batch and whose message
 *   is only a count (OQ-5).
 * - **Three outcomes, never two.** `unverified` is its own count, shown even at
 *   zero, and never folded into `succeeded` — or into `failed`, which would
 *   assert something equally unobserved.
 */

export interface ImportProgressProps {
  plan: ImportPlanRead;
  onRebuild: () => void;
  /** A replacement plan is being read. */
  rebuilding: boolean;
}

interface Tally {
  sent: number;
  succeeded: number;
  failed: number;
  unverified: number;
  waiting: number;
}

function tallyOf(rows: ImportPlanRow[]): Tally {
  const tally: Tally = { sent: rows.length, succeeded: 0, failed: 0, unverified: 0, waiting: 0 };
  for (const row of rows) {
    if (row.outcome === null) tally.waiting += 1;
    else tally[row.outcome.outcome] += 1;
  }
  return tally;
}

interface RowStatus {
  tone: Tone;
  icon: IconName;
  label: string;
}

function statusOf(row: ImportPlanRow, applying: boolean): RowStatus {
  if (row.outcome === null) {
    return applying
      ? { tone: 'idle', icon: 'clock', label: 'waiting' }
      : { tone: 'warn', icon: 'alert', label: 'no outcome' };
  }
  switch (row.outcome.outcome) {
    case 'succeeded': return { tone: 'ok', icon: 'check', label: 'imported' };
    case 'failed': return { tone: 'error', icon: 'x', label: 'failed' };
    case 'unverified': return { tone: 'warn', icon: 'alert', label: 'unverified' };
  }
}

export default function ImportProgress({ plan, onRebuild, rebuilding }: ImportProgressProps) {
  const applying = plan.phase === 'applying' || plan.importing;
  // Only the rows that were sent. An excluded row was never part of the
  // import, and counting it would make "N of M" a number about something else.
  const sent = useMemo(() => plan.rows.filter((row) => row.included), [plan.rows]);
  const tally = useMemo(() => tallyOf(sent), [sent]);
  const resolved = tally.sent - tally.waiting;
  const percent = tally.sent === 0 ? 100 : Math.round((resolved / tally.sent) * 100);
  const whole = !applying && tally.succeeded === tally.sent;
  const instance = plan.instanceLabel;

  return (
    <>
      <div
        // Tone by evidence, the words carry the meaning: a failure reads in the
        // error tone, an unconfirmed file in the warn tone, and only a run
        // where every file has its own success evidence gets the done tone.
        className={`ribbon ribbon--${applying ? 'applying' : whole ? 'done' : tally.failed > 0 ? 'refused' : 'preview'}`}
        role="status"
        aria-live="polite"
      >
        {applying
          ? <span className="spinner" aria-hidden="true" />
          : <Icon name={whole ? 'check' : 'alert'} size={14} />}
        <span className="ribbon__title">
          {applying
            ? `IMPORTING — ${instance} is importing these files now`
            : whole
              ? 'IMPORT COMPLETE — this is an applied result, not a preview'
              : 'IMPORT FINISHED — PARTIAL: not every file was confirmed imported'}
        </span>
        <span className="ribbon__spacer" />
        <span className="ribbon__timer mono">
          {tally.succeeded} of {tally.sent} imported
        </span>
      </div>

      <div className="content__scroll">
        <section className="section">
          <div
            className="progress"
            role="progressbar"
            aria-label={applying ? 'Import in progress' : 'Import results read back'}
            aria-valuemin={0}
            aria-valuemax={tally.sent}
            aria-valuenow={resolved}
            aria-valuetext={`${resolved} of ${tally.sent} files have a read-back outcome`}
          >
            <span
              className={`progress__bar progress__bar--${tally.failed > 0 ? 'error' : tally.unverified > 0 ? 'warn' : 'ok'}`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <div className="tally" role="group" aria-label="Outcomes so far">
            <StatusBadge tone="ok" icon="check">{tally.succeeded} succeeded</StatusBadge>
            <StatusBadge tone={tally.failed > 0 ? 'error' : 'idle'} icon="x">
              {tally.failed} failed
            </StatusBadge>
            {/* Shown even at zero: the third truthful outcome is named, so its
                absence is a fact rather than an omission. */}
            <StatusBadge tone={tally.unverified > 0 ? 'warn' : 'idle'} icon="alert">
              {tally.unverified} unverified
            </StatusBadge>
            {tally.waiting > 0 ? (
              <StatusBadge tone="idle" icon="clock">
                {tally.waiting} {applying ? 'waiting' : 'no outcome recorded'}
              </StatusBadge>
            ) : null}
          </div>

          {applying ? (
            <Callout tone="idle">
              helparr sent one ManualImport command to {instance} and is reading the result back
              file by file from {instance}&rsquo;s history. A row reading <strong>waiting</strong>
              {' '}has been sent and has no evidence yet — it is not imported, and it is not
              failed. Leaving this screen does not stop the import.
            </Callout>
          ) : (
            <Summary tally={tally} instance={instance} />
          )}
        </section>

        <section className="section">
          <div className="card table-wrap" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="table" aria-label="Files sent and what each one did">
              <thead>
                <tr>
                  <th scope="col" className="col-grow">File</th>
                  <th scope="col">Target</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {sent.map((row) => {
                  const status = statusOf(row, applying);
                  return (
                    <tr key={row.ordinal} style={{ verticalAlign: 'top', cursor: 'default' }}>
                      <td className="col-grow" style={{ paddingBlock: 'var(--space-2)' }}>
                        <span className="mono truncate" style={{ display: 'block' }} title={row.path}>
                          {baseName(row.path)}
                        </span>
                        <OutcomeDetail row={row} instance={instance} />
                      </td>
                      <td style={{ paddingBlock: 'var(--space-2)', whiteSpace: 'normal' }}>
                        {row.mapping?.label ?? '—'}
                        {row.mappingSource === 'operator' ? (
                          <span className="subtle" style={{ display: 'block' }}>you changed this</span>
                        ) : null}
                      </td>
                      <td style={{ paddingBlock: 'var(--space-2)' }}>
                        <StatusBadge tone={status.tone} icon={status.icon}>{status.label}</StatusBadge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {!applying ? (
        <div className="bulkbar bulkbar--apply" role="region" aria-label="After the import">
          <span className="bulkbar__count mono">
            {tally.succeeded} of {tally.sent} imported
          </span>
          <span className="bulkbar__spacer" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRebuild}
            disabled={rebuilding}
          >
            <Icon name="refresh" size={12} />
            {rebuilding ? 'Reading candidates…' : 'Rebuild preview'}
          </button>
          <Link href="/" className="btn btn-primary btn-sm">Back to queue</Link>
        </div>
      ) : null}
    </>
  );
}

/** What the read-back said about one file, verbatim where it came from upstream. */
function OutcomeDetail({ row, instance }: { row: ImportPlanRow; instance: string }) {
  const outcome = row.outcome;
  if (!outcome) return null;
  if (outcome.outcome === 'succeeded') {
    return outcome.destination ? (
      <span
        className="mono subtle"
        style={{ display: 'block', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
      >
        → {outcome.destination}
      </span>
    ) : null;
  }
  if (!outcome.error) return null;
  return (
    <span style={{ display: 'block', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      <span className="subtle">
        {outcome.outcome === 'failed' ? `${instance}: ` : 'helparr: '}
      </span>
      <span className={outcome.outcome === 'failed' ? 'mono' : undefined}>{outcome.error}</span>
    </span>
  );
}

/**
 * The closing statement (FR10). What happened, in the three-way split; who did
 * it — the instance performed the writes, helparr issued the command and read
 * the outcome back; and that it cannot be undone.
 */
function Summary({ tally, instance }: { tally: Tally; instance: string }) {
  const partial = tally.succeeded < tally.sent;
  const unaccounted = tally.unverified + tally.waiting;

  return (
    <>
      <Callout tone={tally.failed > 0 ? 'error' : partial ? 'warn' : 'ok'}>
        <strong>
          {tally.succeeded} of {tally.sent} file{tally.sent === 1 ? '' : 's'} imported.
        </strong>
        {' '}
        {instance} performed these imports; helparr issued the command and read the outcome
        back per file from {instance}&rsquo;s history. These numbers are that reading, not what
        the command said about itself.
        {tally.failed > 0 ? (
          <>
            {' '}
            {tally.failed} file{tally.failed === 1 ? '' : 's'} failed — {instance}&rsquo;s own
            reason is under each one below. There is no automatic retry; rebuild a preview to
            see {tally.failed === 1 ? 'its' : 'their'} current state and try again.
          </>
        ) : null}
        {unaccounted > 0 ? (
          <>
            {' '}
            {unaccounted} file{unaccounted === 1 ? '' : 's'} could not be confirmed either way:
            neither {instance}&rsquo;s history nor a fresh candidate read shows what happened.
            helparr is not going to guess — check {instance} directly.
          </>
        ) : null}
      </Callout>

      <Callout tone="idle" icon="alert">
        <strong>This cannot be undone from helparr.</strong> {instance} moved the imported files
        into your library; there is no revert. Every file&rsquo;s outcome is recorded in Activity.
      </Callout>
    </>
  );
}
