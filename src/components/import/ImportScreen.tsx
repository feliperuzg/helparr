'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import Icon from '@/components/Icon';
import TypedCountGate, { useTypedCountGate } from '@/components/TypedCountGate';
import CandidateGrid, { baseName, replacementSwap } from '@/components/import/CandidateGrid';
import EpisodePicker, { type PickerSeries } from '@/components/import/EpisodePicker';
import ImportProgress from '@/components/import/ImportProgress';
import ImportRefusal, { REBUILD_ONLY } from '@/components/import/ImportRefusal';
import {
  useApplyImportPlan, useBulkEditImportRows, useCreateImportPlan, useEditImportRow, useImportPlan,
} from '@/components/import/useImport';
import { formatDuration } from '@/components/rename/planView';
import { SelectionAnnouncer, useAnnouncer } from '@/components/SelectionAnnouncer';
import { useListKeyboard } from '@/components/useListKeyboard';
import {
  Callout, KeyboardHints, Modal, ScreenHead, StatusBadge, ToastStack, useToasts,
} from '@/components/ui';
import { ApiError, type ImportPlanRead } from '@/lib/api';
import {
  allOrdinals,
  includedCount,
  replacementOrdinals,
  type ImportBulkResult,
  type ImportMapping,
  type ImportPlanPhase,
  type ImportPlanRow,
  type ImportRefusal as ImportRefusalValue,
} from '@/lib/importPlan';
import { planExtend, planRange } from '@/lib/rangeSelection';

/**
 * The force-import screen (T17; FR6–FR10, ADR-3..ADR-8, REQ-QUEUE-021/022).
 *
 * Rename's phase model, applied to one download: loading → review → confirm →
 * applying → done, with drift, expiry and a vanished record each leading to
 * one place only — "Rebuild preview". As on rename, the phase is read off the
 * plan rather than tracked here; a second copy of it is a second thing that can
 * be wrong, and being wrong here means telling an operator files moved when
 * they did not.
 *
 * What the assembly owns:
 *
 * 1. **The source survives the plan.** A plan carries its own `instanceId` and
 *    `queueRecordId`, so a rebuild re-reads the same download however the
 *    screen was reached — including a reload of `?plan=<id>`.
 * 2. **The import is confirmed, never fired from the grid.** Grid → dialog →
 *    typed count → apply, unconditionally.
 * 3. **Nothing is optimistic.** Inclusion and mapping change when the server's
 *    copy of the plan comes back; outcomes appear when the read-back writes
 *    them.
 * 4. **A kind whose write is gated off is read-only** (ADR-6, `writeEnabled`):
 *    candidates render for reference, and the write path is absent rather
 *    than disabled. Both kinds are currently enabled.
 */

const EDIT_HINTS: Array<[string[], string]> = [
  [['j', 'k'], 'move'],
  [['space'], 'include / exclude'],
  [['shift', 'j', 'k'], 'extend'],
  [['enter'], 'change mapping'],
  [['?'], 'all shortcuts'],
];

const READ_HINTS: Array<[string[], string]> = [
  [['j', 'k'], 'move'],
  [['?'], 'all shortcuts'],
];

/** One tick a second — the countdown's resolution, and how expiry is noticed without a poll. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/** `?plan=<id>` so a reload resumes this plan rather than reading a second candidate set. */
function rememberPlan(planId: string) {
  window.history.replaceState(null, '', `/import?plan=${encodeURIComponent(planId)}`);
}

/** Row-edit failures arrive as short codes; this says them in words. */
function editErrorText(error: Error, instanceLabel: string): string {
  if (!(error instanceof ApiError)) return 'The change was not saved. The plan is as it was.';
  switch (error.message) {
    case 'plan-not-ready':
      return 'This preview can no longer be changed — it expired or is already being imported.';
    case 'missing-mapping':
      return 'That file has no target yet. Map it with “Change…” before including it.';
    case 'invalid-mapping':
      return `${instanceLabel} did not accept that mapping: the episodes must belong to this series, and ${instanceLabel} must be reachable to check them. The mapping is unchanged.`;
    case 'radarr-mapping-fixed':
      return 'A Radarr download maps to exactly one movie; there is nothing to remap it to.';
    case 'row-not-found':
      return 'That file is no longer part of this preview. Rebuild it to see the current candidates.';
    default:
      return `${error.message} The plan is as it was.`;
  }
}

/** What the last bulk or range edit did — the line under the bulk-action group. */
interface BulkOutcome {
  tone: 'ok' | 'error';
  text: string;
}

