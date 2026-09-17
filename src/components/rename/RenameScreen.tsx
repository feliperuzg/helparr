'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ApplyProgress from '@/components/rename/ApplyProgress';
import BuildProgress from '@/components/rename/BuildProgress';
import ConfirmApplyDialog from '@/components/rename/ConfirmApplyDialog';
import PlanReview from '@/components/rename/PlanReview';
import RefusalPanel from '@/components/rename/RefusalPanel';
import RenameInspector from '@/components/rename/RenameInspector';
import ScopePicker from '@/components/rename/ScopePicker';
import {
  useApplyRenamePlan, useCreateRenamePlan, useRenameExclusion, useRenamePlan,
} from '@/components/rename/useRename';
import type { GridMode } from '@/components/rename/planView';
import { useListKeyboard } from '@/components/useListKeyboard';
import {
  Callout, KeyboardHints, ScreenHead, ToastStack, useToasts,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import type { RenamePlanPhase, RenameScopeEntry, RenameTitleOption } from '@/lib/types';

/**
 * The bulk-rename screen (T10–T15; FR1–FR13, NFR2, NFR3).
 *
 * One screen, six phases, and the phase is read off the plan rather than tracked
 * here: `scope-select` is simply "no plan id yet", and everything after it is
 * `plan.phase`. A second copy of the phase in local state is a second thing that
 * can be wrong, and on this screen being wrong about the phase means telling an
 * operator that files have moved when they have not — or the reverse.
 *
 * What the assembly owns:
 *
 * 1. **The scope survives the plan.** The chosen titles are kept here so a
 *    refused or expired plan can be rebuilt from the same set without the
 *    operator re-picking twenty series — regeneration being, per NFR3, the only
 *    thing on offer when a plan is refused.
 * 2. **The rename is confirmed, never fired from the grid.** Grid → dialog →
 *    typed count → apply, unconditionally (ADR-8).
 * 3. **Nothing is optimistic.** No local mutation of a row's outcome, ever;
 *    every status on the applying screen comes from the poll.
 */

const HINTS: Array<[string[], string]> = [
  [['/'], 'filter'],
  [['j', 'k'], 'move'],
  [['space'], 'include / exclude'],
  [['enter'], 'inspect'],
  [['esc'], 'close'],
  [['?'], 'all shortcuts'],
];

/** Which phases put a list of rows on the screen for the keyboard to drive. */
const GRID_PHASES: ReadonlySet<RenamePlanPhase> = new Set<RenamePlanPhase>([
  'ready', 'applying', 'done', 'expired',
]);

function gridModeOf(phase: RenamePlanPhase): GridMode {
  if (phase === 'applying') return 'applying';
  if (phase === 'done') return 'done';
  if (phase === 'expired') return 'expired';
  return 'preview';
}

export default function RenameScreen() {
  const { toasts, push } = useToasts();
  /**
   * The plan phases have no filter field — the grid shows the whole plan,
   * because a filtered plan is a plan whose total the operator cannot check
   * against the number they are about to type. `/` therefore has nothing to
   * focus here; the ref is passed because the shared keyboard layer takes one.
   */
  const searchRef = useRef<HTMLInputElement>(null);

  /** The picker's selection, kept across a regenerate. */
  const [selectedTitleIds, setSelectedTitleIds] = useState<ReadonlySet<string>>(() => new Set());
  /** The scope actually submitted — what a rebuild is made from. */
  const [scope, setScope] = useState<RenameScopeEntry[] | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const createPlan = useCreateRenamePlan();
  const planQuery = useRenamePlan(planId);
  const exclusion = useRenameExclusion(planId);
  const apply = useApplyRenamePlan(planId);

  const plan = planQuery.data ?? null;
  const phase = plan?.phase ?? null;
  const rows = useMemo(() => plan?.rows ?? [], [plan]);

  /* A phase change is the one thing on this screen worth announcing, and it is
     announced once — the poll re-runs every second, so a toast keyed on the
     value rather than on the transition would arrive sixty times a minute. */
  const lastPhase = useRef<RenamePlanPhase | null>(null);
  useEffect(() => {
    if (!phase || lastPhase.current === phase) return;
    const previous = lastPhase.current;
    lastPhase.current = phase;
    if (previous === 'building' && phase === 'ready') {
      push('Preview ready. Nothing has been renamed yet.', 'ok');
    } else if (phase === 'expired') {
      push('The preview expired before it was applied. Nothing was renamed.', 'warn');
    } else if (phase === 'refused') {
      push('The plan was refused. Nothing was renamed.', 'error');
    } else if (previous === 'applying' && phase === 'done') {
      push('The instances have finished reporting.', 'ok');
    }
  }, [phase, push]);

  const openRow = openRowId ? rows.find((row) => row.id === openRowId) ?? null : null;

  const onOpen = useCallback((index: number) => {
    setOpenRowId(rows[index]?.id ?? null);
  }, [rows]);

  const setExcluded = useCallback((rowIds: string[], excluded: boolean) => {
    if (rowIds.length === 0) return;
    exclusion.mutate({ rowIds, excluded }, {
      onError: (error) => {
        push(
          error instanceof ApiError ? error.message : 'Could not change the plan.',
          'error',
        );
      },
    });
  }, [exclusion, push]);

  const onToggleIndex = useCallback((index: number) => {
    const row = rows[index];
    // Only meaningful while the plan can still be edited; afterwards the space
    // bar has nothing to toggle and silently doing nothing is correct.
    if (row && phase === 'ready') setExcluded([row.id], !row.excluded);
  }, [rows, phase, setExcluded]);

  const onEscape = useCallback(() => {
    if (openRowId === null) return false;
    setOpenRowId(null);
    return true;
  }, [openRowId]);

  const clearOpen = useCallback(() => setOpenRowId(null), []);

  // The cursor lives in the keyboard hook, which already clamps it when the
  // list shrinks — and this list is replaced wholesale on every poll, so a
  // second copy here would be the thing that pointed past the end.
  const { cursor, setCursor } = useListKeyboard({
    count: rows.length,
    onToggleSelect: onToggleIndex,
    onOpen,
    onEscape,
    onClearSelection: clearOpen,
    searchRef,
    // The dialog owns the keyboard while it is up: j/k moving a cursor behind a
    // confirmation is how the wrong plan gets typed a number at.
    enabled: !confirming && phase !== null && GRID_PHASES.has(phase),
  });

  const startBuild = useCallback((entries: RenameScopeEntry[]) => {
    if (entries.length === 0) return;
    setScope(entries);
    setOpenRowId(null);
    lastPhase.current = null;
    createPlan.mutate(entries, {
      onSuccess: (id) => { setPlanId(id); setCursor(0); },
      onError: (error) => {
        push(
          error instanceof ApiError ? error.message : 'Could not start the preview.',
          'error',
        );
      },
    });
  }, [createPlan, push, setCursor]);

  const onGenerate = useCallback((titles: RenameTitleOption[]) => {
    startBuild(titles.map((title) => ({
      instanceId: title.instanceId,
      kind: title.kind,
      upstreamId: title.upstreamId,
      label: title.label,
    })));
  }, [startBuild]);

  /** Back to the picker. Discards the plan id; the plan itself ages out. */
  const backToScope = useCallback(() => {
    setPlanId(null);
    setOpenRowId(null);
    setConfirming(false);
    apply.clearRefusal();
    lastPhase.current = null;
  }, [apply]);

  /**
   * The only control offered on a refused or expired plan (NFR3). It rebuilds
   * from the same titles — it does not, and cannot, re-send the old plan.
   */
  const regenerate = useCallback(() => {
    apply.clearRefusal();
    if (scope && scope.length > 0) { setPlanId(null); startBuild(scope); return; }
    backToScope();
  }, [apply, scope, startBuild, backToScope]);

  const confirmApply = useCallback((typedCount: number) => {
    apply.mutate(typedCount, {
      onSuccess: () => { setConfirming(false); setOpenRowId(null); },
      onError: (error) => {
        // A refusal is an answer, not a retryable failure: the dialog closes and
        // the refusal screen takes over on the next poll.
        setConfirming(false);
        push(
          error instanceof ApiError ? error.message : 'The rename was not sent.',
          'error',
        );
      },
    });
  }, [apply, push]);

  const inspectorMode: GridMode = phase ? gridModeOf(phase) : 'preview';
  const showInspector = openRow !== null && phase !== null && GRID_PHASES.has(phase);

  return (
    <main className={`main${showInspector ? ' has-inspector' : ''}`} id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Rename"
          sub="Preview every rename before a single file moves."
          actions={planId !== null && phase !== 'applying' ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={backToScope}>
              Choose different titles
            </button>
          ) : undefined}
        />

        {planId === null ? (
          <ScopePicker
            selected={selectedTitleIds}
            onToggle={(id) => setSelectedTitleIds((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })}
            onReplace={(ids) => setSelectedTitleIds(new Set(ids))}
            onGenerate={onGenerate}
            busy={createPlan.isPending}
            error={createPlan.isError
              ? (createPlan.error instanceof ApiError
                ? createPlan.error.message
                : 'The preview could not be started.')
              : null}
          />
        ) : planQuery.isPending || plan === null ? (
          <div className="content__scroll">
            <section className="section">
              {planQuery.isError ? (
                <Callout tone="error">
                  {planQuery.error instanceof ApiError
                    ? planQuery.error.message
                    : 'Could not read the plan.'}
                  {' '}Nothing was renamed.
                </Callout>
              ) : (
                <p className="scope__loading">
                  <span className="spinner" aria-hidden="true" />
                  Opening the preview…
                </p>
              )}
            </section>
          </div>
        ) : plan.phase === 'building' ? (
          <BuildProgress
            titles={plan.titles}
            expected={scope?.length ?? plan.totalTitles}
            onCancel={backToScope}
          />
        ) : plan.phase === 'ready' ? (
          <PlanReview
            plan={plan}
            cursor={cursor}
            onCursorChange={setCursor}
            onOpen={onOpen}
            openRowId={openRowId}
            onSetExcluded={setExcluded}
            onApply={() => setConfirming(true)}
            onRegenerate={backToScope}
            excluding={exclusion.isPending}
            applying={apply.isPending}
          />
        ) : plan.phase === 'applying' || plan.phase === 'done' ? (
          <ApplyProgress
            plan={plan}
            cursor={cursor}
            onCursorChange={setCursor}
            onOpen={onOpen}
            openRowId={openRowId}
            onStartOver={backToScope}
          />
        ) : (
          <RefusalPanel
            plan={plan}
            onRegenerate={regenerate}
            busy={createPlan.isPending}
            hasScope={(scope?.length ?? 0) > 0}
          />
        )}

        {plan !== null && GRID_PHASES.has(plan.phase) && rows.length > 0 ? (
          <section className="section">
            <KeyboardHints items={HINTS} />
          </section>
        ) : null}
      </div>

      {showInspector && openRow ? (
        <RenameInspector
          row={openRow}
          mode={inspectorMode}
          onClose={() => setOpenRowId(null)}
          onSetExcluded={phase === 'ready' ? setExcluded : undefined}
          busy={exclusion.isPending}
        />
      ) : null}

      {confirming && plan !== null ? (
        <ConfirmApplyDialog
          rows={plan.rows}
          affectedFiles={plan.affectedFiles}
          busy={apply.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={confirmApply}
        />
      ) : null}

      <ToastStack toasts={toasts} />
    </main>
  );
}
