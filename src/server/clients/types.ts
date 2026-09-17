import 'server-only';

import type {
  Gap,
  GapKind,
  HistoryEvent,
  IndexerRead,
  InstanceKind,
  ParsedTarget,
  QueueErrorKind,
  QueueRecord,
  ReleaseRead,
  RemovalRequest,
  RenameTitleKind,
  SeriesDetail,
  SeriesSummary,
  TorrentState,
} from '@/lib/types';
import type { Credential } from '@/server/instances/credential';

/**
 * The shared shape of a per-instance client.
 *
 * Two implementations exist and they are genuinely different animals:
 * `ArrClient` is stateless and authenticates with a header; `QbitClient` holds
 * a session cookie and must re-login when it expires. Forcing them into one
 * class would produce a union of every special case in both, so the shared
 * surface is deliberately narrow — the two operations the registry and the
 * health poller actually need.
 */

/**
 * A probe never throws for an expected upstream condition. Callers fan out with
 * `Promise.allSettled` and need a complete per-instance picture; an exception
 * for "the host is down" would make the common case the error path.
 */
export type ProbeResult =
  | { state: 'ok'; version: string; latencyMs: number }
  | { state: 'unauthorized'; reason: string }
  | { state: 'unreachable'; reason: string }
  | { state: 'degraded'; reason: string };

export interface InstanceClient {
  readonly kind: InstanceKind;
  readonly baseUrl: string;

  /** Liveness plus credential validity plus the upstream version string. */
  probe(signal?: AbortSignal): Promise<ProbeResult>;
}

/* ── Capability interfaces (unified-queue-overview, T5) ───────────────────── */

/**
 * Why capabilities rather than more methods on `InstanceClient`: only *arr
 * instances have a queue, only the download client has torrents, and Prowlarr
 * has neither. Widening the shared interface would force every implementation
 * to carry methods it cannot honour, and the aggregator would have to guess at
 * runtime which ones are real.
 */

/** Everything except `circuit-open`, which no client can report about itself. */
export type ClientFailureKind = Exclude<QueueErrorKind, 'circuit-open'>;

export interface ClientFailure {
  kind: ClientFailureKind;
  reason: string;
}

/**
 * Same contract as `ProbeResult`: an expected upstream condition is a returned
 * value, not an exception, so a fan-out never loses the instances that worked.
 */
export type ClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ClientFailure };

export function clientFailed<T>(result: ClientResult<T>): boolean {
  return !result.ok;
}

/**
 * True for the failures that should count against the circuit breaker.
 *
 * `unauthorized` deliberately does not: the endpoint is up and answering, the
 * credential is simply wrong. Opening the breaker would stop helparr calling an
 * instance the operator is in the middle of fixing, and the rail would say
 * "not contacted" when the honest answer is "your API key was rejected".
 */
export function countsAsBreakerFailure<T>(result: ClientResult<T>): boolean {
  return !result.ok && result.error.kind !== 'unauthorized';
}

/**
 * One queue row as a single *arr reports it, before attribution and enrichment.
 * Derived from `QueueRecord` by omission so the two cannot drift: everything the
 * aggregator adds is exactly what is omitted here.
 */
export type ArrQueueRecord = Omit<
  QueueRecord,
  'id' | 'instanceId' | 'instanceLabel' | 'instanceKind' | 'torrent' | 'stall'
>;

export interface ArrQueueRead {
  records: ArrQueueRecord[];
  /** What the upstream said the total was, for the truncation check. */
  totalRecords: number;
  /**
   * True when the page ceiling stopped the read short of `totalRecords`.
   *
   * Carried rather than logged because a silently truncated queue is precisely
   * the failure FR1 exists to prevent — the aggregator turns this into a visible
   * entry in the errors array.
   */
  truncated: boolean;
}

