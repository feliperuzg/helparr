'use client';

import { useEffect, useState } from 'react';

import Icon from '@/components/Icon';
import MonoValue from '@/components/search/MonoValue';
import { useEvaluateRelease } from '@/components/search/useSearch';
import { Callout, Inspector, InspectorGroup, KV } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { formatBytes } from '@/lib/queue';
import type { InstanceHealthDto, ReleaseRead } from '@/lib/types';

import { formatAgeHours, formatPeers } from './ResultsGrid';

/**
 * The release inspector (REQ-SEARCH-005, -006; FR6, FR14; ADR-5; T16).
 *
 * Two rules shape everything here:
 *
 * 1. **Nothing is asked of an instance until the operator asks.** Opening this
 *    panel costs zero upstream calls. `GET /api/v3/release` is a *live* search
 *    against the operator's own trackers — measured at 405 releases and "can
 *    take a minute" — so evaluation is a button, never an effect (ADR-5).
 * 2. **Rejections are printed, not summarised.** Every reason, verbatim, one
 *    per line (REQ-SEARCH-006). A rejected release can still be grabbed:
 *    helparr reports the decision engine, it does not enforce it.
 */

export interface ReleaseInspectorProps {
  release: ReleaseRead;
  /** Sonarr and Radarr only — the two kinds that can parse and accept a release. */
  destinations: InstanceHealthDto[];
  onClose: () => void;
  /** Opens the confirmation. The grab itself never starts from this panel. */
  onGrab: () => void;
}

export default function ReleaseInspector({
  release,
  destinations,
  onClose,
  onGrab,
}: ReleaseInspectorProps) {
  const [target, setTarget] = useState<string>(() => destinations[0]?.instanceId ?? '');
  const evaluate = useEvaluateRelease();

  // A different release is a different verdict. Resetting on `guid` rather than
  // on mount matters because the panel is reused as the operator moves down the
  // grid with j/k — without this, row 4 would show row 3's rejections.
  useEffect(() => { evaluate.reset(); }, [release.guid]); // eslint-disable-line react-hooks/exhaustive-deps

  // The roster can change under a long-lived panel (an instance is disabled in
  // Settings). Falling back keeps the select from showing a target that is no
  // longer there.
  const chosen = destinations.find((d) => d.instanceId === target) ?? destinations[0] ?? null;

  return (
    <Inspector
      label="Release detail"
      eyebrow={`${release.indexer} · ${release.protocol}`}
      title={release.title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary btn-sm" onClick={onGrab}>
          <Icon name="down" size={12} />Grab into…
        </button>
      }
    >
      <InspectorGroup title="Identity">
        <KV
          rows={[
            ['Indexer', release.indexer],
            ['Protocol', release.protocol],
            ['guid', <MonoValue key="g" value={release.guid} label="guid" />],
            ['infoHash', <MonoValue key="h" value={release.infoHash} label="infoHash" />],
            ['Published', <MonoValue key="p" value={formatPublished(release.publishDate)} label="publish date" />],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Numbers">
        <KV
          rows={[
            ['Size', formatBytes(release.size)],
            ['Seeders', formatPeers(release.seeders)],
            ['Leechers', formatPeers(release.leechers)],
            ['Age', formatAgeHours(release.ageHours)],
            // Spelled out rather than shown as a badge only: "no" is a fact the
            // operator may be checking for, and an absent badge is ambiguous
            // between "not freeleech" and "we do not know".
            ['Freeleech', release.freeleech ? 'yes' : 'no'],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Decision engine">
        {evaluate.isPending ? (
          <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
            Asking {chosen?.label ?? 'the instance'}… this runs a live search against your
            indexers and can take a minute.
          </p>
        ) : evaluate.isError ? (
          <Callout tone="error">
            {evaluate.error instanceof ApiError
              ? evaluate.error.message
              : 'The evaluation did not complete.'}
          </Callout>
        ) : evaluate.data ? (
          <Verdict
            instanceLabel={chosen?.label ?? 'the instance'}
            matched={evaluate.data.matched}
            rejections={evaluate.data.rejections}
          />
        ) : (
          <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
            Not evaluated yet. Asking an instance runs a live search against your indexers and
            can take a minute.
          </p>
        )}

        {destinations.length === 0 ? (
          <p className="subtle" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-3)' }}>
            No Sonarr or Radarr instance is configured, so there is nothing to ask.
          </p>
        ) : (
          <div className="evaluate-row">
            <label className="sr-only" htmlFor="evaluate-target">Instance to evaluate against</label>
            <select
              id="evaluate-target"
              className="input"
              value={chosen?.instanceId ?? ''}
              onChange={(e) => setTarget(e.target.value)}
            >
              {destinations.map((destination) => (
                <option key={destination.instanceId} value={destination.instanceId}>
                  {destination.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={evaluate.isPending || chosen === null}
              onClick={() => {
                if (!chosen) return;
                evaluate.mutate({
                  instanceId: chosen.instanceId,
                  title: release.title,
                  infoHash: release.infoHash,
                });
              }}
            >
              <Icon name="alert" size={12} />
              {evaluate.isPending
                ? 'Evaluating…'
                : evaluate.data || evaluate.isError ? 'Re-evaluate' : 'Evaluate'}
            </button>
          </div>
        )}
      </InspectorGroup>
    </Inspector>
  );
}

function Verdict({
  instanceLabel,
  matched,
  rejections,
}: {
  instanceLabel: string;
  matched: boolean;
  rejections: string[];
}) {
  if (!matched) {
    return (
      <Callout tone="warn">
        {instanceLabel}&apos;s own search did not return this release, so it has no verdict on it.
        That is usually the reason the release is invisible from {instanceLabel}.
      </Callout>
    );
  }

  if (rejections.length === 0) {
    return (
      <Callout tone="ok">
        {instanceLabel} would accept this release — its decision engine raised no objection.
      </Callout>
    );
  }

  return (
    <>
      <Callout tone="warn">
        Rejected by {instanceLabel} — {rejections.length} reason{rejections.length === 1 ? '' : 's'}.
      </Callout>
      {/* Verbatim, one per line, unabridged. Summarising here would delete the
          one sentence that tells the operator what to change (REQ-SEARCH-006). */}
      <ul className="msg-list" style={{ marginTop: 'var(--space-3)' }}>
        {rejections.map((reason, i) => <li key={`${i}-${reason}`}>{reason}</li>)}
      </ul>
      <p className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-3)' }}>
        This does not block the grab. helparr reports the decision engine; it does not enforce it.
      </p>
    </>
  );
}

/** ISO in, `2026-09-14 08:12` out. Local time, because that is the clock the
 *  operator is comparing against when they ask "how fresh is this". */
function formatPublished(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
