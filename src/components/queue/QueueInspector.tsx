'use client';

import Link from 'next/link';
import { useState, type CSSProperties, type ReactNode } from 'react';

import {
  ComparisonBreakdown,
  keepActivationKeys,
  reasonsConcernComparison,
  UNREADABLE,
} from '@/components/decisions/DecisionExplainer';
import { useExplain } from '@/components/decisions/useExplain';
import Icon from '@/components/Icon';
import CauseGroup from '@/components/queue/CauseGroup';
import { Callout, Inspector, InspectorGroup, KV } from '@/components/ui';
import type {
  DecisionsFailureKind,
  ExplainResult,
  ImportCandidateExplanation,
} from '@/lib/api';
import {
  canOfferForceImport,
  etaOf,
  forceImportHref,
  formatAge,
  formatBytes,
  formatSpeed,
  needsAttention,
  progressOf,
  stallDisagreement,
} from '@/lib/queue';
import type { QueueRecord } from '@/lib/types';

/**
 * The inspector (REQ-QUEUE-004, -011, T15 — deviation D2).
 *
 * A right-hand panel, not a modal: the operator is comparing this row against
 * the ones around it, and a dialog would hide exactly the context that makes
 * the comparison worth making.
 *
 * The four upstream channels are rendered **verbatim and separately**. Collapsing
 * them into one derived sentence is what the prototype did and what
 * REQ-QUEUE-004 forbids — `trackedDownloadStatus: ok` alongside
 * `trackedDownloadState: importBlocked` is a diagnosis, and it only exists if
 * both are on screen.
 *
 * The Cause group (T15, REQ-QUEUE-018..021) renders **first** and adds to those
 * channels; it never replaces them. Its actions live in the footer, and each is
 * there only when the cause names it: force import is absent — not disabled —
 * for every cause but `import-not-performed` and `import-rejected`.
 */
export interface QueueInspectorProps {
  record: QueueRecord;
  onClose: () => void;
  /** Opens the removal preview with its non-destructive defaults. */
  onRemove: () => void;
  /** Opens the removal preview with the remove-and-blocklist remedy's flags
   *  pre-set. Offered only when the cause names that remedy. */
  onRemoveAndBlocklist: () => void;
  /** Whether the panel is at its expanded width (ADR-1). */
  expanded?: boolean;
  /** Supplying this renders the head's expand toggle. */
  onToggleExpand?: () => void;
}

