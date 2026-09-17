'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { OPERATIONS_KEY } from '@/components/search/useSearch';
import { api, ApiError } from '@/lib/api';
import type { RenamePlanDto, RenameRefusal, RenameScopeEntry } from '@/lib/types';

/**
 * The bulk-rename screen's data layer (T9).
 *
 * Unlike the queue (always polling) and gaps (never polling), this one polls
 * *conditionally*: while a plan is building or applying there is server-side
 * work whose progress only a read can reveal, and the rest of the time there is
 * nothing to ask about. The phase in the last response decides, so the poll
 * stops itself the moment the plan settles rather than needing the component to
 * remember to turn it off.
 */

export const RENAME_PLAN_KEY = (planId: string | null) => ['rename-plan', planId] as const;

/** Roughly a second, per ADR-5 — granular enough to watch, cheap enough to leave on. */
const POLL_MS = 1_000;

/** The phases where the server is still doing something. */
function isSettled(plan: RenamePlanDto | undefined): boolean {
  if (!plan) return false;
  return plan.phase !== 'building' && plan.phase !== 'applying';
}

export function useRenamePlan(planId: string | null) {
  return useQuery<RenamePlanDto>({
    queryKey: RENAME_PLAN_KEY(planId),
    queryFn: ({ signal }) => api.renamePlan(planId as string, signal),
    enabled: planId !== null,
    // Never cached across a mount. A stale plan read is a plan whose expiry the
    // operator cannot see, and the typed-count gate is checked against
    // `affectedFiles` from exactly this response.
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => (isSettled(query.state.data) ? false : POLL_MS),
    // Keep polling a backgrounded tab: a build the operator switched away from
    // should be finished when they come back, not restarted.
    refetchIntervalInBackground: true,
    retry: 1,
  });
}

/**
 * The scope → plan-id transition.
 *
 * Returns the id rather than the plan: at the moment this resolves the build has
 * only just been queued, and `useRenamePlan` is what watches it fill in.
 */
export function useCreateRenamePlan() {
  return useMutation<string, Error, RenameScopeEntry[]>({
    mutationFn: (scope) => api.createRenamePlan(scope),
  });
}

/**
 * Exclusion (FR7).
 *
 * The response *is* the new plan, so it is written straight into the cache — a
 * checkbox that toggled and then waited a second for a poll to confirm it would
 * feel broken, and the totals the typed-count gate reads must move with it.
 */
export function useRenameExclusion(planId: string | null) {
  const client = useQueryClient();

  return useMutation<RenamePlanDto, Error, { rowIds: string[]; excluded: boolean }>({
    mutationFn: ({ rowIds, excluded }) =>
      api.setRenameExclusion(planId as string, rowIds, excluded),
    onSuccess: (plan) => {
      client.setQueryData(RENAME_PLAN_KEY(planId), plan);
    },
  });
}

/**
 * Apply, and the refusal it can come back with.
 *
 * A refusal is not an error state to retry — it is an *answer*: the plan aged
 * out, or the library moved, and in both cases nothing was renamed. It is held
 * separately from the mutation's own error so the screen can say which of the
 * two happened, and `retry: 0` because re-sending an apply is the one thing that
 * must never happen automatically.
 *
 * `drifted` is empty here on purpose. A real precondition drift is persisted
 * against the plan by the server, so the list of paths arrives on the next poll
 * as `plan.refusal.drifted` — one copy, from the same read the rest of the
 * screen renders, rather than a second one assembled from an error body that
 * would then have to be kept in step with it.
 */
export function useApplyRenamePlan(planId: string | null) {
  const client = useQueryClient();
  const [refusal, setRefusal] = useState<RenameRefusal | null>(null);

  const mutation = useMutation<{ rowCount: number }, Error, number>({
    mutationFn: async (typedCount) => {
      setRefusal(null);
      try {
        return await api.applyRenamePlan(planId as string, typedCount);
      } catch (error) {
        if (error instanceof ApiError && isRefusalKind(error.reason)) {
          setRefusal({
            kind: error.reason,
            reason: error.message,
            drifted: [],
          });
        }
        throw error;
      }
    },
    retry: 0,
    onSettled: () => {
      // Whatever happened — started, refused or failed — the plan's phase moved
      // and the poll needs to pick it up now rather than a second from now.
      void client.invalidateQueries({ queryKey: RENAME_PLAN_KEY(planId) });
      // A rename writes operation-log records (NFR7), so the log screen's cache
      // is stale from this moment.
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    },
  });

  const clearRefusal = useCallback(() => setRefusal(null), []);

  return { ...mutation, refusal, clearRefusal };
}

function isRefusalKind(value: string | undefined): value is RenameRefusal['kind'] {
  return value === 'expired' || value === 'precondition-drift' || value === 'empty';
}