function files(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

/**
 * A bulk edit's result in words (FR7): how many rows it changed, and how many
 * it skipped and why — never a bare count of skips.
 */
function bulkOutcomeText(bulk: ImportBulkResult, included: boolean): string {
  const verb = included ? 'Included' : 'Excluded';
  const skipped = bulk.skipped.length;
  if (skipped > 0) return `${verb} ${bulk.changed} · skipped ${skipped} — no target`;
  if (bulk.changed === 0) {
    return `No change — ${included ? 'every includable file was already included' : 'those files were already excluded'}.`;
  }
  return `${verb} ${files(bulk.changed)}.`;
}

/**
 * A bulk edit is one transaction on the server, so a failure means no row moved.
 * Said first, because it is the thing the operator needs to know.
 */
function bulkErrorText(error: Error): string {
  if (!(error instanceof ApiError)) {
    return 'Nothing changed — the edit could not be sent. Every file is as it was.';
  }
  switch (error.message) {
    case 'plan-not-ready':
      return 'Nothing changed — the plan could not be saved. This preview can no longer be changed; it expired or is already being imported. Rebuild to try again.';
    case 'row-not-found':
      return 'Nothing changed — a file in that set is no longer part of this preview. Rebuild it to see the current candidates.';
    default:
      return `Nothing changed — the plan could not be saved (${error.message}). Every file is as it was.`;
  }
}

/**
 * The plan's series, read off the first row the instance mapped to one. A
 * download is one series pack, and the server refuses an override that leaves
 * it, so the picker never offers a choice of series.
 */
function planSeries(rows: ImportPlanRow[]): PickerSeries | null {
  const mapped = rows.find((row) => row.mapping?.kind === 'series')?.mapping;
  return mapped?.kind === 'series'
    ? { seriesId: mapped.seriesId, seriesTitle: mapped.seriesTitle }
    : null;
}

export interface ImportScreenProps {
  /** From `?instanceId=` — the queue inspector's link. */
  initialInstanceId: string | null;
  /** From `?recordId=`. */
  initialRecordId: number | null;
  /** From `?plan=` — a reload resuming an existing plan. Wins over the other two. */
  initialPlanId: string | null;
}

interface Source {
  instanceId: string;
  recordId: number;
}

export default function ImportScreen({
  initialInstanceId, initialRecordId, initialPlanId,
}: ImportScreenProps) {
  const { toasts, push } = useToasts();
  /** No filter field — the shared keyboard layer takes a ref regardless. */
  const searchRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<Source | null>(
    () => (initialInstanceId !== null && initialRecordId !== null
      ? { instanceId: initialInstanceId, recordId: initialRecordId }
      : null),
  );
  const [planId, setPlanId] = useState<string | null>(initialPlanId);
  const [confirming, setConfirming] = useState(false);
  const [pickerOrdinal, setPickerOrdinal] = useState<number | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  /** The range anchor, by ordinal: set by a plain toggle (click or Space). */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const { message, announce } = useAnnouncer();

  const createPlan = useCreateImportPlan();
  const planQuery = useImportPlan(planId);
  const editRow = useEditImportRow(planId);
  const bulkEdit = useBulkEditImportRows(planId);
  const apply = useApplyImportPlan(planId);

  const plan = planQuery.data ?? null;
  const phase = plan?.phase ?? null;
  const rows = useMemo(() => plan?.rows ?? [], [plan]);
  const writable = plan !== null && plan.writeEnabled;
  const instanceLabel = plan?.instanceLabel ?? 'the instance';

  /* Expiry is noticed by the clock, not the poll: a `ready` plan is settled, so
     nothing re-reads it, and the operator must not be offered a confirm that
     the server is certain to refuse. */
  const now = useNow(phase === 'ready');
  const msLeft = plan ? Date.parse(plan.expiresAt) - now : null;
  const clockExpired = phase === 'ready' && msLeft !== null && msLeft <= 0;

  /* Which refusal, if any, owns the screen. `apply.refusal` is the server's
     verbatim answer to the last confirm; some refusals (an unreachable re-read,
     a vanished record) are deliberately not persisted, so the plan can still
     read `ready` underneath one. */
  const inFlight = phase === 'applying' || phase === 'done' || plan?.importing === true;
  const lastRefusal = inFlight ? null : apply.refusal;
  const blockingRefusal: ImportRefusalValue | null = lastRefusal && REBUILD_ONLY.has(lastRefusal.reason)
    ? lastRefusal
    : phase === 'refused' ? plan?.refusal ?? null : null;
  const expired = !inFlight && (phase === 'expired' || clockExpired || blockingRefusal?.reason === 'expired');
  const refused = !inFlight && (blockingRefusal !== null || phase === 'refused' || expired);
  /** Count-mismatch and friends: answered in place, retyping is allowed. */
  const softRefusal = lastRefusal && !REBUILD_ONLY.has(lastRefusal.reason) ? lastRefusal : null;

  const editable = phase === 'ready' && writable && !refused;

  /* A phase change is announced once, on the transition — the poll re-runs
     every second while applying. */
  const lastPhase = useRef<ImportPlanPhase | null>(null);
  useEffect(() => {
    if (!phase || lastPhase.current === phase) return;
    const previous = lastPhase.current;
    lastPhase.current = phase;
    if (phase === 'refused') {
      push('The import was refused. Nothing was imported.', 'error');
    } else if (phase === 'expired') {
      push('The preview expired before it was confirmed. Nothing was imported.', 'warn');
    } else if (previous === 'applying' && phase === 'done') {
      push('The read-back is finished. Every sent file has an outcome.', 'ok');
    }
  }, [phase, push]);

  const series = useMemo(() => planSeries(rows), [rows]);

  const pickerRow = pickerOrdinal === null
    ? null
    : rows.find((row) => row.ordinal === pickerOrdinal) ?? null;

  /** One edit at a time, single or bulk — a second must not race the first's all-or-nothing answer. */
  const editing = editRow.isPending || bulkEdit.isPending;

  const toggleRow = useCallback((row: ImportPlanRow) => {
    if (!editable || editing) return;
    if (row.mapping === null && !row.included) {
      push('That file has no target yet. Map it with “Change…” before including it.', 'warn');
      return;
    }
    setAnchor(row.ordinal);
    // The outcome line speaks for the last bulk edit; a single edit supersedes it.
    setOutcome(null);
    editRow.mutate({ ordinal: row.ordinal, included: !row.included }, {
      onError: (error) => push(editErrorText(error, instanceLabel), 'error'),
    });
  }, [editable, editing, editRow, push, instanceLabel]);

  /** Range helpers speak in string ids; the plan's are ordinals, in render order. */
  const displayedIds = useMemo(() => rows.map((row) => String(row.ordinal)), [rows]);
  const includedOf = useCallback((id: string) => (
    rows.find((row) => String(row.ordinal) === id)?.included ?? false
  ), [rows]);

  /**
   * Include all / Exclude all / Include all replacements and every range
   * gesture: one PATCH, all or nothing (ADR-6). Nothing is optimistic — the
   * rows move when the refreshed plan lands in the cache, and on a failure
   * they do not move at all.
   */
  const runBulk = useCallback((ordinals: number[], included: boolean) => {
    if (!editable || editing || ordinals.length === 0) return;
    const before = rows.filter((row) => row.included).length;
    const total = rows.length;
    bulkEdit.mutate({ ordinals, included }, {
      onSuccess: (bulk) => {
        const text = bulkOutcomeText(bulk, included);
        const after = included ? before + bulk.changed : before - bulk.changed;
        setOutcome({ tone: 'ok', text });
        announce(`${text.replace(/\.$/, '')}. ${after} of ${files(total)} now included.`);
      },
      onError: (error) => {
        const text = bulkErrorText(error);
        setOutcome({ tone: 'error', text });
        announce(text);
      },
    });
  }, [editable, editing, rows, bulkEdit, announce]);

  const includeAll = useCallback(() => runBulk(allOrdinals(rows), true), [runBulk, rows]);
  const excludeAll = useCallback(() => runBulk(allOrdinals(rows), false), [runBulk, rows]);
  const includeReplacements = useCallback(() => {
    // Only the excluded ones: the button's count is what it will change.
    const excluded = new Set(rows.filter((row) => !row.included).map((row) => row.ordinal));
    runBulk(replacementOrdinals(rows).filter((ordinal) => excluded.has(ordinal)), true);
  }, [runBulk, rows]);

  /**
   * A range takes the anchor row's state (ADR-5) and goes through the bulk
   * endpoint, so an unmapped row inside it is skipped and named exactly as a
   * named bulk action would. A range that would change nothing sends nothing.
   */
  const applyRangePlan = useCallback((ids: string[], state: boolean) => {
    if (!ids.some((id) => includedOf(id) !== state)) {
      const now = rows.filter((row) => row.included).length;
      announce(`No change. ${now} of ${files(rows.length)} included.`);
      return;
    }
    runBulk(ids.map(Number), state);
  }, [includedOf, rows, announce, runBulk]);

  /** shift+click and Shift+Space: anchor → target. No displayed anchor degrades to a plain toggle. */
  const rangeToRow = useCallback((row: ImportPlanRow) => {
    if (!editable || editing) return;
    const range = planRange(
      displayedIds,
      anchor === null ? null : String(anchor),
      String(row.ordinal),
      includedOf,
    );
    if (!range) {
      toggleRow(row);
      return;
    }
    applyRangePlan(range.ids, range.state);
  }, [editable, editing, displayedIds, anchor, includedOf, toggleRow, applyRangePlan]);

  const openPicker = useCallback((row: ImportPlanRow) => {
    if (!editable) return;
    setPickerError(null);
    setPickerOrdinal(row.ordinal);
  }, [editable]);

  const closePicker = useCallback(() => {
    setPickerOrdinal(null);
    setPickerError(null);
  }, []);

  const applyMapping = useCallback((mapping: ImportMapping) => {
    if (pickerOrdinal === null) return;
    setPickerError(null);
    editRow.mutate({ ordinal: pickerOrdinal, mapping }, {
      onSuccess: () => setPickerOrdinal(null),
      onError: (error) => setPickerError(editErrorText(error, instanceLabel)),
    });
  }, [pickerOrdinal, editRow, instanceLabel]);

  const onToggleIndex = useCallback((index: number) => {
    const row = rows[index];
    if (row) toggleRow(row);
  }, [rows, toggleRow]);

  const onSelectRange = useCallback((index: number) => {
    const row = rows[index];
    if (row) rangeToRow(row);
  }, [rows, rangeToRow]);

  /** Shift+J/K: the cursor already moved `from` → `to`; both take the anchor's state. */
  const onExtend = useCallback((from: number, to: number) => {
    if (!editable || editing || from === to) return;
    const fromId = displayedIds[from];
    const toId = displayedIds[to];
    if (fromId === undefined || toId === undefined) return;
    const range = planExtend(
      displayedIds,
      anchor === null ? null : String(anchor),
      fromId,
      toId,
      includedOf,
    );
    if (!range) return;
    if (range.anchor !== String(anchor)) setAnchor(Number(range.anchor));
    applyRangePlan(range.ids, range.state);
  }, [editable, editing, displayedIds, anchor, includedOf, applyRangePlan]);

  const onOpenIndex = useCallback((index: number) => {
    const row = rows[index];
    if (row && writable) openPicker(row);
  }, [rows, writable, openPicker]);

  const onEscape = useCallback(() => false, []);

  const { cursor, setCursor } = useListKeyboard({
    count: rows.length,
    onToggleSelect: onToggleIndex,
    onOpen: onOpenIndex,
    onEscape,
    onExtend,
    onSelectRange,
    searchRef,
    // A dialog owns the keyboard while it is up: j/k moving a cursor behind
    // the typed gate is how the wrong plan gets a number typed at it.
    enabled: !confirming && pickerOrdinal === null && (phase === 'ready' || expired),
  });

  /** The grid's checkbox: shift+click is a range, a plain click a toggle. Either moves the cursor there. */
  const onCheckbox = useCallback((row: ImportPlanRow, shift: boolean) => {
    const index = rows.indexOf(row);
    if (index >= 0) setCursor(index);
    if (shift) rangeToRow(row);
    else toggleRow(row);
  }, [rows, setCursor, rangeToRow, toggleRow]);

  /** The one way a plan is made. Any previous plan is left to age out. */
  const startBuild = useCallback((target: Source) => {
    setSource(target);
    setPlanId(null);
    setConfirming(false);
    setPickerOrdinal(null);
    setAnchor(null);
    setOutcome(null);
    apply.clearRefusal();
    lastPhase.current = null;
    createPlan.mutate(target, {
      onSuccess: (created) => {
        setPlanId(created.id);
        setCursor(0);
        rememberPlan(created.id);
      },
    });
  }, [apply, createPlan, setCursor]);

  /* The inspector's link carries a record, not a plan: read its candidates
     once, on arrival. Guarded by a ref so a strict-mode double effect does not
     read the instance twice. */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || initialPlanId !== null || source === null) return;
    autoStarted.current = true;
    createPlan.mutate(source, {
      onSuccess: (created) => {
        setPlanId(created.id);
        rememberPlan(created.id);
      },
    });
  }, [createPlan, initialPlanId, source]);

  /**
   * The only control on a refused or expired plan. It re-reads the same
   * download — from the plan when there is one, so a reload of `?plan=` can
   * rebuild too — and never re-sends the old plan.
   */
  const rebuild = useCallback(() => {
    const target: Source | null = plan
      ? { instanceId: plan.instanceId, recordId: plan.queueRecordId }
      : source;
    if (target) startBuild(target);
  }, [plan, source, startBuild]);

  const openConfirm = useCallback(() => {
    apply.clearRefusal();
    setConfirming(true);
  }, [apply]);

  const cancelConfirm = useCallback(() => setConfirming(false), []);

  const confirmApply = useCallback((typedCount: number) => {
    apply.mutate(typedCount, {
      onSuccess: () => setConfirming(false),
      onError: (error) => {
        // A refusal is an answer, not a retryable failure: the dialog closes
        // and the refusal — in the server's own words — takes over.
        setConfirming(false);
        // Drift and expiry move the plan's own phase, and the phase effect
        // above announces that transition — a second toast here would say the
        // same sentence twice.
        const detail = error instanceof ApiError ? error.detail : null;
        const reason = typeof detail === 'object' && detail !== null && 'refusal' in detail
          ? (detail as { refusal?: { reason?: string } }).refusal?.reason
          : undefined;
        if (reason !== undefined && REBUILD_ONLY.has(reason as ImportRefusalValue['reason'])) return;
        push(
          error instanceof ApiError && error.status === 409
            ? 'The import was refused. Nothing was imported.'
            : `The import was not sent${error instanceof ApiError ? `: ${error.message}` : '.'}`,
          'error',
        );
      },
    });
  }, [apply, push]);

  const showHints = plan !== null && rows.length > 0 && (phase === 'ready' || expired) && !inFlight;

  let body: ReactNode;
  if (planId === null) {
    body = (
      <BuildState
        hasSource={source !== null}
        error={createPlan.isError ? createPlan.error : null}
        onRetry={source ? () => startBuild(source) : undefined}
      />
    );
  } else if (planQuery.isPending || plan === null) {
    body = (
      <div className="content__scroll">
        <section className="section">
          {planQuery.isError ? (
            <>
              <Callout tone="error">
                {planQuery.error instanceof ApiError
                  ? planQuery.error.message
                  : 'Could not read the preview.'}
                {' '}Nothing was imported.
              </Callout>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                {source ? (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => startBuild(source)}>
                    <Icon name="refresh" size={12} />Read candidates again
                  </button>
                ) : null}
                <Link href="/" className="btn btn-ghost btn-sm">Back to queue</Link>
              </div>
            </>
          ) : (
            <p className="scope__loading">
              <span className="spinner" aria-hidden="true" />
              Opening the preview…
            </p>
          )}
        </section>
      </div>
    );
  } else if (inFlight) {
    body = (
      <ImportProgress plan={plan} onRebuild={rebuild} rebuilding={createPlan.isPending} />
    );
  } else if (refused) {
    body = (
      <ImportRefusal
        refusal={blockingRefusal ?? plan.refusal}
        expired={expired}
        instanceLabel={plan.instanceLabel}
        candidateCount={plan.rows.length}
        onRebuild={rebuild}
        busy={createPlan.isPending}
      >
        {expired && plan.rows.length > 0 ? (
          <>
            <h2 className="section__title">As it was when it expired</h2>
            <p className="section__sub">Read-only. Rebuild to see {plan.instanceLabel}&rsquo;s current candidates.</p>
            <CandidateGrid
              rows={plan.rows}
              mode="expired"
              instanceLabel={plan.instanceLabel}
              canRemap={false}
              cursor={cursor}
              onCursorChange={setCursor}
            />
          </>
        ) : null}
      </ImportRefusal>
    );
  } else {
    body = (
      <Review
        plan={plan}
        writable={writable}
        msLeft={msLeft}
        cursor={cursor}
        onCursorChange={setCursor}
        onToggleIncluded={onCheckbox}
        onChangeMapping={openPicker}
        onImport={openConfirm}
        onRebuild={rebuild}
        bulk={editable ? {
          onIncludeAll: includeAll,
          onExcludeAll: excludeAll,
          onIncludeReplacements: includeReplacements,
          pending: bulkEdit.isPending,
          outcome,
        } : null}
        editing={editing}
        applying={apply.isPending}
        rebuilding={createPlan.isPending}
        softRefusal={softRefusal}
      />
    );
  }

  return (
    <main className="main" id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Force import"
          sub={plan ? (
            <>
              <span className="mono">{plan.instanceLabel}</span> · {plan.title}
            </>
          ) : 'Review the candidates the instance resolved before a single file is imported.'}
          actions={inFlight && phase !== 'done' ? undefined : (
            <Link href="/" className="btn btn-ghost btn-sm">Back to queue</Link>
          )}
        />

        {body}

        {/* Always mounted: a live region inserted with its first message says nothing. */}
        <SelectionAnnouncer message={message} />

        {showHints ? (
          <section className="section">
            <KeyboardHints items={editable ? EDIT_HINTS : READ_HINTS} />
          </section>
        ) : null}
      </div>

      {confirming && plan !== null && editable ? (
        <ImportConfirmDialog
          plan={plan}
          busy={apply.isPending}
          onCancel={cancelConfirm}
          onConfirm={confirmApply}
        />
      ) : null}

      {pickerRow && plan !== null && editable ? (
        <EpisodePicker
          planId={plan.id}
          row={pickerRow}
          series={series}
          planTitle={plan.title}
          instanceLabel={plan.instanceLabel}
          busy={editRow.isPending}
          error={pickerError}
          onCancel={closePicker}
          onApply={applyMapping}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </main>
  );
}

/* ── Loading / unreachable (§1, §6) ───────────────────────────────────────── */

function BuildState({
  hasSource, error, onRetry,
}: {
  hasSource: boolean;
  error: Error | null;
  onRetry?: () => void;
}) {
  if (!hasSource) {
    return (
      <div className="content__scroll">
        <section className="section">
          <Callout tone="warn">
            No queue record was named. Force import opens from a stuck download&rsquo;s
            inspector on the queue — pick the record there.
          </Callout>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Link href="/" className="btn btn-primary btn-sm">Back to queue</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="content__scroll">
      <section className="section">
        {error ? (
          <>
            {/* No "import anyway" here: without the instance's own candidates
                there is nothing to show and nothing to confirm. */}
            <Callout tone="error">
              {error instanceof ApiError ? error.message : 'The instance could not be read.'}
              {' '}No candidates could be read; nothing was imported.
            </Callout>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
              {onRetry ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>
                  <Icon name="refresh" size={12} />Retry
                </button>
              ) : null}
              <Link href="/" className="btn btn-ghost btn-sm">Back to queue</Link>
            </div>
          </>
        ) : (
          <>
            <p className="section__sub">
              Asking the instance for the candidates it resolved for this download. This is the
              instance&rsquo;s own manual-import read — helparr is not guessing.
            </p>
            <p className="scope__loading" role="status">
              <span className="spinner" aria-hidden="true" />
              Reading candidates…
            </p>
            <Link href="/" className="btn btn-ghost btn-sm">Cancel</Link>
          </>
        )}
      </section>
    </div>
  );
}

/* ── Review (§2) and the Radarr read-only variant ────────────────────────── */

/** The bulk-action group's wiring; null whenever the plan cannot be edited. */
interface BulkActions {
  onIncludeAll: () => void;
  onExcludeAll: () => void;
  onIncludeReplacements: () => void;
  /** A bulk edit is in flight. */
  pending: boolean;
  outcome: BulkOutcome | null;
}

interface ReviewProps {
  plan: ImportPlanRead;
  writable: boolean;
  msLeft: number | null;
  cursor: number;
  onCursorChange: (index: number) => void;
  onToggleIncluded: (row: ImportPlanRow, shift: boolean) => void;
  onChangeMapping: (row: ImportPlanRow) => void;
  onImport: () => void;
  onRebuild: () => void;
  bulk: BulkActions | null;
  /** Any edit — single or bulk — is in flight. */
  editing: boolean;
  applying: boolean;
  rebuilding: boolean;
  softRefusal: ImportRefusalValue | null;
}

function Review({
  plan, writable, msLeft, cursor, onCursorChange, onToggleIncluded, onChangeMapping,
  onImport, onRebuild, bulk, editing, applying, rebuilding, softRefusal,
}: ReviewProps) {
  const instance = plan.instanceLabel;
  const included = includedCount(plan);
  const replacing = plan.rows.filter((row) => row.replacesExisting !== null);
  const replacingIncluded = replacing.filter((row) => row.included).length;
  const unmapped = plan.rows.filter((row) => row.mapping === null).length;
  const remapped = plan.rows.filter((row) => row.mappingSource === 'operator').length;
  const expiringSoon = msLeft !== null && msLeft <= 60_000;

  if (!writable) {
    return (
      <div className="content__scroll">
        <section className="section">
          {/* The write path is absent, not greyed out (ADR-6): no checkboxes,
              no "Change…", no action bar. */}
          <Callout tone="info">
            <strong>Force import is disabled for Radarr until its write path is verified</strong>
            {' '}against a live instance. These are the candidates {instance} resolved, shown for
            reference only — nothing here can be imported yet.
          </Callout>
        </section>
        <section className="section">
          <CandidateGrid
            rows={plan.rows}
            mode="readonly"
            instanceLabel={instance}
            canRemap={false}
            cursor={cursor}
            onCursorChange={onCursorChange}
          />
        </section>
      </div>
    );
  }

  return (
    <>
      <div className="ribbon ribbon--preview" role="status">
        <Icon name="eye" size={14} />
        <span className="ribbon__title">PREVIEW — nothing has been imported</span>
        <span className="ribbon__spacer" />
        {msLeft === null ? null : (
          <span className={`ribbon__timer mono${expiringSoon ? ' is-urgent' : ''}`}>
            <Icon name="clock" size={12} />
            <span aria-hidden="true">{formatDuration(Math.max(0, msLeft))}</span>
            <span className="sr-only">
              {`This preview can be confirmed for another ${formatDuration(Math.max(0, msLeft))}.`}
            </span>
          </span>
        )}
      </div>

      <div className="content__scroll">
        <section className="section">
          <div className="totals">
            <span className="totals__main mono">
              {plan.rows.length} candidate{plan.rows.length === 1 ? '' : 's'}
            </span>
            {replacing.length > 0 ? (
              <StatusBadge tone="warn" icon="alert">{replacing.length} replace an existing file</StatusBadge>
            ) : null}
            {unmapped > 0 ? (
              <StatusBadge tone="idle" icon="x">{unmapped} without a target</StatusBadge>
            ) : null}
            {remapped > 0 ? (
              <StatusBadge tone="idle" icon="rename">{remapped} mapped by you</StatusBadge>
            ) : null}
            <span className="totals__spacer" />
            <span className="totals__note subtle">
              Read from {instance}&rsquo;s own manual-import resolver.
            </span>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <Callout tone="idle" icon="alert">
            <strong>Importing is irreversible.</strong> {instance} moves the files into your
            library; there is no undo, from helparr or from {instance}.
          </Callout>
        </section>

        {replacing.length > 0 ? (
          <section className="section" style={{ paddingTop: 0 }}>
            <Callout tone="warn">
              <strong>
                {replacing.length} candidate{replacing.length === 1 ? '' : 's'} would replace a file
                already in your library.
              </strong>
              {' '}This is helparr&rsquo;s reading: {instance} replaces the existing file even when
              the new one is worse, and records it as an upgrade. {replacing.length === 1 ? 'It starts' : 'They start'}
              {' '}excluded — include {replacing.length === 1 ? 'it' : 'one'} only if replacing is what you mean.
              <ul className="msg-list">
                {replacing.map((row) => (
                  <li key={row.ordinal}>
                    <span className="mono">{baseName(row.path)}</span>: {replacementSwap(row)}
                    {row.included ? ' — included' : ' — excluded'}
                  </li>
                ))}
              </ul>
            </Callout>
          </section>
        ) : null}

        {softRefusal ? (
          <section className="section" style={{ paddingTop: 0 }}>
            <Callout tone="error">
              <strong>Nothing was imported.</strong>
              <ul className="msg-list">
                {softRefusal.changes.map((change, at) => (
                  <li key={`${at}:${change}`}>{change}</li>
                ))}
              </ul>
              {softRefusal.reason === 'count-mismatch'
                ? ' Open the confirmation again and type the count it shows now.'
                : null}
            </Callout>
          </section>
        ) : null}

        <section className="section" style={{ paddingTop: 0 }}>
          {bulk ? (
            <BulkIncludeActions
              {...bulk}
              replacementsExcluded={replacing.length - replacingIncluded}
              hasReplacements={replacing.length > 0}
              disabled={editing || applying}
            />
          ) : null}
          <CandidateGrid
            rows={plan.rows}
            mode="edit"
            instanceLabel={instance}
            canRemap
            cursor={cursor}
            onCursorChange={onCursorChange}
            onToggleIncluded={onToggleIncluded}
            onChangeMapping={onChangeMapping}
            busy={editing}
          />
        </section>
      </div>

      <div className="bulkbar bulkbar--apply" role="region" aria-label="Import this plan">
        <span className="bulkbar__count mono">
          {included} included
        </span>
        <span className="subtle" style={{ fontSize: 'var(--text-xs)' }}>
          {replacingIncluded === 0
            ? '— none replace an existing file'
            : `— ${replacingIncluded} replace${replacingIncluded === 1 ? 's' : ''} an existing file, included by you`}
        </span>
        <span className="bulkbar__spacer" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRebuild}
          disabled={rebuilding || applying}
        >
          <Icon name="refresh" size={12} />Rebuild
        </button>
        <button
          type="button"
          className="btn btn-danger-solid btn-sm"
          // Opens the typed confirmation; it never imports anything directly.
          onClick={onImport}
          disabled={included === 0 || editing || applying}
        >
          <Icon name="import" size={12} />
          Import {included} file{included === 1 ? '' : 's'}…
        </button>
      </div>
    </>
  );
}