export default function QueueInspector({
  record,
  onClose,
  onRemove,
  onRemoveAndBlocklist,
  expanded,
  onToggleExpand,
}: QueueInspectorProps) {
  const progress = progressOf(record);
  const disagreement = stallDisagreement(record);
  const forceImport = canOfferForceImport(record.cause);
  const removeAndBlocklist = record.cause.remedies.includes('remove-and-blocklist');

  return (
    <Inspector
      eyebrow={`${record.instanceLabel} · ${record.protocol}`}
      title={record.title}
      onClose={onClose}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      footer={
        <>
          {/* The recommended action first, matching the remedy order above. The
              import screen builds its own plan from these two parameters. */}
          {forceImport ? (
            <Link className="btn btn-primary btn-sm" href={forceImportHref(record)}>
              <Icon name="import" size={12} />Force import
            </Link>
          ) : null}
          {removeAndBlocklist ? (
            <button type="button" className="btn btn-danger btn-sm" onClick={onRemoveAndBlocklist}>
              <Icon name="x" size={12} />Remove + blocklist
            </button>
          ) : (
            // Always available, never cause-specific. Where the cause is not a
            // known fault it is an escape hatch, and is not styled as a fix.
            <button
              type="button"
              className={`btn ${needsAttention(record) ? 'btn-danger' : 'btn-outline'} btn-sm`}
              onClick={onRemove}
            >
              <Icon name="x" size={12} />Remove from queue
            </button>
          )}
        </>
      }
    >
      <CauseGroup record={record} />

      {/* Directly below the Cause group, above the upstream channels: the
          comparison is the cause's own detail (T19). Keyed on the record so a
          reused inspector never shows the previous row's files under this
          row's title. */}
      {record.cause.kind === 'import-rejected' && record.downloadId ? (
        <ImportComparison
          key={record.id}
          instanceId={record.instanceId}
          instanceLabel={record.instanceLabel}
          downloadId={record.downloadId}
        />
      ) : null}

      {disagreement || record.errorMessage ? (
        // Below the Cause group rather than above it: the group is the verdict,
        // and these are the upstream-facing findings that sit under it.
        <div style={{ marginTop: 'var(--space-5)' }}>
          {disagreement ? (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              {/* The disagreement is the finding, not an inconsistency to hide. */}
              <Callout tone="warn">{disagreement}</Callout>
            </div>
          ) : null}

          {record.errorMessage ? (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Callout tone="error">{record.errorMessage}</Callout>
            </div>
          ) : null}
        </div>
      ) : null}

      <InspectorGroup title="Upstream state">
        <KV
          rows={[
            ['status', <span key="s" className="mono">{record.status || '—'}</span>],
            ['trackedDownloadStatus', (
              <span key="tds" className="mono">{record.trackedDownloadStatus || '—'}</span>
            )],
            ['trackedDownloadState', (
              <span key="tdst" className="mono">{record.trackedDownloadState || '—'}</span>
            )],
            ['statusMessages', <StatusMessages key="sm" record={record} />],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Download client">
        {record.torrent ? (
          <KV
            rows={[
              ['stalled', record.stall.stalled ? `yes — ${record.stall.evidence}` : 'no'],
              ['fetching metadata', record.torrent.fetchingMetadata ? 'yes' : 'no'],
              ['client state', <span key="cs" className="mono">{record.torrent.state}</span>],
              ['seeders', `${record.torrent.numSeeds}`],
              ['leechers', `${record.torrent.numLeechs}`],
              ['speed', formatSpeed(record.torrent.dlspeed)],
            ]}
          />
        ) : (
          /* Un-enriched is a legible state, not a blank. Saying why keeps the
             operator from reading the gap as "nothing is wrong" (ADR-3). */
          <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
            {record.downloadId
              ? 'No download client reported this hash. The row is shown un-enriched rather than '
                + 'matched on title, which would attach the wrong torrent.'
              : 'This record has no download id — nothing to match against a download client.'}
          </p>
        )}
      </InspectorGroup>

      <InspectorGroup title="Transfer">
        <KV
          rows={[
            ['Progress', `${progress}% — ${formatBytes(record.size - record.sizeleft)} of ${formatBytes(record.size)}`],
            ['ETA', etaOf(record)],
            ['Protocol', record.protocol || '—'],
            ['Indexer', record.indexer ?? '—'],
          ]}
        />
      </InspectorGroup>

      <InspectorGroup title="Routing">
        <KV
          rows={[
            ['Target', record.targetLabel],
            ['Managed by', `${record.instanceLabel} (${record.instanceKind})`],
            ['Record id', <span key="r" className="mono">{record.recordId}</span>],
            ['Download id', <span key="d" className="mono">{record.downloadId ?? '—'}</span>],
          ]}
        />
      </InspectorGroup>
    </Inspector>
  );
}

/** Every message, every line. Truncating the one that names the actual problem
 *  is the failure mode this list exists to avoid. */
function StatusMessages({ record }: { record: QueueRecord }) {
  if (record.statusMessages.length === 0) return <span className="subtle">none</span>;
  return (
    <ul className="msg-list">
      {record.statusMessages.map((message, i) => (
        <li key={`${message.title}-${i}`}>
          <span className="mono">{message.title}</span>
          {message.messages.length > 0 ? (
            <ul className="msg-list msg-list--nested">
              {message.messages.map((line, j) => <li key={j}>{line}</li>)}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ── The comparison for `import-rejected` rows (T19; FR17, REQ-DEC-006, -008) ─

   The shared `DecisionExplainer` runs its own explain call from a candidate
   the caller already holds. A queue row holds no candidate: the files the
   instance refused are only known after reading the download's `manualimport`
   candidates, and that read returns each file's comparison already built. So
   this renders those pre-computed results in the explainer's arrangement —
   the instance's reasons first and verbatim, then candidate vs. on disk, the
   custom formats, the profile, the verdict and the attribution line — rather
   than mounting the explainer once per file and paying for every read twice.

   Nothing is read on open (NFR2): the button is the only trigger. */

/** What a failed candidate read could not reach, phrased as what went wrong with the instance. */
const READ_FAILURE: Record<DecisionsFailureKind, string> = {
  unreachable: 'the instance did not answer',
  unauthorized: 'the instance refused helparr\'s API key',
  'upstream-error': 'the instance answered with an error',
  timeout: 'the instance did not answer in time',
  'no-instance': 'the instance is no longer configured in helparr',
  'not-decisions-client': 'this kind of instance has no import candidates to read',
};

function ImportComparison({
  instanceId,
  instanceLabel,
  downloadId,
}: {
  instanceId: string;
  instanceLabel: string;
  downloadId: string;
}) {
  const {
    explainImportCandidates,
    importCandidatesResult: result,
    explainingImportCandidates: pending,
    importCandidatesError: thrown,
    refreshConfig,
    refreshConfigResult,
    refreshingConfig,
  } = useExplain();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const run = () => {
    // A thrown error is a malformed or unsendable request; the hook keeps it
    // in `importCandidatesError`, which renders below. It must not escape as
    // an unhandled rejection.
    explainImportCandidates({ instanceId, downloadId }).catch(() => undefined);
  };

  const refresh = () => {
    setRefreshError(null);
    refreshConfig(instanceId)
      .then((refreshed) => {
        // A fresh cache means fresh comparisons: re-read rather than leave the
        // old numbers under a new timestamp.
        if (refreshed.ok) run();
      })
      .catch((error: unknown) => {
        setRefreshError(error instanceof Error ? error.message : 'The refresh did not complete.');
      });
  };

  let body: ReactNode;
  if (pending) {
    body = (
      <p className="subtle" role="status" style={NOTE}>
        Reading {instanceLabel}&apos;s import candidates for this download, its quality profile,
        custom formats and the files on disk…
      </p>
    );
  } else if (thrown) {
    body = (
      <>
        <Callout tone="error">
          <p>
            The comparison request did not complete: {thrown.message}. The reasons in the Cause
            group are unchanged; only the side-by-side breakdown is missing.
          </p>
        </Callout>
        <CompareButton label="Try again" onClick={run} />
      </>
    );
  } else if (result && !result.ok) {
    body = (
      <>
        <Callout tone="warn">
          <p>
            {instanceLabel}&apos;s import candidates could not be read — {READ_FAILURE[result.error.kind]}.
            The reasons in the Cause group are unchanged; only the side-by-side breakdown is missing.
          </p>
          <p className="mono" style={{ ...NOTE, marginTop: 'var(--space-2)' }}>{result.error.reason}</p>
        </Callout>
        <CompareButton label="Try again" onClick={run} />
      </>
    );
  } else if (result?.ok) {
    body = result.value.length === 0 ? (
      <p className="subtle" style={NOTE}>
        {instanceLabel} reported no rejected files for this download.
      </p>
    ) : (
      <>
        {result.value.map((explanation, i) => (
          <CandidateFile
            key={`${i}-${explanation.path}`}
            explanation={explanation}
            instanceLabel={instanceLabel}
            first={i === 0}
          />
        ))}
        <ConfigAge
          results={result.value.map((explanation) => explanation.result)}
          instanceLabel={instanceLabel}
          refreshing={refreshingConfig}
          onRefresh={refresh}
          refreshFailure={
            refreshError
            ?? (refreshConfigResult && !refreshConfigResult.ok ? refreshConfigResult.error.reason : null)
          }
        />
      </>
    );
  } else {
    body = (
      <>
        <p className="subtle" style={NOTE}>
          Compare each file {instanceLabel} refused with the file on disk: both sides&apos;
          quality, every matched custom format with its score, and the profile thresholds{' '}
          {instanceLabel} applies.
        </p>
        <CompareButton label="Compare with the files on disk" onClick={run} />
      </>
    );
  }

  return (
    <InspectorGroup title="Comparison">
      <section aria-label="Rejected files compared with the files on disk" aria-busy={pending} style={STACK}>
        {body}
      </section>
    </InspectorGroup>
  );
}

function CompareButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div>
      <button type="button" className="btn btn-outline btn-sm" onClick={onClick} onKeyDown={keepActivationKeys}>
        <Icon name="eye" size={12} />
        {label}
      </button>
    </div>
  );
}

/** One refused file: its name, the instance's reasons verbatim, then the comparison or why it is missing. */
function CandidateFile({
  explanation,
  instanceLabel,
  first,
}: {
  explanation: ImportCandidateExplanation;
  instanceLabel: string;
  first: boolean;
}) {
  const { name, path, result } = explanation;
  // Either branch carries the instance's own reasons (REQ-DEC-008): a failed
  // comparison never costs the operator the sentence that explains the refusal.
  const rejections = result.ok ? result.value.rejections : result.error.rejections;
  const relevant = reasonsConcernComparison(rejections);

  return (
    <article style={first ? STACK : { ...STACK, ...DIVIDED }}>
      <div>
        <h4 className="mono" style={{ ...NOTE, margin: 0, overflowWrap: 'anywhere' }}>{name}</h4>
        {path !== name ? (
          <p className="subtle mono" style={{ fontSize: 'var(--text-xs)', overflowWrap: 'anywhere' }}>{path}</p>
        ) : null}
      </div>

      <Callout tone="warn">
        Rejected by {instanceLabel} — {rejections.length} reason{rejections.length === 1 ? '' : 's'}.
      </Callout>
      {/* Verbatim, one per line, unabridged — never reworded (REQ-DEC-001). */}
      <ul className="msg-list">
        {rejections.map((reason, i) => <li key={`${i}-${reason}`}>{reason}</li>)}
      </ul>

      {!relevant ? null : result.ok ? (
        <ComparisonBreakdown
          comparison={result.value}
          instanceLabel={instanceLabel}
          headingLevel="h5"
          missingProfile={(
            <Callout tone="warn">
              <p>
                The quality profile this file is scored against was not found among{' '}
                {instanceLabel}&apos;s profiles, so its thresholds cannot be stated and helparr
                cannot sum the per-format scores.
              </p>
            </Callout>
          )}
        />
      ) : (
        <FailedComparison result={result} instanceLabel={instanceLabel} />
      )}
    </article>
  );
}

function FailedComparison({
  result,
  instanceLabel,
}: {
  result: Extract<ExplainResult, { ok: false }>;
  instanceLabel: string;
}) {
  const { rejections, kind, reason } = result.error;
  return (
    <Callout tone="warn">
      <p>
        The comparison could not be built — {instanceLabel}: {UNREADABLE[kind]}. The
        reason{rejections.length === 1 ? ' above is' : 's above are'} {instanceLabel}&apos;s own,
        unchanged; only the side-by-side breakdown is missing.
      </p>
      <p className="mono" style={{ ...NOTE, marginTop: 'var(--space-2)' }}>{reason}</p>
    </Callout>
  );
}

/**
 * One config line for the whole list rather than one per file: every
 * comparison here came from the same cache read, so one age and one Refresh
 * say it once instead of repeating identical controls down the panel. The
 * oldest age is the one stated, so nothing reads fresher than it is.
 */
function ConfigAge({
  results,
  instanceLabel,
  refreshing,
  onRefresh,
  refreshFailure,
}: {
  results: ExplainResult[];
  instanceLabel: string;
  refreshing: boolean;
  onRefresh: () => void;
  refreshFailure: string | null;
}) {
  const fetchedAt = results
    .flatMap((result) => (result.ok ? [result.value.configFetchedAt] : []))
    .sort()[0];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {fetchedAt ? (
          <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
            Config <time dateTime={fetchedAt}>{formatAge(fetchedAt)}</time>
          </span>
        ) : null}
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
            comparisons above are from the earlier read.
          </p>
        </Callout>
      ) : null}
    </>
  );
}

const STACK: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' };
const DIVIDED: CSSProperties = {
  borderTop: '1px solid var(--color-border-subtle)',
  paddingTop: 'var(--space-4)',
};
const NOTE: CSSProperties = { fontSize: 'var(--text-sm)' };