export interface ArrQueueClient extends InstanceClient {
  /** The complete queue, following the paging envelope to `totalRecords`. */
  queue(signal?: AbortSignal): Promise<ClientResult<ArrQueueRead>>;
  removeFromQueue(
    recordId: number,
    flags: RemovalRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<null>>;
}

export interface TorrentClient extends InstanceClient {
  torrents(signal?: AbortSignal): Promise<ClientResult<TorrentState[]>>;
}

/**
 * Prowlarr is excluded by kind, not by method presence: it is an indexer
 * manager and has no download queue, so calling `/queue` on it would 404 and
 * surface as an upstream error the operator cannot act on.
 */
export function isArrQueueClient(client: InstanceClient): client is ArrQueueClient {
  return (client.kind === 'sonarr' || client.kind === 'radarr')
    && typeof (client as ArrQueueClient).queue === 'function';
}

export function isTorrentClient(client: InstanceClient): client is TorrentClient {
  return typeof (client as TorrentClient).torrents === 'function';
}

/* ── Search and grab capabilities (indexer-search-grab, T3) ───────────────── */

/** One Prowlarr query, already narrowed to the indexers it should hit. */
export interface SearchScope {
  query: string;
  /** Empty means every indexer — expressed by omitting the parameter (ADR-1). */
  indexerIds: number[];
  categories: number[];
}

export interface SearchClient extends InstanceClient {
  indexers(signal?: AbortSignal): Promise<ClientResult<IndexerRead[]>>;
  search(scope: SearchScope, signal?: AbortSignal): Promise<ClientResult<ReleaseRead[]>>;
}

/** What `/release/push` needs. Notably not a `guid` or an `indexerId` (ADR-2). */
export interface ReleaseDescriptor {
  title: string;
  downloadUrl: string;
  protocol: 'torrent' | 'usenet';
  publishDate: string;
}

/**
 * One release as the destination instance's *own* interactive search reports
 * it. `rejections` is the field the whole evaluation exists for; the identity
 * fields are only there to match it back to the release the operator picked.
 */
export interface ReleaseCandidate {
  title: string;
  infoHash: string | null;
  guid: string | null;
  rejections: string[];
}

/**
 * The push response. `accepted: false` is a successful request that produced a
 * negative answer — it is not a transport failure and is never reported as
 * "grab failed" (FR9).
 */
export interface PushOutcome {
  accepted: boolean;
  rejections: string[];
}

export interface ReleaseClient extends InstanceClient {
  parse(title: string, signal?: AbortSignal): Promise<ClientResult<ParsedTarget>>;
  evaluate(
    target: { seriesId?: number | null; movieId?: number | null },
    signal?: AbortSignal,
  ): Promise<ClientResult<ReleaseCandidate[]>>;
  pushRelease(
    release: ReleaseDescriptor,
    signal?: AbortSignal,
  ): Promise<ClientResult<PushOutcome>>;
}

/**
 * Narrowed by kind for the same reason `isArrQueueClient` is: Prowlarr is the
 * only instance that can search, and Sonarr/Radarr are the only ones that can
 * be grabbed into. Method-presence checks would let a misconfigured kind
 * through to an endpoint that 404s.
 */
export function isSearchClient(client: InstanceClient): client is SearchClient {
  return client.kind === 'prowlarr' && typeof (client as SearchClient).search === 'function';
}

export function isReleaseClient(client: InstanceClient): client is ReleaseClient {
  return (client.kind === 'sonarr' || client.kind === 'radarr')
    && typeof (client as ReleaseClient).pushRelease === 'function';
}

/* ── Library-gap capabilities (library-gaps-attach, T1) ───────────────────── */

/**
 * One `wanted/missing` record as a single *arr reports it, normalized across the
 * two APIs that disagree about nearly every field name.
 *
 * Derived by omission from `Gap` in the same spirit as `ArrQueueRecord`:
 * everything the aggregator adds — the composite id, the instance attribution,
 * the joined series title and path, the inference — is exactly what is missing
 * here. `groupTitle` and `targetPath` are absent because on Sonarr they come
 * from the cached `/series` join, not from the record (the spike measured
 * `series keys (0)` on every missing episode).
 *
 * `wantedQuality` is omitted too and replaced by the raw `qualityProfileId`:
 * neither API returns a profile *name* on a missing record, and on Sonarr the
 * profile is a property of the series, not of the episode. Resolving the name
 * needs the join, so it happens where the join lives.
 */
export type ArrGapRecord = Omit<
  Gap,
  | 'id'
  | 'instanceId'
  | 'instanceLabel'
  | 'instanceKind'
  | 'groupTitle'
  | 'targetPath'
  | 'wantedQuality'
  | 'inferred'
> & {
  /** Radarr carries its own path inline; Sonarr does not (null there). */
  path: string | null;
  /** Resolved to a name against `qualityProfiles()`; null when absent. */
  qualityProfileId: number | null;
  /**
   * The three fields below exist only so the released-only guard can run where
   * the plan puts it — in the aggregator, not in the client. `wanted/missing`
   * is *supposed* to be monitored-and-fileless already; carrying the evidence
   * makes that belt-and-braces check possible instead of assumed.
   */
  monitored: boolean;
  hasFile: boolean;
  /** Radarr's own `status` — `announced` / `inCinemas` / `released`. Null on Sonarr. */
  releaseStatus: string | null;
};

export interface ArrGapRead {
  records: ArrGapRecord[];
  totalRecords: number;
  /** Same contract as `ArrQueueRead.truncated` — a short list is never silent. */
  truncated: boolean;
}

/** `{ id, name }` off `/qualityprofile` — the only two fields the grid shows. */
export interface QualityProfileSummary { id: number; name: string; }

/** What a bulk automatic search takes: one command per instance, ids batched. */
export interface SearchCommandRequest {
  kind: GapKind;
  /** `episodeIds` on Sonarr, `movieIds` on Radarr. Never one command per id. */
  ids: number[];
}

export interface GapClient extends InstanceClient {
  /** Everything monitored, missing and — on Radarr — actually released. */
  wantedMissing(signal?: AbortSignal): Promise<ClientResult<ArrGapRead>>;
  /**
   * The Sonarr join source. Radarr implements it as an empty read: its missing
   * records are self-contained, so there is nothing to join and no cache entry.
   */
  series(signal?: AbortSignal): Promise<ClientResult<SeriesSummary[]>>;
  /**
   * One series, with the per-season counts `series()` deliberately discards.
   * Read on demand by the season-attach confirmation and by nothing else — it
   * is never cached and never issued per row (NFR2, ADR-4). Radarr implements
   * it as a refusal: a film has no season.
   */
  seriesDetail(id: number, signal?: AbortSignal): Promise<ClientResult<SeriesDetail>>;
  /** Cached beside `series()`: the id→name map the `Wanted` column needs. */
  qualityProfiles(signal?: AbortSignal): Promise<ClientResult<QualityProfileSummary[]>>;
  /** One item's history, read on demand from the inspector — never per row. */
  historyFor(
    target: { kind: GapKind; upstreamId: number },
    signal?: AbortSignal,
  ): Promise<ClientResult<HistoryEvent[]>>;
  /** Queues the instance's own indexer search. A request, never a result. */
  searchCommand(
    request: SearchCommandRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<null>>;
}

/**
 * Narrowed by kind for the same reason `isArrQueueClient` is: only Sonarr and
 * Radarr have a notion of "monitored but missing". Prowlarr and the download
 * client would 404 on every one of these paths.
 */
export function isGapClient(client: InstanceClient): client is GapClient {
  return (client.kind === 'sonarr' || client.kind === 'radarr')
    && typeof (client as GapClient).wantedMissing === 'function';
}

/* ── Rename capability (bulk-rename-preview, T1) ──────────────────────────── */

/**
 * One row of `GET /api/v3/rename`, normalized across two shapes that agree on
 * almost nothing.
 *
 * Measured against Sonarr 4.0.19 and Radarr 6.3.0 (research.md): Sonarr returns
 * `episodeFileId`, `episodeNumbers`, `existingPath`, `newPath`, `seasonNumber`,
 * `seriesId`; Radarr returns `movieFileId`, `existingPath`, `newPath`,
 * `movieId`. Neither returns anything warning-shaped, which is why `warnings`
 * is absent here and derived downstream instead (ADR-9).
 */
export interface ArrRenameRow {
  /** `episodeFileId` on Sonarr, `movieFileId` on Radarr. */
  fileId: number;
  existingPath: string;
  proposedPath: string;
  /**
   * How many episodes this one file covers. Sonarr only — Radarr has no
   * analogue, and null means "not applicable" rather than "one".
   */
  episodeCount: number | null;
}

/**
 * `RenameFiles` (ADR-6), never `RenameSeries`/`RenameMovie`.
 *
 * The title id travels with the file ids because both APIs require it: the
 * command is scoped to one title and carries the subset of its files to touch.
 * That subset is the whole point — it is the only shape that can express an
 * exclusion, so it is the only shape that can tell the truth about the plan the
 * operator approved.
 */
export interface RenameCommandRequest {
  kind: RenameTitleKind;
  titleId: number;
  fileIds: number[];
}

/**
 * A command's state as the instance reports it.
 *
 * The *arr command endpoint is asynchronous — a POST returns an id, not an
 * outcome. Nothing may be presented to the operator as renamed on the strength
 * of this alone (REQ-OPS-006): completion means the instance stopped working,
 * not that any particular file moved. The per-file truth comes from the
 * preview re-run in ADR-7.
 */
export interface ArrCommandStatus {
  id: number;
  state: 'queued' | 'started' | 'completed' | 'failed' | 'unknown';
  /** Verbatim upstream failure text, when the command itself failed. */
  message: string | null;
}

/**
 * One selectable title, reduced to what the scope picker needs (FR1).
 *
 * Deliberately not `SeriesSummary`: that shape is Sonarr-only and carries a
 * monitored flag and a quality profile the picker has no use for, while a film
 * has neither. Three fields cover both backends and nothing here is joined
 * against anything, so a thousand-title library stays a small response.
 */
export interface ArrRenameTitle {
  upstreamId: number;
  label: string;
  /** Files the instance holds for this title. Never null — a title it cannot count is not offered. */
  fileCount: number;
}

export interface RenameClient extends InstanceClient {
  /**
   * Every title on this instance that has at least one file (FR1).
   *
   * The file floor is the whole filter: a rename moves a file, so a title with
   * none has nothing to preview, and offering it would make the picker's most
   * common outcome "no changes" for a reason the operator could have been told
   * up front. It is also what keeps the list short — a library is mostly
   * monitored-but-absent on any instance that is still filling in.
   */
  listTitles(signal?: AbortSignal): Promise<ClientResult<ArrRenameTitle[]>>;