/* ── Bulk include / exclude (REQ-QUEUE-025) ──────────────────────────────── */

/**
 * Three named edits over the whole plan, and the line saying what the last
 * one did. Not a `BulkBar`: it has no selection of its own to count — the
 * apply bar's "N included" already is that number, and the typed gate asks
 * for it (FR9). A bulk edit only ever moves inclusion; the gate is untouched.
 */
function BulkIncludeActions({
  onIncludeAll, onExcludeAll, onIncludeReplacements, pending, outcome,
  replacementsExcluded, hasReplacements, disabled,
}: BulkActions & {
  /** Replacement rows still excluded — what "Include all replacements" would change. */
  replacementsExcluded: number;
  hasReplacements: boolean;
  /** Any edit or the apply is in flight; a second edit waits. */
  disabled: boolean;
}) {
  return (
    <>
      <div className="bulk-include" role="group" aria-label="Bulk actions" aria-busy={pending || undefined}>
        <button type="button" className="btn btn-outline btn-sm" onClick={onIncludeAll} disabled={disabled}>
          Include all
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={onExcludeAll} disabled={disabled}>
          Exclude all
        </button>
        {hasReplacements ? (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onIncludeReplacements}
            // Stays on screen at zero, so the button the operator just used
            // does not vanish from under them; its count says why it is idle.
            disabled={disabled || replacementsExcluded === 0}
          >
            Include all replacements ({replacementsExcluded})
          </button>
        ) : null}
        {pending ? (
          <span className="bulk-include__busy">
            <span className="spinner" aria-hidden="true" />
            Saving…
          </span>
        ) : null}
      </div>
      {/* Inline, not a toast: it stays while the operator reviews what it
          changed. Spoken through the screen's announcer, not a second live
          region, so it is heard once. */}
      {outcome ? (
        <div className="bulk-include__outcome">
          <Callout tone={outcome.tone}>{outcome.text}</Callout>
        </div>
      ) : null}
    </>
  );
}

