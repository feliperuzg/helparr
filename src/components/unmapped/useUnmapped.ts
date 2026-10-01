'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { api } from '@/lib/api';
import type { UnmappedRead } from '@/lib/unmapped';

/**
 * The `/unmapped` screen's data layer (ADR-9, REQ-GAPS-022..026; T13, T14) —
 * `useGapsList`'s own shape: loads on mount, never polls (the read is
 * instance-scale, not something to leave running), and `refresh()` forces the
 * *same* read through `?refresh=1` rather than splitting it into a second
 * cache entry. The route is uncached upstream either way (every request
 * already reaches the instances), so `refresh` exists for parity with `gaps`
 * and to let the operator ask again without a reload.
 */

export const UNMAPPED_KEY = ['unmapped'] as const;

export function useUnmapped() {
  const client = useQueryClient();
  // A ref, not state, and not part of the query key, for the same reason
  // `useGapsList`'s `forceNext` is not: `refresh:1` asks for the same list a
  // different way, not a different list. Consumed on read so a forced
  // refresh costs one request and not every one after it.
  const forceNext = useRef(false);

  const query = useQuery<UnmappedRead>({
    queryKey: UNMAPPED_KEY,
    queryFn: ({ signal }) => {
      const refresh = forceNext.current;
      forceNext.current = false;
      return api.unmapped({ refresh }, signal);
    },
    // Always 200, even when every instance failed (route's own doc comment) —
    // a failure here is helparr itself, and retrying twice would only slow
    // down the explanation.
    retry: 1,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(() => {
    forceNext.current = true;
    return client.invalidateQueries({ queryKey: UNMAPPED_KEY });
  }, [client]);

  return {
    ...query,
    /** When this read was taken, for the screen's "read N ago" — `null` before the first read lands. */
    readAt: query.data?.readAt ?? null,
    refresh,
  };
}
