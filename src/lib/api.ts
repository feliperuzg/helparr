import type {
  AttachPreview,
  BulkSearchOutcome,
  EvaluatedRelease,
  GapHistoryRead,
  GapKind,
  GapsResponse,
  GrabOutcome,
  HealthResponse,
  InstanceDto,
  InstanceKind,
  OperationFilter,
  OperationsRead,
  ParsedTarget,
  QueueResponse,
  RemovalOutcome,
  RemovalRequest,
  RenamePlanDto,
  RenameScopeEntry,
  RenameTitlesRead,
  SavedSearchRead,
  SavedSearchRef,
  SavedSearchRun,
  SearchAvailability,
  SearchCriteria,
  SearchResponse,
  SeasonAttachPreview,
  TestOutcome,
} from './types';

/**
 * Browser-side API client.
 *
 * Every call goes to helparr's own route handlers — never to an *arr instance
 * directly. That is the whole point of the BFF: the browser has no base URL and
 * no credential to leak (REQ-INST-005).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

async function request<T>(path: string, init?: RequestInit, bounceOn401 = true): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });

  if (response.status === 401 && bounceOn401 && typeof window !== 'undefined') {
    // The session expired underneath a long-lived tab. Bounce to login rather
    // than rendering a screen full of errors that look like instance failures.
    //
    // A hard navigation is the point, so Next 16's preference for
    // `useRouter().push()` does not apply here twice over: this is a plain
    // module with no hooks available, and a soft navigation would preserve the
    // TanStack Query cache — which still holds instance data fetched under the
    // session that just died. Reloading the document is what discards it.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/login');
    throw new ApiError(401, 'Session expired.');
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = (payload && typeof payload.error === 'string')
      ? payload.error
      : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message, payload?.reason);
  }

  return payload as T;
}

export type CredentialInput =
  | { type: 'api-key'; apiKey: string }
  | { type: 'userpass'; username: string; password: string };

export interface InstanceInput {
  kind: InstanceKind;
  label: string;
  baseUrl: string;
  credential: CredentialInput;
  enabled?: boolean;
  testToken?: string;
}

/** The shape `POST /api/grab` accepts, mirrored so the caller cannot omit a field. */
export interface GrabInput {
  instanceId: string;
  title: string;
  downloadUrl: string;
  protocol: 'torrent' | 'usenet';
  publishDate: string;
  indexer: string | null;
  /** What the confirmation named — carried through to the log and the toast. */
  entityRef: string | null;
}

/**
 * What the toolbar sends when the operator saves the search in front of them.
 *
 * `indexers` carries names as well as ids because the browser is the only place
 * that knows both: it rendered the chips from the roster. Re-deriving them
 * server-side later would name whatever holds the id *then*, which is the one
 * thing a stale-reference message must not do (ADR-6).
 */
export interface SavedSearchInput {
  name: string;
  query: string;
  indexers: SavedSearchRef[];
  categories: number[];
  minSeeders: number;
}

