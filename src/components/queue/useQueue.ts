'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api } from '@/lib/api';
import type { QueueResponse, RemovalOutcome, RemovalRequest, RemovalTarget } from '@/lib/types';

/**
 * The queue query and the one mutation (ADR-2, REQ-QUEUE-015, T12).
 */

export const QUEUE_KEY = ['queue'] as const;

/** ADR-2: 30s by default, overridable by the operator. */
export const DEFAULT_REFRESH_MS = 30_000;

export interface UseQueueOptions {
  /** Resolved server-side from `HELPARR_QUEUE_REFRESH_SECONDS` (ADR-2). */
  refreshMs?: number;
}

export function useQueue({ refreshMs = DEFAULT_REFRESH_MS }: UseQueueOptions = {}) {
  const client = useQueryClient();

  const query = useQuery<QueueResponse>({
    queryKey: QUEUE_KEY,
    queryFn: ({ signal }) => api.queue(signal),
    refetchInterval: refreshMs,
    // Keeps polling behind a backgrounded tab off. The operator is not reading
    // a screen they cannot see, and an instance under strain should not be
    // paying for it (NFR1).
    refetchIntervalInBackground: false,
    // The route answers 200 even when every instance failed, so a retry here
    // could only ever mean helparr itself was unreachable. One is enough.
    retry: 1,
    // Long enough that the interval, not staleness, decides when we refetch —
    // remounting the screen must not fire a second read on top of the timer.
    staleTime: refreshMs - 1_000,
  });

  /**
   * `isLoading` is true only when there is no data at all, so the skeleton
   * appears on first paint and never again. A background refetch replacing the
   * table with a skeleton would destroy the thing the screen is for
   * (REQ-QUEUE-015).
   */
  const showSkeleton = query.isLoading;

  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: QUEUE_KEY });
  }, [client]);

  return { ...query, showSkeleton, refresh };
}

export interface RemovalResult {
  target: RemovalTarget;
  outcome: RemovalOutcome;
}

/**
 * Removal (REQ-QUEUE-013, -014).
 *
 * One request per item, run concurrently, and every one of them settled — a
 * failure in the third must not cancel or roll back the first two. The rows
 * stay on screen throughout; there is deliberately no optimistic update
 * anywhere on this path.
 */
export function useRemoveFromQueue() {
  const client = useQueryClient();

  return useMutation<
    RemovalResult[],
    Error,
    { targets: RemovalTarget[]; flags: RemovalRequest }
  >({
    mutationFn: async ({ targets, flags }) => {
      const settled = await Promise.allSettled(
        targets.map((target) =>
          api.removeQueueItem(target.instanceId, target.recordId, flags)),
      );

      return settled.map((entry, i) => ({
        target: targets[i],
        outcome: entry.status === 'fulfilled'
          ? entry.value
          : {
            instanceId: targets[i].instanceId,
            recordId: targets[i].recordId,
            status: 'failed' as const,
            reason: entry.reason instanceof Error
              ? entry.reason.message
              : 'The removal did not complete.',
          },
      }));
    },
    onSettled: () => {
      // The local drop is a latency bridge; this is what the table converges
      // on — including the case where a "successful" removal removed nothing.
      void client.invalidateQueries({ queryKey: QUEUE_KEY });
    },
  });
}
