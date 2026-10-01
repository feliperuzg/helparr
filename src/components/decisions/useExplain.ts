'use client';

import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type {
  ExplainImportCandidatesResult,
  EvaluateReleasesResult,
  ExplainInput,
  ExplainResult,
  RefreshDecisionsConfigResult,
} from '@/lib/api';

/**
 * The decision explainer's data layer (ADR-10..ADR-13; T9, T14).
 *
 * Every piece here is a mutation, never a query — `useBulkSearch`'s own
 * reasoning applies to all three: a query would refetch on mount or on
 * window focus, and `explain`, `evaluate` and `refreshConfig` each cost
 * something (a file read; the instance's own indexer search; bypassing a
 * cache) that nothing may spend without an explicit call. Nothing here fires
 * until the caller invokes it.
 *
 * `explain` and `evaluate` resolve rather than reject on a degraded read —
 * the routes answer 200 with `{ ok: false, error }` for everything short of a
 * malformed request (REQ-DEC-008: the candidate's verbatim rejections survive
 * even a failed comparison), so the caller reads `result.ok` rather than
 * catching. A thrown `Error` here means the request itself could not be made
 * or was rejected as malformed.
 */
export function useExplain() {
  const explainMutation = useMutation<ExplainResult, Error, ExplainInput>({
    mutationFn: (body) => api.explainDecision(body),
  });

  const evaluateMutation = useMutation<
    EvaluateReleasesResult,
    Error,
    { instanceId: string; episodeId?: number; movieId?: number }
  >({
    mutationFn: (target) => api.evaluateReleases(target),
  });

  const importCandidatesMutation = useMutation<
    ExplainImportCandidatesResult,
    Error,
    { instanceId: string; downloadId: string }
  >({
    mutationFn: (body) => api.explainImportCandidates(body),
  });

  const refreshConfigMutation = useMutation<RefreshDecisionsConfigResult, Error, string>({
    mutationFn: (instanceId) => api.refreshDecisionsConfig(instanceId),
  });

  return {
    /** One candidate against one instance's config and on-disk file — opened on demand, never per row (NFR2). */
    explain: explainMutation.mutateAsync,
    explainResult: explainMutation.data,
    explaining: explainMutation.isPending,
    explainError: explainMutation.error,
    resetExplain: explainMutation.reset,

    /** Gaps' "Evaluate releases" button (ADR-13) — the instance's own interactive search, spent only here. */
    evaluate: evaluateMutation.mutateAsync,
    evaluateResult: evaluateMutation.data,
    evaluating: evaluateMutation.isPending,
    evaluateError: evaluateMutation.error,
    resetEvaluate: evaluateMutation.reset,

    /** The queue's `import-rejected` cause, file by file (FR17) — each rejected import candidate against its on-disk file. */
    explainImportCandidates: importCandidatesMutation.mutateAsync,
    importCandidatesResult: importCandidatesMutation.data,
    explainingImportCandidates: importCandidatesMutation.isPending,
    importCandidatesError: importCandidatesMutation.error,
    resetImportCandidates: importCandidatesMutation.reset,

    /** The explainer's "Refresh" control (ADR-11) — bypasses the 10-minute config cache TTL for one instance. */
    refreshConfig: refreshConfigMutation.mutateAsync,
    refreshConfigResult: refreshConfigMutation.data,
    refreshingConfig: refreshConfigMutation.isPending,
  };
}