export const api = {
  listInstances: () =>
    request<{ instances: InstanceDto[] }>('/api/instances').then((r) => r.instances),

  health: () => request<HealthResponse>('/api/health'),

  queue: (signal?: AbortSignal) => request<QueueResponse>('/api/queue', { signal }),

  // Every flag is spelled out on the wire. The route rejects an omitted one
  // rather than defaulting it, so the type being required here is the same rule
  // enforced twice — once where it is easy to catch, once where it matters.
  removeQueueItem: (instanceId: string, recordId: number, flags: RemovalRequest) =>
    request<RemovalOutcome>(
      `/api/queue/${encodeURIComponent(instanceId)}/${recordId}`
        + `?removeFromClient=${flags.removeFromClient}`
        + `&blocklist=${flags.blocklist}`
        + `&skipRedownload=${flags.skipRedownload}`,
      { method: 'DELETE' },
    ),

  /* ── Indexer search and manual grab ────────────────────────────────────── */

  indexers: (signal?: AbortSignal) =>
    request<SearchAvailability>('/api/search/indexers', { signal }),

  // `SearchResponse` is a union on `available`: Prowlarr being down is a 200
  // describing the outage, so it arrives here as data rather than as a throw.
  search: (criteria: SearchCriteria, signal?: AbortSignal) =>
    request<SearchResponse>('/api/search', {
      method: 'POST',
      body: JSON.stringify(criteria),
      signal,
    }),

  resolveTarget: (body: { instanceId: string; title: string }, signal?: AbortSignal) =>
    request<ParsedTarget>('/api/search/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  // Never called on render. This makes the instance run a live indexer search
  // of its own, so it is wired to an explicit control (ADR-5).
  evaluateRelease: (
    body: { instanceId: string; title: string; infoHash: string | null },
    signal?: AbortSignal,
  ) =>
    request<EvaluatedRelease>('/api/search/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  // No `signal`. A push that may already have been accepted must not be
  // abandoned mid-flight — see the route for why.
  grab: (body: GrabInput) =>
    request<GrabOutcome>('/api/grab', { method: 'POST', body: JSON.stringify(body) }),

  /* ── Saved searches ────────────────────────────────────────────────────── */

  // Local SQLite, so this one is free to read and keeps answering while
  // Prowlarr is down — which is the whole point of REQ-SEARCH-013.
  savedSearches: (signal?: AbortSignal) =>
    request<{ searches: SavedSearchRead[] }>('/api/searches', { signal })
      .then((r) => r.searches),

  saveSearch: (body: SavedSearchInput) =>
    request<{ search: SavedSearchRead }>('/api/searches', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.search),

  renameSavedSearch: (id: string, name: string) =>
    request<{ search: SavedSearchRead }>(`/api/searches/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }).then((r) => r.search),

  deleteSavedSearch: (id: string) =>
    request<void>(`/api/searches/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // The only saved-search call that reaches an indexer, which is why it is a
  // POST to its own path and never fires on selection (REQ-SEARCH-012).
  runSavedSearch: (id: string, signal?: AbortSignal) =>
    request<SavedSearchRun>(`/api/searches/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      signal,
    }),

  /* ── Library gaps and manual attach ────────────────────────────────────── */

  // `refresh` bypasses the cached Sonarr library join (ADR-4). The default read
  // uses whatever is cached, which is what makes revisiting the screen cheap.
  gaps: (options: { refresh?: boolean } = {}, signal?: AbortSignal) =>
    request<GapsResponse>(`/api/gaps${options.refresh ? '?refresh=1' : ''}`, { signal }),

  // One request per item, and only when the inspector is open on it (ADR-6).
  gapHistory: (
    params: { instanceId: string; kind: GapKind; upstreamId: number },
    signal?: AbortSignal,
  ) =>
    request<GapHistoryRead>(
      `/api/gaps/history?instanceId=${encodeURIComponent(params.instanceId)}`
        + `&kind=${params.kind}&upstreamId=${params.upstreamId}`,
      { signal },
    ),

  // Read-only: a synthesized title and the instance's own `GET /parse`. What it
  // returns is what the attach confirmation shows, including a mismatch.
  resolveGap: (gapId: string, signal?: AbortSignal) =>
    request<AttachPreview>('/api/gaps/resolve', {
      method: 'POST',
      body: JSON.stringify({ gapId }),
      signal,
    }),

  // The season-scoped pre-flight. Same route, same read-only guarantee; the
  // `season` in the body is what switches the scope (ADR-7).
  resolveSeason: (gapId: string, season: number, signal?: AbortSignal) =>
    request<SeasonAttachPreview>('/api/gaps/resolve', {
      method: 'POST',
      body: JSON.stringify({ gapId, season }),
      signal,
    }),

  // No `signal`, as with `grab` — the push may already have been accepted.
  // Only the gap id travels: the title is re-synthesized server-side.
  attachGap: (body: { gapId: string; link: string }) =>
    request<GrabOutcome>('/api/gaps/attach', { method: 'POST', body: JSON.stringify(body) }),

  // The season write. The number says which season; the name it is pushed under
  // is still the server's to decide (NFR3).
  attachSeason: (body: { gapId: string; season: number; link: string }) =>
    request<GrabOutcome>('/api/gaps/attach', { method: 'POST', body: JSON.stringify(body) }),

  // Never called on render or on a selection change. This spends indexer quota,
  // so it is reached only from a confirmed dialog (REQ-GAPS-009).
  bulkSearchGaps: (gapIds: string[]) =>
    request<{ outcomes: BulkSearchOutcome[] }>('/api/gaps/search', {
      method: 'POST',
      body: JSON.stringify({ gapIds }),
    }).then((r) => r.outcomes),

  operations: (filter: OperationFilter, signal?: AbortSignal) =>
    request<OperationsRead>(`/api/operations?filter=${filter}`, { signal }),

  /** `expect` is the count the confirmation stated; a mismatch is refused. */
  purgeOperations: (expect: number) =>
    request<{ purged: number }>(`/api/operations?expect=${expect}`, { method: 'DELETE' }),

  testConnection: (body: { kind: InstanceKind; baseUrl: string; credential: CredentialInput }) =>
    request<TestOutcome>('/api/instances/test', { method: 'POST', body: JSON.stringify(body) }),

  createInstance: (body: InstanceInput) =>
    request<{ instance: InstanceDto }>('/api/instances', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => r.instance),

  updateInstance: (id: string, body: Partial<Omit<InstanceInput, 'kind'>>) =>
    request<{ instance: InstanceDto }>(`/api/instances/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .then((r) => r.instance),

  deleteInstance: (id: string) =>
    request<void>(`/api/instances/${id}`, { method: 'DELETE' }),

  /** Collapses an open breaker's reset window so the next read gets through. */
  retryInstance: (id: string) =>
    request<void>(`/api/instances/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  /* ── Bulk rename (bulk-rename-preview, T9) ────────────────────────────── */

  /**
   * Every title the operator could rename, across every instance (FR1, T10).
   *
   * A read, and the only one the picker makes. Selecting titles here reaches no
   * instance at all — the first upstream call of the whole flow is the rescan
   * `createRenamePlan` starts.
   */
  renameTitles: (signal?: AbortSignal) =>
    request<RenameTitlesRead>('/api/rename/titles', { signal }),

  /**
   * Starts a build and returns its id. Renames nothing — a plan is inert until
   * `applyRenamePlan` names it.
   */
  createRenamePlan: (scope: RenameScopeEntry[]) =>
    request<{ planId: string }>('/api/rename/plan', {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }).then((r) => r.planId),

  /** The whole plan, whatever phase it is in — build poll, apply poll and final read. */
  renamePlan: (planId: string, signal?: AbortSignal) =>
    request<RenamePlanDto>(`/api/rename/plan/${encodeURIComponent(planId)}`, { signal }),

  /** Exclusion by server-minted row id (FR7). Returns the re-read plan. */
  setRenameExclusion: (planId: string, rowIds: string[], excluded: boolean) =>
    request<RenamePlanDto>(`/api/rename/plan/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ rowIds, excluded }),
    }),

  /**
   * The only call in helparr that can rename a file.
   *
   * `typedCount` is the entire body, and that is deliberate (NFR1): there is no
   * argument here for naming files, and no flag for skipping the check. A
   * caller who wants a different set of files has to build a different plan.
   */
  applyRenamePlan: (planId: string, typedCount: number) =>
    request<{ planId: string; rowCount: number }>(
      `/api/rename/plan/${encodeURIComponent(planId)}/apply`,
      { method: 'POST', body: JSON.stringify({ typedCount }) },
    ),

  // The auth endpoints opt out of the bounce. A 401 here means "that password
  // is wrong", not "your session lapsed" — redirecting to /login would reload
  // the page the operator is already on and throw away the only explanation
  // they were going to get.
  login: (password: string) =>
    request<void>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }, false),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }, false),
};