  /**
   * Rescan one title and return the command id to wait on.
   *
   * ADR-2 puts this before every preview: the target filename is derived from
   * mediainfo, so previewing a stale library bakes stale encoding details into
   * names the operator then approves.
   */
  rescanTitle(
    target: { kind: RenameTitleKind; upstreamId: number },
    signal?: AbortSignal,
  ): Promise<ClientResult<number>>;

  commandStatus(commandId: number, signal?: AbortSignal): Promise<ClientResult<ArrCommandStatus>>;

  /**
   * The preview. An empty result is a real answer — "nothing pending" — and is
   * never conflated with a failed read (FR5, REQ-RENAME-006).
   */
  renamePreview(
    target: { kind: RenameTitleKind; upstreamId: number },
    signal?: AbortSignal,
  ): Promise<ClientResult<ArrRenameRow[]>>;

  /**
   * Which of `relativeDirs`' contents already exist on disk, as relative paths
   * in the same frame `ArrRenameRow` reports them.
   *
   * Needed because the preview does not check whether its own destination is
   * free. Measured on 2026-09-17: Sonarr proposed moving a file onto a path
   * that already held another file, accepted the `RenameFiles` command,
   * reported it `completed` / `successful` — and renamed nothing, logging
   * `DestinationAlreadyExistsException` where only its own operator would see
   * it.
   *
   * The occupant is invisible to every other endpoint here. It has no rename
   * pending, so it is not in the preview; and in the observed case it was not
   * even an imported file, so it was not in `/episodefile` either. The
   * instance's own filesystem endpoint is the only thing that can see it.
   * helparr still never touches a disk — it asks the instance, which owns the
   * mount.
   */
  listExistingPaths(
    target: { kind: RenameTitleKind; upstreamId: number },
    relativeDirs: string[],
    signal?: AbortSignal,
  ): Promise<ClientResult<string[]>>;

