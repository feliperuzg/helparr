'use client';

import { useEffect, useMemo, useState } from 'react';

import Icon from '@/components/Icon';
import PlanGrid from '@/components/rename/PlanGrid';
import {
  formatDuration, millisLeft, warningCount, warningKinds, WARNING_COPY,
} from '@/components/rename/planView';
import { Callout, EmptyState, StatusBadge } from '@/components/ui';
import type { RenamePlanDto } from '@/lib/types';

/**
 * The preview phase (T12, FR3–FR8, FR11).
 *
 * The ribbon at the top is the screen's loudest element on purpose: everything
 * below it is a proposal, and the single most expensive misreading available
 * here is to take it for a record of what has already happened. It says so, it
 * counts down, and it is the same strip that is replaced — not removed — by the
 * apply summary, so the operator can tell the two screens apart at a glance.
 */

/** One tick a second, which is the resolution the countdown is displayed at. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export interface PlanReviewProps {
  plan: RenamePlanDto;
  cursor: number;
  onCursorChange: (index: number) => void;
  onOpen: (index: number) => void;
  openRowId: string | null;
  onSetExcluded: (rowIds: string[], excluded: boolean) => void;
  onApply: () => void;
  onRegenerate: () => void;
  excluding: boolean;
  applying: boolean;
}

export default function PlanReview({
  plan, cursor, onCursorChange, onOpen, openRowId,
  onSetExcluded, onApply, onRegenerate, excluding, applying,
}: PlanReviewProps) {
  const now = useNow(true);
  const left = millisLeft(plan, now);
  const expiringSoon = left !== null && left <= 60_000;

  const flagged = useMemo(() => warningCount(plan.rows), [plan.rows]);
  const kinds = useMemo(() => warningKinds(plan.rows), [plan.rows]);
  const excluded = plan.rows.length - plan.affectedFiles;

  const includedTitles = useMemo(() => {
    const keys = new Set(
      plan.rows.filter((row) => !row.excluded).map((row) => `${row.instanceId}:${row.titleUpstreamId}`),
    );
    return keys.size;
  }, [plan.rows]);

  const unchanged = plan.titles.filter((title) => title.state === 'no-changes');
  const errored = plan.titles.filter((title) => title.state === 'errored');

  return (
    <>
      <div className="ribbon ribbon--preview" role="status">
        <Icon name="eye" size={14} />
        <span className="ribbon__title">PREVIEW — nothing has been renamed</span>
        <span className="ribbon__spacer" />
        {left === null ? null : (
          <span className={`ribbon__timer mono${expiringSoon ? ' is-urgent' : ''}`}>
            <Icon name="clock" size={12} />
            <span aria-hidden="true">{formatDuration(left)}</span>
            <span className="sr-only">
              {left <= 0
                ? 'This plan has expired.'
                : `This plan can be applied for another ${formatDuration(left)}.`}
            </span>
          </span>
        )}
      </div>

      <div className="content__scroll">
        <section className="section">
          <div className="totals">
            <span className="totals__main mono">
              {plan.affectedFiles} file{plan.affectedFiles === 1 ? '' : 's'} across{' '}
              {includedTitles} title{includedTitles === 1 ? '' : 's'}
            </span>
            {excluded > 0 ? (
              <StatusBadge tone="idle" icon="x">
                {excluded} excluded
              </StatusBadge>
            ) : null}
            {flagged > 0 ? (
              <StatusBadge tone="warn" icon="alert">
                {flagged} flagged
              </StatusBadge>
            ) : null}
            <span className="totals__spacer" />
            <span className="totals__note subtle">
              Of {plan.totalFiles} file{plan.totalFiles === 1 ? '' : 's'} the instances proposed.
            </span>
          </div>
        </section>

        {errored.length > 0 ? (
          <section className="section">
            <Callout tone="warn">
              {errored.length} title{errored.length === 1 ? '' : 's'} could not be read and{' '}
              {errored.length === 1 ? 'is' : 'are'} absent from this plan:
              <ul className="msg-list">
                {errored.map((title) => (
                  <li key={`${title.instanceId}:${title.upstreamId}`}>
                    {title.label} ({title.instanceLabel}) — {title.reason ?? 'no reason given'}
                  </li>
                ))}
              </ul>
            </Callout>
          </section>
        ) : null}

        {flagged > 0 ? (
          <section className="section">
            {/* ADR-9, stated once at plan level and again per row: every flag in
                the grid below is helparr's own derivation. The instances return
                no warning field at all on a rename preview. */}
            <Callout tone="warn">
              <strong>
                {flagged} of these files carry a flag helparr worked out for itself.
              </strong>
              {' '}
              Neither Sonarr nor Radarr reports a warning on a rename preview, so these are
              helparr&rsquo;s readings and helparr&rsquo;s responsibility:
              <ul className="msg-list">
                {kinds.map((kind) => (
                  <li key={kind}>
                    <strong>{WARNING_COPY[kind].label}</strong> — {WARNING_COPY[kind].summary}.
                  </li>
                ))}
              </ul>
              {/* The asymmetry is real and must not be papered over: Radarr has
                  no multi-episode concept, so that flag can never appear on a
                  film — its absence there says nothing about the film. */}
              {kinds.includes('multi-episode') ? (
                <>
                  Multi-episode applies to Sonarr only. Radarr has no equivalent, so a film is
                  never flagged with it.
                </>
              ) : null}
            </Callout>
          </section>
        ) : null}

        <section className="section">
          {plan.rows.length === 0 ? (
            <EmptyState title="Nothing to rename">
              Every title you picked already matches its naming format. No file needs to move,
              so there is nothing to approve.
            </EmptyState>
          ) : (
            <PlanGrid
              rows={plan.rows}
              mode="preview"
              cursor={cursor}
              onCursorChange={onCursorChange}
              onOpen={onOpen}
              openRowId={openRowId}
              onSetExcluded={onSetExcluded}
              busy={excluding}
            />
          )}
        </section>

        {/* FR5. Shown, never dropped — a title that was checked and found clean
            is a different fact from one that was never asked about, and the
            operator cannot tell them apart from an absence. */}
        {unchanged.length > 0 ? (
          <section className="section">
            <h2 className="section__title">Nothing to rename ({unchanged.length})</h2>
            <p className="section__sub">
              These titles were rescanned and previewed. Every file already matches the naming
              format, so none of them appears in the plan above.
            </p>
            <ul className="clean-list">
              {unchanged.map((title) => (
                <li key={`${title.instanceId}:${title.upstreamId}`} className="clean-list__item">
                  <Icon
                    name={title.kind === 'series' ? 'tv' : 'film'}
                    size={12}
                    className="clean-list__kind"
                  />
                  <span className="clean-list__label">{title.label}</span>
                  <span className="clean-list__files mono">
                    {title.fileCount} file{title.fileCount === 1 ? '' : 's'} already correct
                  </span>
                  <span className="clean-list__instance">{title.instanceLabel}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <div className="bulkbar bulkbar--apply" role="region" aria-label="Apply this plan">
        <span className="bulkbar__count mono">
          {plan.affectedFiles} file{plan.affectedFiles === 1 ? '' : 's'} will be renamed
        </span>
        <span className="bulkbar__spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRegenerate}>
          <Icon name="refresh" size={12} />Start over
        </button>
        <button
          type="button"
          className="btn btn-danger-solid btn-sm"
          // Opens the confirmation; it never renames anything directly.
          onClick={onApply}
          disabled={plan.affectedFiles === 0 || applying || excluding}
        >
          <Icon name="rename" size={12} />Apply…
        </button>
      </div>
    </>
  );
}
