'use client';

import type { CSSProperties, ReactNode } from 'react';

import Icon from '@/components/Icon';
import { Callout, InspectorGroup, StatusBadge } from '@/components/ui';
import {
  CAUSE_ICON,
  CAUSE_LABEL,
  CAUSE_TONE,
  REMEDY_REMOVAL_FLAGS,
  canOfferForceImport,
} from '@/lib/queue';
import type {
  CauseEvidence,
  CauseRemedy,
  QueueCause,
  QueueCauseKind,
  QueueRecord,
  RemovalRequest,
} from '@/lib/types';

/**
 * The queue inspector's Cause group (REQ-QUEUE-018..021, T15).
 *
 * Three rules, all of them about not overstating:
 *
 * 1. **Provenance is visible.** An inferred cause sits in the same `info`
 *    callout, with the same sentence, as `GapInspector`'s inference
 *    (REQ-QUEUE-020 "on the same terms as REQ-GAPS-007"). A reported cause is
 *    plain text with no box at all — the contrast between the two is the proof
 *    that they are different things.
 * 2. **Evidence is shown as it was recorded**, each line under the source that
 *    produced it, so the operator can check the reading against the values it
 *    rests on.
 * 3. **Every remedy says whether helparr can perform it**, and a cause with no
 *    remedy says so in words rather than offering an action that will not help
 *    (REQ-QUEUE-019). The actions themselves live in the inspector's footer;
 *    this group describes them.
 */

/* ---------------------------------------------------------------------------
   CauseBadge — the grid's cell and the inspector's heading are one component,
   so the two can never render the same cause differently. Icon and text both,
   never colour alone (DESIGN.md §7).
   ------------------------------------------------------------------------- */
export function CauseBadge({ cause }: { cause: QueueCause }) {
  return (
    <StatusBadge tone={CAUSE_TONE[cause.kind]} icon={CAUSE_ICON[cause.kind]}>
      {CAUSE_LABEL[cause.kind]}
    </StatusBadge>
  );
}

export interface CauseGroupProps {
  record: QueueRecord;
}

export default function CauseGroup({ record }: CauseGroupProps) {
  const { cause, instanceLabel } = record;
  const inferred = cause.provenance === 'inferred';

  return (
    <InspectorGroup title="Cause">
      <div style={ROW}>
        <CauseBadge cause={cause} />
      </div>

      {inferred ? (
        // Deliberately the `info` tone, never `warn`: this is helparr talking,
        // and it is marked as such twice over — by the tone and by the sentence.
        <div style={ROW}>
          <Callout tone="info">
            <strong style={{ display: 'block', marginBottom: 'var(--space-2)' }}>
              helparr&apos;s reading — not reported by {instanceLabel}
            </strong>
            {summary(cause.kind, instanceLabel)}
          </Callout>
        </div>
      ) : (
        <div style={ROW}>
          <p style={PROSE}>{reportedBy(cause.kind, instanceLabel)}</p>
          <p style={PROSE}>{summary(cause.kind, instanceLabel)}</p>
        </div>
      )}

      <div style={ROW}>
        <h4 className="eyebrow" style={SUBHEAD}>
          {inferred ? 'Evidence' : `Evidence — verbatim, from ${instanceLabel}`}
        </h4>
        <EvidenceList evidence={cause.evidence} />
      </div>

      <div>
        <h4 className="eyebrow" style={SUBHEAD}>Remedies</h4>
        <RemedyList record={record} />
      </div>
    </InspectorGroup>
  );
}

/** Each line under the source that produced it. The text is never reworded:
 *  for `import-rejected` it is the instance's own `statusMessages`. */