/* ── Confirm (§3) — the typed-count gate, same component as rename's ────── */

interface ImportConfirmDialogProps {
  plan: ImportPlanRead;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typedCount: number) => void;
}

/**
 * Mirrors rename's `ConfirmApplyDialog`. The count is the live included count
 * captured once, when the dialog opens — the candidate set is re-read on the
 * server immediately after this confirms (FR9), so there is nothing to
 * recompute here, and a number that moved under a half-typed answer would
 * accept one typed about a different plan. There is no setting that skips it.
 */
function ImportConfirmDialog({ plan, busy, onCancel, onConfirm }: ImportConfirmDialogProps) {
  const gate = useTypedCountGate(includedCount(plan));
  const { expected, matches } = gate;
  const instance = plan.instanceLabel;

  const sent = plan.rows.filter((row) => row.included);
  const replacing = sent.filter((row) => row.replacesExisting !== null);
  const remapped = sent.filter((row) => row.mappingSource === 'operator').length;
  const left = plan.rows.length - sent.length;

  // Stable, because `Modal` restores focus in the cleanup of an effect keyed
  // on it — a new function each render would restore focus on every keystroke.
  const close = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);

  return (
    <Modal
      title="Import these files?"
      labelledBy="import-confirm-title"
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger-solid"
            // Disabled, never hidden: the operator sees the control they have
            // not yet earned, so the number they are typing has a purpose.
            disabled={!matches || busy}
            onClick={() => onConfirm(expected)}
          >
            <Icon name="import" size={13} />
            {busy ? 'Sending…' : `Import ${expected} file${expected === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      <p className="modal__lead">
        <strong>Nothing has been imported yet.</strong> {expected} file{expected === 1 ? '' : 's'}
        {' '}will be imported by {instance}. <strong>This cannot be undone from helparr.</strong>
      </p>

      <ul className="confirm-facts">
        <li>
          <Icon name="import" size={13} />
          <span>
            <strong className="mono">{expected}</strong> file{expected === 1 ? '' : 's'} will be
            moved into your library by {instance}, each to the target shown in the preview.
          </span>
        </li>
        {remapped > 0 ? (
          <li>
            <Icon name="rename" size={13} />
            <span>
              <strong className="mono">{remapped}</strong> of them use{remapped === 1 ? 's' : ''} a
              mapping you chose, not the one {instance} resolved.
            </span>
          </li>
        ) : null}
        {left > 0 ? (
          <li>
            <Icon name="x" size={13} />
            <span>
              <strong className="mono">{left}</strong> candidate{left === 1 ? '' : 's'} you left
              out will not be sent at all.
            </span>
          </li>
        ) : null}
        <li>
          <Icon name="alert" size={13} />
          <span>
            Before anything is written, helparr re-reads {instance}&rsquo;s candidates. If they
            changed since this preview, the whole import is refused and nothing is written.
          </span>
        </li>
      </ul>

      {replacing.length > 0 ? (
        <Callout tone="warn">
          {replacing.length} of them replace{replacing.length === 1 ? 's' : ''} an existing file.
          You included {replacing.length === 1 ? 'it' : 'them'}:
          <ul className="msg-list">
            {replacing.map((row) => (
              <li key={row.ordinal}>
                <span className="mono">{baseName(row.path)}</span> ({replacementSwap(row)})
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <TypedCountGate
        gate={gate}
        inputId="import-typed-count"
        hintId="import-typed-hint"
        action="import"
        matchedMessage="Confirmed."
        disabled={busy}
      />
    </Modal>
  );
}
