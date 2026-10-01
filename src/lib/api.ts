import type { DecisionCandidate } from './decisions';
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
import type { DecisionComparison } from './decisions';
import type { ImportMapping, ImportPlan } from './importPlan';
import type { UnmappedRead } from './unmapped';

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
  /**
   * The parsed error body, whole. Most callers only need `reason` (a short
   * code string); a caller that needs a typed payload the body carries beyond
   * that — force import's `refusal` object, for one — reads it from here
   * rather than this class growing a second strongly-typed field per route.
   */
  readonly detail?: unknown;

  constructor(status: number, message: string, reason?: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
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
    throw new ApiError(response.status, message, payload?.reason, payload);
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

/* ── Force import (T11, T14) ───────────────────────────────────────────── */

/** `ImportPlan` plus `startImport`'s own in-flight marker — every `GET`/`PATCH` on a plan returns this, never the bare plan. */
export interface ImportPlanRead extends ImportPlan {
  importing: boolean;
  /** Whether helparr will send this instance kind's import at all (ADR-6) — Radarr stays read-only until T0's capture confirms its payload. */
  writeEnabled: boolean;
}

/** One `/manualimport`-resolved episode, as the series picker renders it. */
export interface ImportEpisodeChoice {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  hasFile: boolean;
  episodeFileId: number | null;
}

/* ── Decision explainer (T9, T14) ──────────────────────────────────────── */

// The candidate and target shapes live in `decisions.ts` so `types.ts` can
// carry them on `EvaluatedRelease` without importing this module.
export type {
  DecisionCandidate,
  DecisionCustomFormatRef,
  DecisionQualityModel,
  DecisionTarget,
} from './decisions';

export interface ExplainInput {
  instanceId: string;
  episodeId?: number;
  movieId?: number;
  /** `null` means the target has no file at all — never read, never 404'd. */
  fileId: number | null;
  profileId: number;
  candidate: DecisionCandidate;
}

/** Mirrors `DecisionsFailureKind` (`configCache.ts`) plus the explainer's own two cases. */
export type DecisionsFailureKind =
  | 'unreachable'
  | 'unauthorized'
  | 'upstream-error'
  | 'timeout'
  | 'no-instance'
  | 'not-decisions-client';

export interface DecisionsFailure {
  kind: DecisionsFailureKind;
  reason: string;
}

export type ExplainFailureKind = DecisionsFailureKind | 'config-unavailable' | 'existing-file-unavailable';

/** A degraded explanation still carries the candidate's verbatim rejections (REQ-DEC-008). */
export interface ExplainFailure {
  kind: ExplainFailureKind;
  reason: string;
  rejections: string[];
}

// Always 200 (REQ-DEC-008) — failure is `{ ok: false }`, never a throw.
export type ExplainResult =
  | { ok: true; value: DecisionComparison }
  | { ok: false; error: ExplainFailure };

export type EvaluateReleasesResult =
  | { ok: true; value: DecisionCandidate[] }
  | { ok: false; error: DecisionsFailure };

/** One rejected import candidate of a queue record, explained (FR17, T19). */
export interface ImportCandidateExplanation {
  path: string;
  /** The file name the instance scored, as it reported it. */
  name: string;
  result: ExplainResult;
}

export type ExplainImportCandidatesResult =
  | { ok: true; value: ImportCandidateExplanation[] }
  | { ok: false; error: DecisionsFailure };

export type RefreshDecisionsConfigResult =
  | { ok: true; value: { fetchedAt: string } }
  | { ok: false; error: DecisionsFailure };

export const api = {
  listInstances: () =>
    request<{ instances: InstanceDto[] }>('/api/instances').then((r) => r.instances),

  health: () => request<HealthResponse>('/api/health'),

  /**
   * `bounceOn401: false` is load-bearing. The rotation route answers 401 for a
   * wrong *current password*, and the generic handler reads every 401 as an
   * expired session — so the default would throw the operator out to `/login`
   * for a typo, discarding the form they were filling in.
   */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>(
      '/api/auth/password',
      { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) },
      false,
    ),

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

  /* ── Force import (ADR-3, ADR-4, ADR-8; T11, T14) ──────────────────────── */

  // `manualimport` is one synchronous read, so this returns the finished plan
  // directly (ADR-3) — unlike `createRenamePlan`, there is no bare id to poll.
  createImportPlan: (body: { instanceId: string; recordId: number }) =>
    request<ImportPlanRead>('/api/import/plan', { method: 'POST', body: JSON.stringify(body) }),

  importPlan: (id: string, signal?: AbortSignal) =>
    request<ImportPlanRead>(`/api/import/plan/${encodeURIComponent(id)}`, { signal }),

  // One row edit — include/exclude or a mapping override (ADR-4, FR7).
  editImportRow: (
    id: string,
    body: { ordinal: number; included?: boolean; mapping?: ImportMapping },
  ) =>
    request<ImportPlanRead>(`/api/import/plan/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // The series episode picker's source, read on demand when the picker opens —
  // never pre-fetched for every row (NFR2).
  importEpisodeChoices: (id: string, signal?: AbortSignal) =>
    request<{ episodes: ImportEpisodeChoice[] }>(
      `/api/import/plan/${encodeURIComponent(id)}/episodes`,
      { signal },
    ).then((r) => r.episodes),

  /**
   * The only call that can import a file (ADR-5, ADR-6, ADR-7). Same
   * discipline as `applyRenamePlan`: `typedCount` is the entire body, and
   * there is no `signal` — a command that may already be running on the
   * instance must not be abandoned mid-flight by a navigation away.
   *
   * A 409 refusal arrives as `ApiError` with the whole `ImportRefusal` object
   * on `.detail.refusal`, not just `.reason` — the caller needs `changes`, not
   * only `kind`, to say what drifted.
   */
  applyImportPlan: (id: string, typedCount: number) =>
    request<{ planId: string; rowCount: number }>(
      `/api/import/plan/${encodeURIComponent(id)}/apply`,
      { method: 'POST', body: JSON.stringify({ typedCount }) },
    ),

  /* ── Decision explainer (ADR-10, ADR-11, ADR-12, ADR-13; T9, T14) ──────── */

  // Never called on render — reached only when the explainer is opened on one
  // candidate (NFR2). Always 200: a degraded read still carries the
  // candidate's verbatim rejections in `error.rejections` (REQ-DEC-008).
  explainDecision: (body: ExplainInput, signal?: AbortSignal) =>
    request<ExplainResult>('/api/decisions/explain', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  // Gaps' "Evaluate releases" (ADR-13). Spends the instance's own indexer
  // quota, so this is reached only from the button whose label says so —
  // never on open, never on a refetch.
  evaluateReleases: (
    body: { instanceId: string; episodeId?: number; movieId?: number },
    signal?: AbortSignal,
  ) =>
    request<EvaluateReleasesResult>('/api/decisions/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  // The queue's `import-rejected` cause, file by file (FR17) — on request only.
  explainImportCandidates: (body: { instanceId: string; downloadId: string }, signal?: AbortSignal) =>
    request<ExplainImportCandidatesResult>('/api/decisions/import-candidates', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  // The explainer's "Refresh" control (ADR-11) — bypasses the 10-minute config
  // cache TTL for one instance.
  refreshDecisionsConfig: (instanceId: string) =>
    request<RefreshDecisionsConfigResult>('/api/decisions/config', {
      method: 'POST',
      body: JSON.stringify({ instanceId }),
    }),

  /* ── Unmapped folders (ADR-9, REQ-GAPS-022..026; T13, T14) ─────────────── */

  // Uncached upstream, so `refresh` only exists for parity with the other
  // reads (`gaps`) — the button lets the operator ask again without a reload.
  unmapped: (options: { refresh?: boolean } = {}, signal?: AbortSignal) =>
    request<UnmappedRead>(`/api/unmapped${options.refresh ? '?refresh=1' : ''}`, { signal }),
};
