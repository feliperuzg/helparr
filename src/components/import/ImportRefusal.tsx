'use client';

import type { ReactNode } from 'react';

import Icon from '@/components/Icon';
import type { ImportRefusal as ImportRefusalValue, ImportRefusalReason } from '@/lib/importPlan';

/**
 * Drift, expiry and a vanished record (T17; FR9, ADR-5, NFR3's precedent).
 *
 * **"Rebuild preview" is the only control on this screen**, as on rename's
 * refusal. There is no "import anyway", no "import the files that did not
 * change", no override — and the absence holds in the markup as well as on the
 * server, because an affordance offered here is one an operator in a hurry
 * will find a way to want.
 *
 * Rebuild re-reads `manualimport` from scratch. Any mapping the operator chose
 * on the refused plan is discarded with it: a stale candidate set invalidates
 * the choices made against it too (`state-import-plan.md`).
 *
 * The refusal's `changes` are the server's own words and are shown verbatim —
 * this component never rebuilds them from the reason code.
 */

/** Refusals that retire the plan: nothing but a rebuild gets past them. */
export const REBUILD_ONLY: ReadonlySet<ImportRefusalReason> = new Set<ImportRefusalReason>([
  'drift', 'expired', 'record-gone',
]);

export interface ImportRefusalProps {
  /** The server's refusal, verbatim. Null on an expiry the client clock noticed first. */
  refusal: ImportRefusalValue | null;
  /** True when the five-minute window has passed. */
  expired: boolean;
  instanceLabel: string;
  /** Candidates the refused plan held — the drift count is stated against it. */
  candidateCount: number;
  onRebuild: () => void;
  /** A replacement plan is being read. */
  busy: boolean;
  /** Anything to keep visible beneath the refusal, e.g. the expired grid, read-only. */
  children?: ReactNode;
}

function heading(reason: ImportRefusalReason | null, expired: boolean): string {
  if (expired || reason === 'expired') return 'This preview is too old to import from';
  if (reason === 'drift') return 'Import refused — the candidate set changed since this preview';
  if (reason === 'record-gone') return 'Import refused — the download is gone from the queue';
  if (reason === 'empty') return 'There is nothing to import';
  return 'Import refused';
}

export default function ImportRefusal({
  refusal, expired, instanceLabel, candidateCount, onRebuild, busy, children,
}: ImportRefusalProps) {
  const reason = expired ? 'expired' : refusal?.reason ?? null;
  const changes = refusal?.changes ?? [];

  return (
    <>
      <div className="ribbon ribbon--refused" role="status">
        <Icon name={reason === 'expired' ? 'clock' : 'alert'} size={14} />
        <span className="ribbon__title">
          {reason === 'expired'
            ? 'PREVIEW EXPIRED — nothing was imported'
            : 'IMPORT REFUSED — nothing was imported'}
        </span>
      </div>

      <div className="content__scroll">
        <section className="section">
          <div className="card refusal">
            <h2 className="refusal__title">{heading(reason, expired)}</h2>

            <p className="refusal__body">
              {reason === 'expired' ? (
                <>
                  A preview is valid for five minutes from the moment it is read. Past that,
                  {' '}{instanceLabel}&rsquo;s candidates may have changed, so helparr will not
                  send the import. <strong>Nothing was written</strong> — not one file.
                </>
              ) : reason === 'drift' ? (
                <>
                  Before importing anything, helparr re-reads {instanceLabel}&rsquo;s candidate
                  set and compares it with the one you reviewed. It no longer matches.{' '}
                  <strong>The whole import was refused and nothing was written</strong>,
                  including the files that had not changed — a plan that is partly wrong is a
                  plan you did not approve.
                </>
              ) : reason === 'record-gone' ? (
                <>
                  {instanceLabel} no longer reports any import candidates for this download —
                  the queue record may have been removed, re-grabbed, or imported some other way.
                  {' '}<strong>Nothing was written.</strong>
                </>
              ) : (
                <>
                  {instanceLabel} returned nothing this preview could import.{' '}
                  <strong>Nothing was written.</strong>
                </>
              )}
            </p>

            {changes.length > 0 ? (
              <>
                <h3 className="refusal__subtitle">
                  {reason === 'drift'
                    ? `${changes.length} change${changes.length === 1 ? '' : 's'} since this preview of ${candidateCount} candidate${candidateCount === 1 ? '' : 's'}:`
                    : `What ${instanceLabel} reported:`}
                </h3>
                {/* Focusable because it scrolls past its max height and holds
                    nothing that focuses on its own (WCAG 2.1.1). */}
                <ul className="refusal__paths" tabIndex={0} aria-label="What changed">
                  {changes.map((change, at) => (
                    <li key={`${at}:${change}`} className="mono">{change}</li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="refusal__foot">
              {/* The only forward control. Not a default hiding a second option
                  behind a disclosure — the second option does not exist. */}
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRebuild}
                disabled={busy}
              >
                <Icon name="refresh" size={13} />
                {busy ? 'Reading candidates…' : 'Rebuild preview'}
              </button>
              <p className="refusal__note subtle">
                Reads {instanceLabel}&rsquo;s current candidates for the same download and shows
                them to you again. Any mapping you changed is discarded with this preview.
                helparr will not import against a candidate set that has moved since it was
                shown, and there is no setting that changes that.
              </p>
            </div>
          </div>
        </section>

        {children ? <section className="section">{children}</section> : null}
      </div>
    </>
  );
}
