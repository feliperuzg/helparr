'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Icon from '@/components/Icon';
import DegradedBanner from '@/components/queue/DegradedBanner';
import InstanceHealthRail from '@/components/queue/InstanceHealthRail';
import QueueInspector from '@/components/queue/QueueInspector';
import QueueTable, { filterRecords, sortRecords, type Sort } from '@/components/queue/QueueTable';
import RemovalPreview from '@/components/queue/RemovalPreview';
import { DEFAULT_REFRESH_MS, useQueue, useRemoveFromQueue } from '@/components/queue/useQueue';
import { useQueueKeyboard, useSelection } from '@/components/queue/useQueueKeyboard';
import {
  BulkBar, Callout, EmptyState, KeyboardHints, ScreenHead, SearchField, StatusBadge,
  ToastStack, useToasts,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { deriveState, needsAttention } from '@/lib/queue';
import type { QueueRecord, RemovalRequest } from '@/lib/types';

/**
 * The overview screen (REQ-QUEUE-001…-017, T19).
 *
 * Everything the operator needs to answer "what is stuck?" lives on one screen:
 * the rail says which instances answered, the banner says which did not, and the
 * grid shows the union of what did. A degraded instance narrows the table — it
 * never blanks the screen.
 */

const HINTS: Array<[string[], string]> = [
  [['j', 'k'], 'move'],
  [['space'], 'select'],
  [['enter'], 'inspect'],
  [['/'], 'search'],
  [['esc'], 'close'],
];

export interface QueueScreenProps {
  /** Resolved on the server from `HELPARR_QUEUE_REFRESH_SECONDS` (ADR-2). */
  refreshMs?: number;
}

export default function QueueScreen({ refreshMs = DEFAULT_REFRESH_MS }: QueueScreenProps) {
  const { toasts, push } = useToasts();
  const searchRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ column: 'state', direction: 'asc' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<QueueRecord[] | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set());

  const queue = useQueue({ refreshMs });
  // The same query key the shell polls, so the rail and the sidebar badge can
  // never disagree about which instances are healthy.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
  const instances = useMemo(() => health.data?.instances ?? [], [health.data]);
  const remove = useRemoveFromQueue();
  const { selected, toggle, clear, reconcile } = useSelection();

  const records = useMemo(() => queue.data?.records ?? [], [queue.data]);
  const visible = useMemo(
    () => sortRecords(filterRecords(records, query), sort),
    [records, query, sort],
  );

  // Selection and the open inspector both key off record ids, so both have to be
  // reconciled against what the latest read actually returned. A selection that
  // outlives its row would make the bulk bar count rows nobody can see.
  const presentIds = useMemo(() => new Set(records.map((r) => r.id)), [records]);
  useEffect(() => { reconcile(presentIds); }, [presentIds, reconcile]);

  // Derived rather than synced: the inspector shows the open record only while
  // that record is still in the grid. A row that disappears upstream closes the
  // panel by itself, with no effect needed to notice.
  const openRecord = openId ? visible.find((r) => r.id === openId) ?? null : null;

  // Filtering closes the inspector outright. Leaving `openId` set would make the
  // panel reappear when the filter is later relaxed, which reads as the screen
  // reopening something the operator already dismissed.
  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    setOpenId(null);
  }, []);

  const onOpen = useCallback((index: number) => {
    setOpenId(visible[index]?.id ?? null);
  }, [visible]);

  const onToggleIndex = useCallback((index: number) => {
    const record = visible[index];
    if (record) toggle(record.id);
  }, [visible, toggle]);

  // One Escape does one thing: it closes the inspector if one is open, and only
  // otherwise falls through to clearing the selection.
  const onEscape = useCallback(() => {
    if (openId === null) return false;
    setOpenId(null);
    return true;
  }, [openId]);

  const { cursor, setCursor } = useQueueKeyboard({
    count: visible.length,
    onToggleSelect: onToggleIndex,
    onOpen,
    onEscape,
    onClearSelection: clear,
    searchRef,
    // The preview owns the keyboard while it is up — j/k moving a cursor behind
    // a confirmation dialog is how the wrong rows get removed.
    enabled: preview === null,
  });

  const retry = useMutation({
    mutationFn: (instanceId: string) => api.retryInstance(instanceId),
    onMutate: (instanceId) => { setRetrying((s) => new Set(s).add(instanceId)); },
    onSuccess: (_data, instanceId) => {
      const label = instances.find((i) => i.instanceId === instanceId)?.label ?? instanceId;
      push(`${label} will be contacted on the next refresh.`, 'ok');
      queue.refresh();
    },
    onError: (error) => {
      push(error instanceof ApiError ? error.message : 'Could not force a retry.', 'error');
    },
    onSettled: (_data, _error, instanceId) => {
      setRetrying((s) => { const next = new Set(s); next.delete(instanceId); return next; });
    },
  });

  const selectedRecords = useMemo(
    () => visible.filter((r) => selected.has(r.id)),
    [visible, selected],
  );

  function confirmRemoval(flags: RemovalRequest) {
    const targets = preview ?? [];
    if (targets.length === 0) return;
    const ids = new Set(targets.map((r) => r.id));
    setPending(ids);

    remove.mutate(
      {
        targets: targets.map((r) => ({
          instanceId: r.instanceId,
          recordId: r.recordId,
          title: r.title,
        })),
        flags,
      },
      {
        onSuccess: (results) => {
          // Per item, never one verdict for the batch: "3 removed" when the
          // third failed is the outcome report being wrong about the thing it
          // exists to report (REQ-QUEUE-014).
          const failed = results.filter((r) => r.outcome.status === 'failed');
          const removed = results.length - failed.length;
          if (removed > 0) push(`Removed ${removed} item${removed === 1 ? '' : 's'}.`, 'ok');
          failed.forEach((r) => {
            push(`${r.target.title} — ${r.outcome.reason ?? 'removal failed'}`, 'error');
          });

          const removedIds = new Set(
            results.filter((r) => r.outcome.status === 'removed')
              .map((r) => `${r.target.instanceId}:${r.target.recordId}`),
          );
          if (openId && removedIds.has(openId)) setOpenId(null);
          reconcile(new Set(records.filter((r) => !removedIds.has(r.id)).map((r) => r.id)));
        },
        onError: (error) => {
          push(error instanceof ApiError ? error.message : 'The removal did not complete.', 'error');
        },
        onSettled: () => { setPending(new Set()); setPreview(null); },
      },
    );
  }

  const errors = queue.data?.errors ?? [];
  const lastReadAt = queue.data?.lastReadAt ?? {};
  const downloading = records.filter((r) => deriveState(r) === 'downloading').length;
  const attention = records.filter(needsAttention).length;

  return (
    <main className={`main${openRecord ? ' has-inspector' : ''}`} id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Overview"
          sub="Live state of every connected instance and the unified grab/import queue. Start here to spot what is stuck."
          actions={(
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={queue.refresh}
              disabled={queue.isFetching}
            >
              <Icon name="refresh" size={12} />
              {queue.isFetching ? 'Refreshing…' : 'Refresh all'}
            </button>
          )}
        />

        <div className="toolbar">
          <SearchField
            inputRef={searchRef}
            value={query}
            onChange={onQueryChange}
            label="Filter the queue"
            placeholder="Filter by release, target, instance or indexer"
            mono
          />
          <span className="toolbar__spacer" />
          <StatusBadge tone="ok" icon="down">{downloading} downloading</StatusBadge>
          {attention > 0 ? (
            <StatusBadge tone="warn" icon="alert">{attention} need attention</StatusBadge>
          ) : null}
        </div>

        <div className="content__scroll">
          <section className="section">
            <DegradedBanner
              errors={errors}
              lastReadAt={lastReadAt}
              shownRows={records.length}
              onRetry={retry.mutate}
              retrying={retrying}
            />
          </section>

          <section className="section">
            <h2 className="section__title">
              Instances
              <StatusBadge tone="idle">{instances.length} configured</StatusBadge>
            </h2>
            {instances.length === 0 ? (
              <EmptyState title="No instances configured">
                helparr has nothing to read yet. Add Sonarr, Radarr or your download client in
                Settings and this screen fills itself in.
              </EmptyState>
            ) : (
              <InstanceHealthRail
                instances={instances}
                lastReadAt={lastReadAt}
                onRetry={retry.mutate}
                retrying={retrying}
              />
            )}
          </section>

          <section className="section">
            <h2 className="section__title">Queue</h2>

            {queue.showSkeleton ? (
              <QueueSkeleton />
            ) : queue.isError ? (
              <Callout tone="error">
                {queue.error instanceof ApiError ? queue.error.message : 'Could not read the queue.'}
              </Callout>
            ) : visible.length === 0 ? (
              <EmptyState title={query ? 'Nothing matches that filter' : 'Queue is empty'}>
                {query
                  ? `No queued item mentions "${query}". Clear the filter to see everything.`
                  : 'Nothing is downloading or importing right now.'}
              </EmptyState>
            ) : (
              <QueueTable
                records={visible}
                cursor={cursor}
                onCursorChange={setCursor}
                selected={selected}
                onToggleSelect={toggle}
                onOpen={onOpen}
                pending={pending}
                sort={sort}
                onSortChange={setSort}
              />
            )}
          </section>

          <section className="section">
            <KeyboardHints items={HINTS} />
          </section>
        </div>

        <BulkBar count={selectedRecords.length} noun="item" onClear={clear}>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setPreview(selectedRecords)}
            disabled={remove.isPending}
          >
            <Icon name="x" size={12} />Remove from queue
          </button>
        </BulkBar>
      </div>

      {openRecord ? (
        <QueueInspector
          record={openRecord}
          onClose={() => setOpenId(null)}
          onRemove={() => setPreview([openRecord])}
        />
      ) : null}

      {preview ? (
        <RemovalPreview
          records={preview}
          busy={remove.isPending}
          onCancel={() => setPreview(null)}
          onConfirm={confirmRemoval}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </main>
  );
}

/** First paint only. A background refetch never replaces the table with this. */
function QueueSkeleton() {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }} aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div className="qgrid__skeleton" key={i}>
          <span style={{ width: `${[38, 62, 45, 70, 52, 58, 41, 66][i]}%` }} />
        </div>
      ))}
    </div>
  );
}
