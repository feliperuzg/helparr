'use client';

import { useState } from 'react';

import Icon from '@/components/Icon';
import PurgeDialog from '@/components/operations/PurgeDialog';
import { useOperations, usePurgeOperations } from '@/components/search/useSearch';
import {
  Callout, ChipGroup, EmptyState, FilterChip, ScreenHead, StatusDot, ToastStack, useToasts,
  type Tone,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { OPERATION_FILTERS, type OperationFilter, type OperationRead } from '@/lib/types';

/**
 * The operation log viewer (REQ-OPS-003…-006; FR10, FR11; T20).
 *
 * Deliberately plain. The log's job is to be trustworthy, not clever: every
 * write helparr has made, in the order it made them, with the upstream's own
 * words for why each one ended the way it did.
 *
 * Two properties are structural rather than stylistic:
 *
 * - **No download URL appears here, because there is none in the table**
 *   (REQ-OPS-004, ADR-7). The SHA-256 prefix exists so two rows for the same
 *   release can be recognised as such. It is not a link.
 * - **Rejection reasons are printed in full.** The same rule the inspector
 *   follows: every reason, verbatim, one per line (REQ-SEARCH-006).
 */

const CHIP_LABEL: Record<OperationFilter, string> = {
  all: 'All',
  succeeded: 'Succeeded',
  rejected: 'Rejected',
  failed: 'Failed',
};

export default function OperationsScreen() {
  const { toasts, push } = useToasts();
  const [filter, setFilter] = useState<OperationFilter>('all');
  const [purging, setPurging] = useState(false);

  const operations = useOperations(filter);
  const purge = usePurgeOperations();

  const rows = operations.data?.operations ?? [];
  const counts = operations.data?.counts;
  const total = counts?.all ?? 0;

  function confirmPurge() {
    purge.mutate(
      // The count the dialog stated, not the count at the moment of the click.
      // The route refuses a mismatch rather than deleting a different number of
      // rows than the sentence the operator agreed to.
      { expect: total },
      {
        onSuccess: ({ purged }) => {
          setPurging(false);
          push(`Purged ${purged} operation${purged === 1 ? '' : 's'}.`, 'ok');
        },
        onError: (error) => {
          push(
            error instanceof ApiError
              ? error.message
              : 'The purge did not complete. Nothing was deleted.',
            'error',
          );
        },
      },
    );
  }

  return (
    <main className="main" id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Activity"
          sub="Every write helparr has made against your instances. Nothing here is modified or removed in the course of normal use."
        />

        <div className="toolbar oplog-toolbar">
          <ChipGroup label="Filter by outcome">
            {OPERATION_FILTERS.map((option) => (
              <FilterChip
                key={option}
                label={CHIP_LABEL[option]}
                selected={filter === option}
                onToggle={() => setFilter(option)}
                count={counts?.[option]}
              />
            ))}
          </ChipGroup>
          <span className="toolbar__spacer" />
          <button
            type="button"
            className="btn btn-danger btn-sm oplog-purge"
            onClick={() => setPurging(true)}
            disabled={total === 0 || purge.isPending}
          >
            <Icon name="x" size={12} />Purge…
          </button>
        </div>

        <div className="content__scroll">
          <section className="section">
            {operations.isError ? (
              <Callout tone="error">
                {operations.error instanceof ApiError
                  ? operations.error.message
                  : 'Could not read the operation log.'}
              </Callout>
            ) : operations.isPending ? (
              <p className="subtle" style={{ fontSize: 12 }}>Reading the log…</p>
            ) : rows.length === 0 ? (
              <EmptyState title={filter === 'all' ? 'No operations recorded' : `No ${CHIP_LABEL[filter].toLowerCase()} operations`}>
                {filter === 'all'
                  ? 'helparr has not written anything to your instances yet. Grabs, attaches and renames all land here.'
                  : 'Nothing in the log ended that way. Switch the filter to see the rest.'}
              </EmptyState>
            ) : (
              <ul className="oplog card">
                {rows.map((row) => <OperationRow key={row.id} row={row} />)}
              </ul>
            )}
          </section>

          {counts ? (
            <section className="section">
              <p className="subtle" style={{ fontSize: 11 }}>
                {filter === 'all'
                  ? `${total} operation${total === 1 ? '' : 's'}`
                  : `${rows.length} of ${total} operations`}
                {operations.data?.oldestAt ? ` · oldest ${formatStamp(operations.data.oldestAt)}` : ''}
                {' · retention unlimited — rows leave only when you purge them'}
              </p>
            </section>
          ) : null}
        </div>
      </div>

      {purging ? (
        <PurgeDialog
          total={total}
          failures={(counts?.rejected ?? 0) + (counts?.failed ?? 0)}
          busy={purge.isPending}
          onCancel={() => setPurging(false)}
          onConfirm={confirmPurge}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </main>
  );
}

/**
 * One row, five lines. The outcome is carried by the dot, the word and the
 * position at once — never by colour alone (DESIGN.md §7).
 */
function OperationRow({ row }: { row: OperationRead }) {
  const { word, tone } = outcomeOf(row);

  return (
    <li className="oplog__row">
      <p className="oplog__head">
        <StatusDot tone={tone} label={word} />
        <span className="oplog__outcome">{word}</span>
        <span className="oplog__at mono subtle">{formatStamp(row.at)}</span>
      </p>

      <p className="oplog__summary">{row.summary}</p>
      <p className="oplog__title mono truncate">{row.entityTitle}</p>

      <p className="oplog__meta subtle">
        {[
          row.indexer,
          // Six characters of the digest — enough to match two rows by eye,
          // and it is all the table holds. There is no URL to reveal.
          row.urlSha256 ? `url sha256 ${row.urlSha256.slice(0, 6)}…` : null,
          row.urlHost,
          `${row.instanceLabel} (${row.instanceKind})`,
        ].filter(Boolean).join(' · ')}
      </p>

      {row.detail.length === 0 ? null : (
        <ul className="msg-list oplog__detail">
          {row.detail.map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}
        </ul>
      )}
    </li>
  );
}

/**
 * `rejected` is a split of `failed`, not a third outcome (REQ-OPS-001). The
 * split exists because "your profile said no" and "radarr returned 502" need
 * different responses from the operator.
 */
function outcomeOf(row: OperationRead): { word: string; tone: Tone } {
  if (row.outcome === 'succeeded') return { word: 'Succeeded', tone: 'ok' };
  return row.rejected ? { word: 'Rejected', tone: 'warn' } : { word: 'Failed', tone: 'error' };
}

/** Local time, to the second: two grabs of the same release a minute apart are
 *  two rows, and the timestamp is what tells them apart. */
function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
