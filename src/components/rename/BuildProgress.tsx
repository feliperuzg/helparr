'use client';

import Icon from '@/components/Icon';
import { StatusBadge, type Tone } from '@/components/ui';
import type { IconName } from '@/components/Icon';
import type { RenameTitleStatus } from '@/lib/types';

/**
 * The building phase (T11, FR5, FR15, ADR-5).
 *
 * Two upstream calls per title — a rescan that has to be waited on, then the
 * preview — is slow enough that the operator needs to see it happening, per
 * title, or the screen is indistinguishable from a hang.
 *
 * Two rules the list exists to keep:
 *
 * 1. **An errored title does not abort the others.** It is shown with whatever
 *    the instance said and the build keeps going, because one unreachable
 *    Sonarr is not a reason to refuse to preview a Radarr.
 * 2. **A title with nothing to rename is shown, not dropped** (FR5). "No
 *    changes" and "we never asked" look identical to an operator, and only one
 *    of them is true.
 */

const STATE_UI: Record<RenameTitleStatus['state'], {
  label: string;
  tone: Tone;
  icon: IconName;
  /** Read out in place of the badge, which is an abbreviation of it. */
  spoken: string;
  /** Has this title finished, one way or another? Drives the progress bar. */
  settled: boolean;
}> = {
  pending: {
    label: 'queued',
    tone: 'idle',
    icon: 'clock',
    spoken: 'queued — not asked about yet',
    settled: false,
  },
  rescanning: {
    label: 'rescanning',
    tone: 'idle',
    icon: 'refresh',
    spoken: 'rescanning — the instance is re-reading the files on disk',
    settled: false,
  },
  previewing: {
    label: 'previewing',
    tone: 'idle',
    icon: 'eye',
    spoken: 'previewing — asking the instance what it would rename',
    settled: false,
  },
  'no-changes': {
    label: 'no changes',
    tone: 'ok',
    icon: 'check',
    spoken: 'no changes — every file already matches the naming format',
    settled: true,
  },
  'has-changes': {
    label: 'has changes',
    tone: 'ok',
    icon: 'check',
    spoken: 'has changes — files were proposed for renaming',
    settled: true,
  },
  errored: {
    label: 'could not read',
    tone: 'error',
    icon: 'alert',
    spoken: 'could not be read — this title is not in the plan',
    settled: true,
  },
};

export interface BuildProgressProps {
  titles: RenameTitleStatus[];
  /** How many titles the operator chose, before any of them reported back. */
  expected: number;
  onCancel: () => void;
}

export default function BuildProgress({ titles, expected, onCancel }: BuildProgressProps) {
  const total = Math.max(titles.length, expected, 1);
  const done = titles.filter((title) => STATE_UI[title.state].settled).length;
  const errored = titles.filter((title) => title.state === 'errored').length;
  const percent = Math.min(100, Math.round((done / total) * 100));

  return (
    <div className="content__scroll">
      <section className="section">
        <div className="card build">
          <div className="build__head">
            <span className="spinner" aria-hidden="true" />
            <div className="build__headings">
              <h2 className="build__title">Building the preview</h2>
              <p className="build__sub">
                Each title is rescanned and then asked what it would rename. Nothing is being
                written — this reads your instances and nothing more.
              </p>
            </div>
          </div>

          <div
            className="progress build__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={`${done} of ${total} titles read`}
          >
            <span
              className={`progress__bar ${errored > 0 ? 'progress__bar--warn' : 'progress__bar--ok'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="build__count mono" role="status">
            {done} of {total} titles read
            {errored > 0
              ? ` · ${errored} could not be read`
              : ''}
          </p>

          <ul className="build__list">
            {titles.map((title) => {
              const ui = STATE_UI[title.state];
              return (
                <li
                  key={`${title.instanceId}:${title.kind}:${title.upstreamId}`}
                  className={`build__item${title.state === 'errored' ? ' is-errored' : ''}`}
                >
                  <Icon
                    name={title.kind === 'series' ? 'tv' : 'film'}
                    size={12}
                    className="build__kind"
                  />
                  <span className="build__label">{title.label}</span>
                  <span className="build__instance">{title.instanceLabel}</span>
                  <span className="build__files mono">
                    {ui.settled && title.state !== 'errored'
                      ? `${title.fileCount} file${title.fileCount === 1 ? '' : 's'}`
                      : ''}
                  </span>
                  <StatusBadge tone={ui.tone} icon={ui.icon}>
                    <span aria-hidden="true">{ui.label}</span>
                    <span className="sr-only">{ui.spoken}</span>
                  </StatusBadge>
                  {/* Verbatim, and beneath the row rather than in a tooltip: it
                      is the only account of why this title is absent from the
                      plan the operator is about to approve. */}
                  {title.reason ? (
                    <span className="build__reason">{title.reason}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="build__foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel and choose again
            </button>
            <span className="build__note subtle">
              Cancelling discards the preview. It has renamed nothing to discard.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