function EvidenceList({ evidence }: { evidence: CauseEvidence[] }) {
  if (evidence.length === 0) {
    return <p className="subtle" style={PROSE}>No evidence was recorded for this cause.</p>;
  }
  return (
    <ul style={LIST}>
      {evidence.map((line, i) => (
        <li key={`${line.source}-${i}`} style={EVIDENCE_ITEM}>
          <span className="eyebrow" style={{ display: 'block' }}>{line.source}</span>
          <span className="mono" style={{ overflowWrap: 'anywhere' }}>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The first remedy the classifier names is the recommended one — marked with a
 * check, and announced as such, because the glyph alone is not a channel a
 * screen reader hears. The rest are available but not recommended.
 */
function RemedyList({ record }: { record: QueueRecord }) {
  const { cause, instanceLabel } = record;

  // Force import is listed only where it may also be offered — the same gate
  // the footer uses, so a description can never promise a missing button.
  const remedies = cause.remedies.filter(
    (remedy) => remedy !== 'force-import' || canOfferForceImport(cause),
  );

  const lines: Array<{ key: string; recommended: boolean; body: ReactNode }> = remedies.map(
    (remedy, i) => ({
      key: remedy,
      recommended: i === 0 && remedy !== 'wait',
      body: describeRemedy(remedy, cause.kind, instanceLabel),
    }),
  );

  // FR11: there is no payload to import. Said outright, so the absence of the
  // button reads as a decision rather than an oversight.
  if (cause.kind === 'payload-missing') {
    lines.push({
      key: 'no-force-import',
      recommended: false,
      body: 'Force import is not offered — there is no payload to import.',
    });
  }

  if (remedies.length === 0) {
    lines.push({
      key: 'none',
      recommended: false,
      body: cause.kind === 'healthy'
        ? 'None needed.'
        : 'helparr cannot remediate this — nothing it can perform would resolve it on this '
          + `evidence. Check ${instanceLabel} directly if it persists.`,
    });
  }

  return (
    <ul style={LIST}>
      {lines.map((line) => (
        <li key={line.key} style={REMEDY_ITEM}>
          <span aria-hidden="true" style={REMEDY_MARK}>
            {line.recommended ? <Icon name="check" size={12} /> : '•'}
          </span>
          <span>
            {line.recommended ? <span className="sr-only">Recommended: </span> : null}
            {line.body}
          </span>
        </li>
      ))}
    </ul>
  );
}

function describeRemedy(
  remedy: CauseRemedy,
  kind: QueueCauseKind,
  instanceLabel: string,
): ReactNode {
  switch (remedy) {
    case 'force-import':
      return kind === 'import-rejected'
        ? <><strong>Force import</strong> — helparr can perform this, accepting the release over {instanceLabel}&apos;s rejection. Opens the import screen.</>
        : <><strong>Force import</strong> — helparr can perform this. Opens the import screen with {instanceLabel}&apos;s own candidates.</>;
    case 'remove-and-blocklist':
      return (
        <>
          <strong>Remove + blocklist</strong> — helparr can perform this. Opens removal with these
          flags pre-set, each still yours to change before anything is sent:
          <RemovalFlags flags={REMEDY_REMOVAL_FLAGS} />
        </>
      );
    case 'wait':
      return (
        <>
          <strong>Wait</strong> — no action is offered. The download finished moments ago and{' '}
          {instanceLabel} normally imports it on its own. If it is still here five minutes after
          completion it becomes Not imported, and force import is offered then.
        </>
      );
    default:
      return null;
  }
}

/** Which removal flags the remedy corresponds to (REQ-QUEUE-019), stated as
 *  on/off in words — a tick and a cross alone would be colour-and-glyph only. */
function RemovalFlags({ flags }: { flags: RemovalRequest }) {
  const entries = Object.entries(flags) as Array<[keyof RemovalRequest, boolean]>;
  return (
    <ul style={{ ...LIST, marginTop: 'var(--space-1)', gap: 'var(--space-1)' }}>
      {entries.map(([key, on]) => (
        <li key={key} className="mono" style={{ fontSize: 'var(--text-xs)' }}>
          {key} <span className={on ? undefined : 'subtle'}>{on ? 'on' : 'off'}</span>
          {key === 'skipRedownload' && !on ? (
            <span className="subtle"> — the re-search is wanted</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Who reported a cause that is not helparr's own reading. */
function reportedBy(kind: QueueCauseKind, instanceLabel: string): string {
  if (kind === 'healthy') {
    return `${instanceLabel} and the download client agree — nothing here is helparr's own reading.`;
  }
  return `Reported by ${instanceLabel} — not helparr's reading.`;
}

/** One sentence on what the cause means. The evidence below is what it rests on. */
function summary(kind: QueueCauseKind, instanceLabel: string): string {
  switch (kind) {
    case 'healthy':
      return 'Actively transferring, and the download client evidence agrees.';
    case 'stalled':
      return 'The download client shows this download is not moving.';
    case 'importing':
      return `The download completed under five minutes ago and ${instanceLabel} has not `
        + 'imported it yet — usual for a download this fresh.';
    case 'import-not-performed':
      return `The download completed more than five minutes ago and ${instanceLabel} has not `
        + 'imported it. No statusMessages were returned, so this is read from dwell time, '
        + 'not from a report.';
    case 'import-rejected':
      return `${instanceLabel} attempted the import and refused it. Its reasons are below, `
        + 'word for word.';
    case 'payload-missing':
      return 'The download client reports no usable payload for this download.';
    case 'unknown':
      return 'There is not enough evidence to call this healthy or to name a specific fault.';
    default:
      return '';
  }
}

const ROW: CSSProperties = { marginBottom: 'var(--space-4)' };
const SUBHEAD: CSSProperties = { margin: '0 0 var(--space-2)' };
const PROSE: CSSProperties = { fontSize: 'var(--text-sm)', margin: 0 };
const LIST: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
};
const EVIDENCE_ITEM: CSSProperties = {
  borderLeft: '2px solid var(--color-border-strong)',
  paddingLeft: 'var(--space-3)',
  fontSize: 'var(--text-xs)',
};
const REMEDY_ITEM: CSSProperties = {
  display: 'flex',
  gap: 'var(--space-2)',
  alignItems: 'baseline',
  fontSize: 'var(--text-sm)',
};
const REMEDY_MARK: CSSProperties = {
  flex: 'none',
  width: 'var(--space-3)',
  color: 'var(--color-text-muted)',
};
