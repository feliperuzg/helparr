'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { api } from '@/lib/api';
import type {
  AttachPreview,
  BulkSearchOutcome,
  GapHistoryRead,
  GapKind,
  GapsResponse,
  GrabOutcome,
  SeasonAttachPreview,
} from '@/lib/types';
import { OPERATIONS_KEY } from '@/components/search/useSearch';

/**
 * The gaps screen's data layer (T13..T17).
 *
 * Between the queue's polling and search's run-on-demand: the list is a read of
 * the operator's own instances, so it is safe to hold and cheap to revisit, but
 * it is a *library-scale* read — several seconds and several pages on a real
 * Sonarr — so nothing here polls and nothing refetches on focus. Freshness is an
 * explicit button (REQ-GAPS-016).
 */

export const GAPS_KEY = ['gaps'] as const;

export function useGapsList() {
  const client = useQueryClient();
  // A ref, not state, and deliberately not part of the query key: `refresh:1`
  // asks for the *same* list read a different way (ADR-4 — bypass the cached
  // Sonarr join), so keying on it would split one list into two cache entries
  // that differ only in how they were fetched. Consumed on read so a forced
  // refresh costs one full library read and not every one after it.
  const forceNext = useRef(false);

  const query = useQuery<GapsResponse>({
    queryKey: GAPS_KEY,
    queryFn: ({ signal }) => {
      const refresh = forceNext.current;
      forceNext.current = false;
      return api.gaps({ refresh }, signal);
    },
    // The route is 200 for every upstream outcome — an unreadable instance
    // arrives as an entry in `errors`, not as a throw. A failure here is helparr
    // itself, and retrying it twice would only slow down the explanation.
    retry: 1,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback((options: { force?: boolean } = {}) => {
    if (options.force) forceNext.current = true;
    return client.invalidateQueries({ queryKey: GAPS_KEY });
  }, [client]);

  return { ...query, refresh };
}

/**
 * One item's history, read only while the inspector is open on it (ADR-6).
 *
 * `enabled` is the whole point: a grid of four hundred rows must never turn into
 * four hundred `/history` requests, so this query cannot exist until a gap is
 * actually selected.
 */
export function useGapHistory(
  params: { instanceId: string; kind: GapKind; upstreamId: number } | null,
) {
  return useQuery<GapHistoryRead>({
    queryKey: ['gaps', 'history', params?.instanceId, params?.kind, params?.upstreamId],
    queryFn: ({ signal }) => api.gapHistory(params as NonNullable<typeof params>, signal),
    enabled: params !== null,
    // The history of a missing item changes only when something acts on it, and
    // the operator is looking at it right now.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * The attach pre-flight — read-only, and re-run whenever the dialog opens on a
 * different gap. It asks the instance what it makes of the name helparr would
 * push, which is the only honest thing the confirmation can show.
 */
export function useAttachPreview(gapId: string | null) {
  return useQuery<AttachPreview>({
    queryKey: ['gaps', 'resolve', gapId],
    queryFn: ({ signal }) => api.resolveGap(gapId as string, signal),
    enabled: gapId !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * The season pre-flight — the same read-only contract, one scope wider.
 *
 * `season` is in the key *and* in `enabled`, and both matter. In the key because
 * changing the choice must produce a different answer, not a cached one; in
 * `enabled` because nothing is asked until a season has actually been chosen —
 * the chooser's first state issues no request at all (REQ-GAPS-018).
 */
export function useSeasonAttachPreview(gapId: string | null, season: number | null) {
  return useQuery<SeasonAttachPreview>({
    queryKey: ['gaps', 'resolve', gapId, season],
    queryFn: ({ signal }) => api.resolveSeason(gapId as string, season as number, signal),
    enabled: gapId !== null && season !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * The write (FR6..FR8).
 *
 * No optimistic update: the gap stays listed whatever the answer is, because
 * only a later library read can say the file now exists. The gaps list is
 * invalidated on settle so the *next* read is fresh, not so this one lies.
 */
export function useAttachGap() {
  const client = useQueryClient();

  return useMutation<GrabOutcome, Error, { gapId: string; link: string }>({
    mutationFn: (body) => api.attachGap(body),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
      void client.invalidateQueries({ queryKey: GAPS_KEY });
    },
  });
}

/**
 * The season write — one push, one operation row, whatever the pack turns out to
 * contain (FR6, FR8, FR10).
 *
 * Same invalidations as the episode attach, and for the same reason: the season
 * stays listed until a later library read says otherwise.
 */
export function useAttachSeason() {
  const client = useQueryClient();

  return useMutation<GrabOutcome, Error, { gapId: string; season: number; link: string }>({
    mutationFn: (body) => api.attachSeason(body),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
      void client.invalidateQueries({ queryKey: GAPS_KEY });
    },
  });
}

/**
 * The bulk command, as a mutation so it can only ever be fired by a confirmed
 * click — a query would refetch on mount or on focus and spend indexer quota
 * nobody asked for (REQ-GAPS-009).
 */
export function useBulkSearch() {
  const client = useQueryClient();

  return useMutation<BulkSearchOutcome[], Error, string[]>({
    mutationFn: (gapIds) => api.bulkSearchGaps(gapIds),
    onSettled: () => {
      // One row per instance was written; nothing about the gaps themselves has
      // changed yet, and deliberately so.
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    },
  });
}
