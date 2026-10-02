'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { OPERATIONS_KEY } from '@/components/search/useSearch';
import { api, ApiError, type ImportEpisodeChoice, type ImportPlanRead } from '@/lib/api';
import type { ImportBulkEdit, ImportBulkResult, ImportMapping, ImportRefusal } from '@/lib/importPlan';

/**
 * Force import's data layer (ADR-3..ADR-8; T11, T14) — `useRename.ts`'s terms,
 * applied to a plan that never has a `building` phase: `manualimport` is one
 * synchronous read, so `useCreateImportPlan` resolves with the finished plan
 * rather than a bare id.
 *
 * Polling is conditional, as rename's is, but on two signals rather than one:
 * `phase === 'applying'` (the DB says the apply is underway) *or* `importing`
 * (`startImport`'s own in-flight marker, kept separate server-side so a poll
 * can tell "still applying" from "this process is still running it" without
 * inferring one from the other — see `import/plan/[id]/route.ts`). Either one
 * being true means per-row outcomes can still change under this read.
 */

export const IMPORT_PLAN_KEY = (planId: string | null) => ['import-plan', planId] as const;

/** Roughly a second, per ADR-5/rename's own POLL_MS — granular enough to watch, cheap enough to leave on. */
const POLL_MS = 1_000;

function isSettled(plan: ImportPlanRead | undefined): boolean {
  if (!plan) return false;
  return plan.phase !== 'applying' && !plan.importing;
}

/**
 * The scope → plan transition. Unlike `useCreateRenamePlan`, the plan itself
 * comes back (ADR-3) — so the result is seeded straight into the cache
 * `useImportPlan` reads, and the first render after creation needs no extra
 * round trip.
 */
export function useCreateImportPlan() {
  const client = useQueryClient();

  return useMutation<ImportPlanRead, Error, { instanceId: string; recordId: number }>({
    mutationFn: (body) => api.createImportPlan(body),
    onSuccess: (plan) => {
      client.setQueryData<ImportPlanRead>(IMPORT_PLAN_KEY(plan.id), plan);
    },
  });
}

/** The plan, whole, on every read — build result, row-edit result and apply poll alike. */
export function useImportPlan(planId: string | null) {
  return useQuery<ImportPlanRead>({
    queryKey: IMPORT_PLAN_KEY(planId),
    queryFn: ({ signal }) => api.importPlan(planId as string, signal),
    enabled: planId !== null,
    // Never cached across a mount — same reasoning as `useRenamePlan`: the
    // typed-count gate and the TTL banner are both checked against exactly
    // this response, not a stale one.
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => (isSettled(query.state.data) ? false : POLL_MS),
    refetchIntervalInBackground: true,
    retry: 1,
  });
}

/**
 * One row edit — include/exclude or a mapping override (ADR-4, FR7). The
 * response *is* the new plan, written straight into the cache, as rename's
 * exclusion does: the totals the typed-count gate reads must move with it,
 * not wait a second for the next poll.
 */
export function useEditImportRow(planId: string | null) {
  const client = useQueryClient();

  return useMutation<
    ImportPlanRead,
    Error,
    { ordinal: number; included?: boolean; mapping?: ImportMapping }
  >({
    mutationFn: (body) => api.editImportRow(planId as string, body),
    onSuccess: (plan) => {
      client.setQueryData(IMPORT_PLAN_KEY(planId), plan);
    },
  });
}

/**
 * Include all / Exclude all / Include all replacements and range inclusion
 * (ADR-6). Same cache discipline as `useEditImportRow`; the `bulk` summary is
 * the mutation's result for the outcome line, and stays out of the cached
 * plan so the next poll does not have to clear it.
 */
export function useBulkEditImportRows(planId: string | null) {
  const client = useQueryClient();

  return useMutation<ImportBulkResult, Error, ImportBulkEdit>({
    mutationFn: async (body) => {
      const { bulk, ...plan } = await api.bulkEditImportRows(planId as string, body);
      client.setQueryData<ImportPlanRead>(IMPORT_PLAN_KEY(planId), plan);
      return bulk;
    },
  });
}

/**
 * The series episode picker's source (ADR-4). `enabled` is the whole point,
 * as in `useGapHistory`: the picker is opened on one row at a time, and the
 * read must not fire until it is.
 */
export function useImportEpisodeChoices(planId: string | null, enabled: boolean) {
  return useQuery<ImportEpisodeChoice[]>({
    queryKey: ['import-plan', planId, 'episodes'],
    queryFn: ({ signal }) => api.importEpisodeChoices(planId as string, signal),
    enabled: planId !== null && enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Apply, and the refusal it can come back with (ADR-5..ADR-7).
 *
 * Unlike `useApplyRenamePlan`, the refusal is never reconstructed from a
 * short reason code: force import's 409 body carries the whole
 * `ImportRefusal` — `reason` plus `changes`, the words the screen shows — on
 * `ApiError.detail.refusal`, and that object is read back verbatim rather
 * than rebuilt. `drift` and `expired` are refusals a rebuild is the only way
 * past (no bypass exists, ADR-5); the caller decides that from `refusal.reason`
 * the same way it already reads every other field here.
 */
export function useApplyImportPlan(planId: string | null) {
  const client = useQueryClient();
  const [refusal, setRefusal] = useState<ImportRefusal | null>(null);

  const mutation = useMutation<{ planId: string; rowCount: number }, Error, number>({
    mutationFn: async (typedCount) => {
      setRefusal(null);
      try {
        return await api.applyImportPlan(planId as string, typedCount);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const refusalDetail = extractRefusal(error.detail);
          if (refusalDetail) setRefusal(refusalDetail);
        }
        throw error;
      }
    },
    retry: 0,
    onSettled: () => {
      // Whatever happened — started, refused or failed — the plan's phase
      // moved and the poll needs to pick it up now rather than a second from
      // now.
      void client.invalidateQueries({ queryKey: IMPORT_PLAN_KEY(planId) });
      // A started import writes operation-log records once it settles, same
      // as rename's apply.
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    },
  });

  const clearRefusal = useCallback(() => setRefusal(null), []);

  return { ...mutation, refusal, clearRefusal };
}

function extractRefusal(detail: unknown): ImportRefusal | null {
  if (
    typeof detail === 'object'
    && detail !== null
    && 'refusal' in detail
    && typeof (detail as { refusal?: unknown }).refusal === 'object'
    && (detail as { refusal?: unknown }).refusal !== null
  ) {
    return (detail as { refusal: ImportRefusal }).refusal;
  }
  return null;
}
