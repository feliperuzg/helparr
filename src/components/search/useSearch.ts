'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { api, type GrabInput, type SavedSearchInput } from '@/lib/api';
import type {
  EvaluatedRelease,
  GrabOutcome,
  OperationFilter,
  OperationsRead,
  ParsedTarget,
  ReleaseRead,
  SavedScopeResolution,
  SavedSearchRead,
  SearchAvailability,
  SearchCriteria,
  SearchResponse,
} from '@/lib/types';

/**
 * The search screen's data layer (T13).
 *
 * Unlike the queue, nothing here polls. A search costs every selected indexer a
 * live query, so it runs when the operator asks and not a moment otherwise —
 * no interval, no refetch on focus, no refetch on mount (NFR1).
 */

export const INDEXERS_KEY = ['search', 'indexers'] as const;
export const OPERATIONS_KEY = ['operations'] as const;

export const DEFAULT_CRITERIA: SearchCriteria = {
  query: '',
  indexerIds: [],
  categories: [],
  minSeeders: 0,
};

/**
 * The indexer roster. Read once on mount and kept — the chips are a stable list
 * of what Prowlarr manages, not live telemetry, and re-reading it on every
 * window focus would be a request the operator never asked for.
 */
export function useIndexers() {
  return useQuery<SearchAvailability>({
    queryKey: INDEXERS_KEY,
    queryFn: ({ signal }) => api.indexers(signal),
    retry: 1,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * What was submitted, and where it came from.
 *
 * `savedId` changes which route runs it. An ad-hoc search posts the criteria;
 * a saved one posts only its id and lets the server re-resolve the scope
 * against the roster that exists at that moment (ADR-6). The difference
 * matters: the criteria held here were resolved against a roster read on
 * mount, and a scope that has emptied since must be refused rather than
 * quietly widened to every indexer.
 */
export interface SearchRequest {
  criteria: SearchCriteria;
  savedId: string | null;
}

interface RunOutcome {
  /** Null only when a saved scope resolved to nothing — see the run route. */
  response: SearchResponse | null;
  /** Present only for a saved run. Always alongside `response`, never instead. */
  resolution: SavedScopeResolution | null;
}

export interface UseSearchResult {
  /** The criteria of the search that produced `data`, or null before the first. */
  submitted: SearchCriteria | null;
  /**
   * The saved search the last run came from, or null for an ad-hoc one. The
   * screen needs it to know whether `resolution` describes the saved search
   * currently selected or a different one it has since moved on from.
   */
  submittedSavedId: string | null;
  data: SearchResponse | undefined;
  /** The server's own resolution of the last saved run, if that is what it was. */
  resolution: SavedScopeResolution | null;
  /** `data.results` with the seeder threshold applied. Empty before the first run. */
  results: ReleaseRead[];
  /** How many rows the threshold is hiding, so the toolbar can say so. */
  hiddenBySeeders: number;
  isFetching: boolean;
  /** Only helparr itself being unreachable — every upstream failure is data. */
  error: Error | null;
  run: (criteria: SearchCriteria) => void;
  /**
   * Runs a saved search by id. The criteria come along only to key the cache
   * and to fill the "no results for …" line — the scope the request is actually
   * made with is the server's.
   */
  runSaved: (savedId: string, criteria: SearchCriteria) => void;
  /** Re-issues the last search. This is what the degradation banner's Retry does. */
  retry: () => void;
  /** Adjusts the threshold against the results already in hand — no new search. */
  setMinSeeders: (value: number) => void;
  minSeeders: number;
}

export function useSearch(): UseSearchResult {
  const client = useQueryClient();
  const [submitted, setSubmitted] = useState<SearchRequest | null>(null);
  const [minSeeders, setMinSeeders] = useState(0);

  // The threshold is deliberately not part of the key or the request. It
  // filters nothing upstream — Prowlarr has already done the work — so making
  // it a search parameter would re-query every indexer to hide rows the browser
  // is already holding.
  const fetched = useMemo<SearchRequest | null>(
    () => (submitted ? { ...submitted, criteria: { ...submitted.criteria, minSeeders: 0 } } : null),
    [submitted],
  );

  const query = useQuery<RunOutcome>({
    // Keyed by the request itself, so changing the scope and searching again is
    // a different search rather than a mutation of this one — the previous
    // results stay in cache and coming back to them costs nothing.
    queryKey: ['search', fetched],
    queryFn: async ({ signal }) => {
      const request = fetched as SearchRequest;
      if (request.savedId === null) {
        return { response: await api.search(request.criteria, signal), resolution: null };
      }
      // One request, both halves. The route cannot answer with results alone
      // or with unresolved references alone, which is why nothing here has to
      // reconcile two calls that could disagree (ADR-6).
      const run = await api.runSavedSearch(request.savedId, signal);
      return { response: run.search, resolution: run.resolution };
    },
    enabled: fetched !== null,
    // Results are a snapshot of a moment on the trackers. They do not go stale
    // in a way a background refetch could fix, and refetching would re-run the
    // whole fan-out.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // The route is 200 for every upstream outcome, so a failure here is helparr
    // itself. Retrying would only double a search the operator did not ask for.
    retry: false,
  });

  const run = useCallback((criteria: SearchCriteria) => {
    setSubmitted({ criteria, savedId: null });
  }, []);

  const runSaved = useCallback((savedId: string, criteria: SearchCriteria) => {
    setSubmitted({ criteria, savedId });
  }, []);

  const retry = useCallback(() => {
    if (fetched === null) return;
    void client.invalidateQueries({ queryKey: ['search', fetched] });
  }, [client, fetched]);

  const response = query.data?.response ?? undefined;
  const all = response?.available ? response.results : EMPTY;
  // `null` seeders are usenet, which the threshold has no opinion about: a
  // seeder filter cannot exclude a protocol that has no seeders.
  const results = minSeeders === 0
    ? all
    : all.filter((r) => r.seeders === null || r.seeders >= minSeeders);

  return {
    submitted: submitted?.criteria ?? null,
    submittedSavedId: submitted?.savedId ?? null,
    data: response,
    resolution: query.data?.resolution ?? null,
    results,
    hiddenBySeeders: all.length - results.length,
    isFetching: query.isFetching,
    error: query.error,
    run,
    runSaved,
    retry,
    setMinSeeders,
    minSeeders,
  };
}

/** A stable empty array, so "no results yet" is not a new identity each render. */
const EMPTY: ReleaseRead[] = [];

export const SAVED_SEARCHES_KEY = ['search', 'saved'] as const;

/**
 * The saved-search list (REQ-SEARCH-013).
 *
 * Local SQLite, so unlike everything else on this screen it is cheap and
 * refetching it costs no indexer anything. It is also deliberately independent
 * of the roster query: the list has to render while Prowlarr is unreachable,
 * because "what did I save" is exactly the question an operator asks when the
 * screen is otherwise empty.
 */
export function useSavedSearches() {
  return useQuery<SavedSearchRead[]>({
    queryKey: SAVED_SEARCHES_KEY,
    queryFn: ({ signal }) => api.savedSearches(signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useSaveSearch() {
  const client = useQueryClient();
  return useMutation<SavedSearchRead, Error, SavedSearchInput>({
    mutationFn: (body) => api.saveSearch(body),
    onSettled: () => client.invalidateQueries({ queryKey: SAVED_SEARCHES_KEY }),
  });
}

export function useRenameSavedSearch() {
  const client = useQueryClient();
  return useMutation<SavedSearchRead, Error, { id: string; name: string }>({
    mutationFn: ({ id, name }) => api.renameSavedSearch(id, name),
    onSettled: () => client.invalidateQueries({ queryKey: SAVED_SEARCHES_KEY }),
  });
}

export function useDeleteSavedSearch() {
  const client = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.deleteSavedSearch(id),
    onSettled: () => client.invalidateQueries({ queryKey: SAVED_SEARCHES_KEY }),
  });
}

/**
 * What the destination makes of the release name (ADR-3).
 *
 * Runs when the dialog opens and again on every destination change, because the
 * answer is the destination's, not the release's: Sonarr and Radarr parse the
 * same title into different things, and one of them into nothing.
 */
export function useResolvedTarget(instanceId: string | null, title: string | null) {
  return useQuery<ParsedTarget>({
    queryKey: ['search', 'resolve', instanceId, title],
    queryFn: ({ signal }) => api.resolveTarget(
      { instanceId: instanceId as string, title: title as string },
      signal,
    ),
    enabled: instanceId !== null && title !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * The destination's verdict, as a mutation rather than a query.
 *
 * It is a read, but modelling it as a query would invite exactly the thing
 * ADR-5 forbids: a refetch on mount or on focus, each one making the instance
 * run a live search against its own indexers.
 */
export function useEvaluateRelease() {
  return useMutation<
    EvaluatedRelease,
    Error,
    { instanceId: string; title: string; infoHash: string | null }
  >({
    mutationFn: (body) => api.evaluateRelease(body),
  });
}

/**
 * The grab (FR7..FR9).
 *
 * There is no optimistic update and no retry. The dialog stays open until the
 * outcome arrives, because a rejected grab's reasons are the result the operator
 * is waiting for — not an error to surface and dismiss.
 */
export function useGrab() {
  const client = useQueryClient();

  return useMutation<GrabOutcome, Error, GrabInput>({
    mutationFn: (body) => api.grab(body),
    onSettled: () => {
      // Every outcome writes a row, including the rejections and the failures.
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    },
  });
}

/** The Activity screen. Local SQLite, so this one is free to refetch. */
export function useOperations(filter: OperationFilter) {
  return useQuery<OperationsRead>({
    queryKey: [...OPERATIONS_KEY, filter],
    queryFn: ({ signal }) => api.operations(filter, signal),
    retry: 1,
    staleTime: 10_000,
  });
}

export function usePurgeOperations() {
  const client = useQueryClient();

  return useMutation<{ purged: number }, Error, { expect: number }>({
    mutationFn: ({ expect }) => api.purgeOperations(expect),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: OPERATIONS_KEY });
    },
  });
}