  /** Issues `RenameFiles`, returning the command id. Never retried. */
  renameFiles(
    request: RenameCommandRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<number>>;
}

/**
 * Narrowed by kind for the same reason `isGapClient` is: only Sonarr and Radarr
 * own files on disk. Prowlarr and the download client would 404 on every path.
 */
export function isRenameClient(client: InstanceClient): client is RenameClient {
  return (client.kind === 'sonarr' || client.kind === 'radarr')
    && typeof (client as RenameClient).renamePreview === 'function';
}

export interface ClientConfig {
  kind: InstanceKind;
  baseUrl: string;
  credential: Credential;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Normalizes an operator-entered base URL. Trailing slashes are stripped so
 * path joining never produces a double slash, which some reverse proxies treat
 * as a distinct (and 404-ing) path.
 */
export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connection refused — the host is reachable but nothing is listening on that port.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host not found — DNS could not resolve the base URL.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable — check the address and the network route.';
    case 'ECONNRESET':
      return 'Connection reset by the upstream before a response was returned.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'TLS certificate rejected — use http:// on the LAN or install the certificate.';
    default:
      break;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Timed out waiting for a response.';
  }
  return error instanceof Error ? error.message : 'Unknown network error.';
}

/**
 * Splits a thrown fetch error into the kind the banner needs.
 *
 * `timeout` is separated from `unreachable` because they point the operator at
 * different things: a refused connection means the service is not running, a
 * timeout means it is running and too slow — often a NAS spinning up disks.
 */
export function classifyNetworkError(error: unknown): ClientFailure {
  const isAbort = error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError');
  return {
    kind: isAbort ? 'timeout' : 'unreachable',
    reason: describeNetworkError(error),
  };
}
