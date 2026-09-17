'use client';

import Icon from '@/components/Icon';
import { DiffBlock } from '@/components/rename/PathDiff';
import { rowStatus, WARNING_COPY, type GridMode } from '@/components/rename/planView';
import { Callout, Inspector, InspectorGroup, KV, StatusBadge } from '@/components/ui';
import type { RenamePlanRow } from '@/lib/types';

/**
 * One row, explained (T12, FR3, FR6, ADR-3, ADR-9).
 *
 * Beside the grid, never over it — the operator is comparing this row against
 * the ones around it, and a modal would hide exactly what they are comparing.
 *
 * Two things live here and nowhere else: the full before/after paths, which do
 * not fit in a row, and the precondition pair (file id + the path as it was at
 * preview time) that the apply is checked against. The second is what makes the
 * refusal comprehensible when it happens — an operator who never saw the
 * recorded path has no way to tell a drift from a bug.
 */

export interface RenameInspectorProps {
  row: RenamePlanRow;
  mode: GridMode;
  onClose: () => void;
  /** Absent once the plan can no longer be edited. */
  onSetExcluded?: (rowIds: string[], excluded: boolean) => void;
  busy?: boolean;
}

export default function RenameInspector({
  row, mode, onClose, onSetExcluded, busy = false,
}: RenameInspectorProps) {
  const status = rowStatus(row, mode);

  return (
    <Inspector
      label="Rename detail"
      eyebrow={(
        <>
          {row.titleLabel}
          <span className="inspector__eyebrow-sep"> · </span>
          {row.instanceLabel}
        </>
      )}
      title={<span className="mono">{row.existingPath.split(/[\\/]/).pop()}</span>}
      onClose={onClose}
      footer={onSetExcluded ? (
        <button
          type="button"
          className={row.excluded ? 'btn btn-outline btn-sm' : 'btn btn-ghost btn-sm'}
          disabled={busy}
          onClick={() => onSetExcluded([row.id], !row.excluded)}
        >
          <Icon name={row.excluded ? 'plus' : 'x'} size={12} />
          {row.excluded ? 'Put this file back in the plan' : 'Exclude this file from the plan'}
        </button>
      ) : undefined}
    >
      <InspectorGroup title="Status">
        <StatusBadge tone={status.tone} icon={status.icon}>
          <span aria-hidden="true">{status.label}</span>
          <span className="sr-only">{status.spoken}</span>
        </StatusBadge>
        {row.outcomeDetail ? (
          <p className="inspector__note">{row.outcomeDetail}</p>
        ) : null}
      </InspectorGroup>

      <InspectorGroup title="Rename">
        <DiffBlock existingPath={row.existingPath} proposedPath={row.proposedPath} />
      </InspectorGroup>

      {row.warnings.length > 0 ? (
        <InspectorGroup title="Flags">
          {/* Attributed once, at the top of the group, so it cannot be read off
              a single badge as though the instance had said it (ADR-9). */}
          <Callout tone="info">
            These are helparr&rsquo;s own readings of the plan. Neither Sonarr nor Radarr
            reports a warning of any kind on a rename preview — if one of these is wrong,
            it is helparr that is wrong.
          </Callout>
          <ul className="msg-list">
            {row.warnings.map((warning) => (
              <li key={warning}>
                <strong>{WARNING_COPY[warning].label}</strong> — {WARNING_COPY[warning].detail}
              </li>
            ))}
          </ul>
        </InspectorGroup>
      ) : null}

      <InspectorGroup title="What the apply is checked against">
        <KV rows={[
          ['File id', <span className="mono" key="f">{row.fileId}</span>],
          ['Path at preview', <span className="mono kv__wrap" key="p">{row.existingPath}</span>],
          ['Proposed path', <span className="mono kv__wrap" key="q">{row.proposedPath}</span>],
          ['Instance', row.instanceLabel],
          ['Title', row.titleLabel],
        ]}
        />
        <p className="inspector__note">
          Applying re-checks both of these against the instance first. If the file has moved,
          been replaced or been deleted since this preview was built, the whole plan is
          refused and nothing is renamed — including the rows that had not drifted.
        </p>
      </InspectorGroup>
    </Inspector>
  );
}
