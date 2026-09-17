/**
 * Types shared between server and client.
 *
 * This module is imported by client components, so it must never describe a
 * credential. `InstanceDto` has no credential field at all — not an optional
 * one, not a nullable one. A field that does not exist cannot be accidentally
 * populated by a careless `SELECT *` (REQ-INST-005 / AC6).
 */

export const INSTANCE_KINDS = ['sonarr', 'radarr', 'prowlarr', 'download-client'] as const;
export type InstanceKind = (typeof INSTANCE_KINDS)[number];

/** States from `design/state-instance-health.md`. */
export const HEALTH_STATES = [
  'untested',
  'ok',
  'degraded',
  'unreachable',
  'unauthorized',
  'disabled',
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface InstanceDto {
  id: string;
  kind: InstanceKind;
  label: string;
  baseUrl: string;
  enabled: boolean;
  /** How the credential is supplied — never the credential itself. */
  credentialType: 'api-key' | 'userpass';
  /** Non-reversible display form, e.g. `••••••••3f2a`. */
  credentialHint: string;
  status: HealthState;
  version: string | null;
  lastCheckedAt: string | null;
}

export interface InstanceHealthDto {
  instanceId: string;
  kind: InstanceKind;
  label: string;
  state: HealthState;
  latencyMs: number | null;
  version: string | null;
  /** Operator-facing explanation; present whenever state is not `ok`. */
  reason: string | null;
  /** When the breaker is open, the wall-clock time the next probe is allowed. */
  retryAt: string | null;
  observedAt: string;
}

export interface HealthResponse {
  instances: InstanceHealthDto[];
  /** Count of enabled instances not in `ok` — drives the shell badge. */
  degradedCount: number;
}

/**
 * The four outcomes of a connection test (REQ-INST-003). They are discriminated
 * rather than collapsed into ok/failed because the operator's next action
 * differs for each: fix the URL, paste a new key, start the service, or check
 * the reverse proxy.
 */
export type TestOutcome =
  | { outcome: 'ok'; version: string; latencyMs: number; testToken: string }
  | { outcome: 'unauthorized'; reason: string }
  | { outcome: 'unreachable'; reason: string }
  | { outcome: 'unexpected-response'; reason: string };

export const CREDENTIAL_TYPE_BY_KIND: Record<InstanceKind, 'api-key' | 'userpass'> = {
  sonarr: 'api-key',
  radarr: 'api-key',
  prowlarr: 'api-key',
  'download-client': 'userpass',
};

export const KIND_LABEL: Record<InstanceKind, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  prowlarr: 'Prowlarr',
  'download-client': 'qBittorrent',
};

/* ── Queue (unified-queue-overview) ───────────────────────────────────────── */

/**
 * Nothing below is persisted. The queue is read live on every refresh; these are
 * wire shapes only. See `design/data-model.md`.
 */

/** One entry of the *arr `statusMessages` array — a title with detail lines. */
export interface StatusMessage {
  title: string;
  messages: string[];
}

/**
 * What the download client reports about a torrent.
 *
 * Nullable on a record, and that is normal: a record with no `downloadId`, or
 * one whose hash the client does not report, renders un-enriched. Un-enriched is
 * correct; mis-enriched is not (ADR-3).
 */
export interface TorrentState {
  hash: string;
  /** 0–1. */
  progress: number;
  numSeeds: number;
  numLeechs: number;
  /** Bytes per second. */
  dlspeed: number;
  /** Seconds. qBittorrent reports 8640000 for "unknown". */
  eta: number;
  state: string;
  fetchingMetadata: boolean;
}

/**
 * Derived from download-client evidence alone — deliberately not from
 * `trackedDownloadStatus`. The premise of the screen is that a torrent stuck
 * fetching metadata reports `ok` upstream (REQ-QUEUE-005), so consulting the
 * *arr verdict here would reproduce the bug.
 */
export interface StallVerdict {
  stalled: boolean;
  /** Operator-facing evidence, e.g. `0 peers, no progress`. Empty when not stalled. */
  evidence: string;
}

export interface QueueRecord {
  /** `${instanceId}:${recordId}` — unique across instances, stable across
   *  refreshes, and therefore what selection is keyed by. */
  id: string;
  /** The upstream record id. Numeric because that is what removal addresses. */
  recordId: number;
  instanceId: string;
  instanceLabel: string;
  instanceKind: InstanceKind;
  /** The release name, as the indexer published it. */
  title: string;
  /** What the operator recognises: `Series — S01E02` or `Movie (2024)`. */
  targetLabel: string;
  /** Bytes. */
  size: number;
  /** Bytes remaining. */
  sizeleft: number;
  protocol: string;
  indexer: string | null;
  /** The four raw upstream channels the inspector shows verbatim (REQ-QUEUE-004). */
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  statusMessages: StatusMessage[];
  errorMessage: string | null;
  /** The infohash, as the *arr reports it. Null when the record has no download. */
  downloadId: string | null;
  estimatedCompletionTime: string | null;
  torrent: TorrentState | null;
  stall: StallVerdict;
}

/**
 * A closed union so the banner can choose copy per case rather than echoing a
 * raw string. `circuit-open` is what turns "could not be read" into "is not
 * being contacted", and it is the only kind carrying a meaningful `retryAt`.
 */
export const QUEUE_ERROR_KINDS = [
  'unreachable',
  'unauthorized',
  'upstream-error',
  'timeout',
  'circuit-open',
] as const;
export type QueueErrorKind = (typeof QUEUE_ERROR_KINDS)[number];

export interface InstanceReadError {
  instanceId: string;
  instanceLabel: string;
  instanceKind: InstanceKind;
  kind: QueueErrorKind;
  reason: string;
  retryAt: string | null;
}

export interface QueueResponse {
  records: QueueRecord[];
  /** Populated whenever an instance could not be read. The response is still
   *  HTTP 200 — partial results are a success (ADR-8). */
  errors: InstanceReadError[];
  /** Per-instance ISO timestamp of the last *successful* read, so the rail can
   *  say how stale each instance's rows are rather than implying one freshness
   *  for the whole table. */
  lastReadAt: Record<string, string>;
  observedAt: string;
}

export interface RemovalTarget {
  instanceId: string;
  recordId: number;
  /** Carried so the outcome toast can name the item without a second lookup. */
  title: string;
}

/**
 * All three flags are **required**, never optional with server-side defaults
 * (ADR-4). An omitted flag is a client bug; defaulting a destructive action
 * server-side would make it depend on a default the operator never saw.
 *
 * These are the three side effects the *arr queue DELETE endpoint actually
 * exposes. The proposal said `deleteFiles`; no such parameter exists — file
 * deletion is what `removeFromClient` does, so a separate checkbox would have
 * been a control that did nothing. `skipRedownload` takes its place because it
 * guards a real and otherwise-invisible side effect: removing a queue item
 * triggers an automatic new search unless it is set.
 */
export interface RemovalRequest {
  /** Deletes the payload from the download client, not just the queue row. */
  removeFromClient: boolean;
  /** Prevents this release being grabbed again. */
  blocklist: boolean;
  /** Suppresses the automatic re-search that removal otherwise triggers. */
  skipRedownload: boolean;
}

export interface RemovalOutcome {
  instanceId: string;
  recordId: number;
  status: 'removed' | 'failed';
  /** Present only on `failed`. */
  reason: string | null;
}

/* ── Indexer search and manual grab (indexer-search-grab) ─────────────────── */

export interface IndexerRead {
  id: number;
  name: string;
  protocol: 'torrent' | 'usenet';
  enabled: boolean;
  /**
   * False when Prowlarr has backed off from the indexer after consecutive
   * failures. Drives the degraded chip state — a chip that looks selectable but
   * silently returns nothing is worse than one that says why.
   */
  healthy: boolean;
}

export interface SearchCriteria {
  query: string;
  /** Empty means all indexers (ADR-1). */
  indexerIds: number[];
  categories: number[];
  /** Applied client-side, after the merge — it filters nothing upstream. */
  minSeeders: number;
}

export interface ReleaseRead {
  guid: string;
  title: string;
  indexerId: number;
  indexer: string;
  protocol: 'torrent' | 'usenet';
  size: number;
  /** Null rather than zero — a usenet release has no seeders at all. */
  seeders: number | null;
  leechers: number | null;
  ageHours: number;
  publishDate: string;
  infoHash: string | null;
  /** Derived from Prowlarr's `indexerFlags`; there is no `freeleech` field. */
  freeleech: boolean;
  /**
   * The one field that carries a credential. Prowlarr proxies downloads through
   * itself, so this embeds Prowlarr's own API key — the credential to the whole
   * application, not a tracker passkey. It is registered as a secret on receipt
   * and hashed before it reaches the operation log (NFR2, ADR-7).
   *
   * Empty when the result carried no usable link; the grab path refuses it
   * explicitly rather than the row being silently dropped from the results.
   */
  downloadUrl: string;
}

export interface IndexerError {
  indexerId: number;
  indexer: string;
  reason: string;
}

/**
 * helparr's own ceiling on a merged result set (ADR-8, NFR6).
 *
 * Shared rather than server-private because the truncation notice has to state
 * the real number. A UI that says "the first 500" while the server cut at 300
 * is a disclosure that is itself wrong, which is worse than none.
 */
export const SEARCH_RESULT_CAP = 300;

export interface SearchRead {
  results: ReleaseRead[];
  /** Partial failure travels in the body, not the status code (ADR-9). */
  errors: IndexerError[];
  indexersQueried: number;
  indexersAnswered: number;
  /** True when helparr's own ceiling cut the merged set (ADR-8, NFR6). */
  truncated: boolean;
}

/** Prowlarr itself is unreachable — reported as a 200 describing the outage. */
export interface SearchAvailability {
  available: boolean;
  instanceId: string | null;
  instanceLabel: string | null;
  baseUrl: string | null;
  reason: string | null;
  lastSeen: string | null;
  indexers: IndexerRead[];
}

/**
 * What `POST /api/search` returns — always HTTP 200 (ADR-9).
 *
 * `available` is the discriminant because the two bodies answer different
 * questions: one carries results (possibly partial, with `errors` naming the
 * indexers that went quiet), the other says Prowlarr itself could not be asked.
 * A 5xx for the second would collapse it into the transport errors the client
 * retries blindly, and the operator would never read the reason.
 */
export type SearchResponse =
  | ({ available: true } & SearchRead)
  | ({ available: false } & SearchAvailability);

/**
 * What the destination instance made of a release *name* (ADR-3).
 *
 * The four season fields are Sonarr's own reading of the name, carried through
 * verbatim: helparr never restates the episode set it would import. On Radarr
 * they are inert — a film has no season — and the season-scoped attach is
 * refused there before a parse is ever asked for.
 */
export interface ParsedTarget {
  resolved: boolean;
  seriesId: number | null;
  movieId: number | null;
  label: string | null;
  quality: string | null;
  releaseGroup: string | null;
  /** The season the instance read out of the name; null when it read none. */
  seasonNumber: number | null;
  /** The instance's own `fullSeason` flag — a season pack, by its reading. */
  fullSeason: boolean;
  /**
   * The name spans more than one season. Only the first is ever resolved, and
   * the same torrent cannot be pushed twice, so this is disclosed and never
   * acted on (FR6).
   */
  isMultiSeason: boolean;
  /** How many episodes the instance resolved. Never helparr's own count. */
  episodeCount: number;
}

export interface EvaluatedRelease {
  /**
   * False when the instance's own search never returned this release. That is
   * an answer, not an error — and often the one the operator came for.
   */
  matched: boolean;
  rejections: string[];
}

export interface GrabOutcome {
  status: 'succeeded' | 'failed';
  /** True when the instance declined cleanly, as opposed to the call breaking. */
  rejected: boolean;
  rejections: string[];
  detail: string | null;
  operationId: string;
  /** What the confirmation named, carried through to the toast. */
  entityRef: string | null;
}

export const OPERATION_OUTCOMES = ['succeeded', 'failed'] as const;
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

/** The viewer's buckets. `rejected` is a split of `failed`, not a third outcome. */
export const OPERATION_FILTERS = ['all', 'succeeded', 'rejected', 'failed'] as const;
export type OperationFilter = (typeof OPERATION_FILTERS)[number];

export interface OperationRead {
  id: string;
  at: string;
  kind: string;
  summary: string;
  instanceLabel: string;
  instanceKind: string;
  entityTitle: string;
  entityRef: string | null;
  indexer: string | null;
  /**
   * The download URL, redacted (ADR-7). There is no plaintext-URL column to
   * read — the prefix exists so two rows for the same release can be
   * recognised as such. It is not a link.
   */
  urlSha256: string | null;
  urlHost: string | null;
  outcome: OperationOutcome;
  rejected: boolean;
  /** Rejection reasons verbatim, or the single transport error. */
  detail: string[];
}

export interface OperationsRead {
  operations: OperationRead[];
  counts: Record<OperationFilter, number>;
  oldestAt: string | null;
}

/* ── Library gaps and manual attach (library-gaps-attach) ─────────────────── */

export const GAP_KINDS = ['episode', 'movie'] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/**
 * helparr's own reading of why something is missing, never the upstream's.
 *
 * Neither Sonarr's nor Radarr's payload answers "why", so the text is composed
 * from the evidence available and carries its provenance with it (ADR-6). The
 * tag travels with the data rather than living in a component, so the client
 * cannot render an inference in the same style as an instance's own words by
 * styling accident.
 */
export interface InferredReason {
  text: string;
  source: 'inferred';
}

export interface Gap {
  /**
   * `${instanceId}:${kind}:${upstreamId}`. Two instances hand out the same
   * `episodeId`, and an `episodeId` and a `movieId` collide across kinds. This
   * is also what selection survives a refetch on, so it depends only on
   * identity — never on position, never on a field that changes as the item's
   * state does (inherited from `queue/aggregate.ts`).
   */
  id: string;
  instanceId: string;
  instanceLabel: string;
  instanceKind: InstanceKind;
  kind: GapKind;
  /** `episodeId` on Sonarr, `movieId` on Radarr — what a search command takes. */
  upstreamId: number;
  /** Sonarr only. The join key into the series cache; null on a movie. */
  seriesId: number | null;
  /**
   * Sonarr only; null on a movie. Kept from upstream rather than re-parsed out
   * of `itemCode`, so the season chooser lists Sonarr's own numbering — season
   * 0 is specials and is a real season, which a regex over `S00E01` would have
   * to be told about.
   */
  seasonNumber: number | null;
  /** The series title, or the literal `Films` for every Radarr gap (FR5). */
  groupTitle: string;
  /** `S04E02` on an episode, the release year on a movie. */
  itemCode: string;
  title: string;
  airDate: string | null;
  wantedQuality: string | null;
  targetPath: string | null;
  /**
   * Radarr only — its `wanted/missing` records carry `lastSearchTime` inline.
   * Sonarr reports no search state at all, so this is null there and the column
   * renders an em dash rather than inventing one (ADR-5).
   */
  lastSearchAt: string | null;
  /** Filled by the inspector's on-demand history read, never by the list. */
  inferred: InferredReason | null;
}

/**
 * Deliberately shaped like `QueueResponse` — array, errors, per-instance
 * freshness, observation time — so the degradation banner, the retry affordance
 * and the staleness line are the same components with a different array.
 */
export interface GapsResponse {
  gaps: Gap[];
  /** An unreadable instance is an entry here, never a non-2xx (REQ-GAPS-015). */
  errors: InstanceReadError[];
  lastReadAt: Record<string, string>;
  /** Per-instance age of the cached Sonarr series join (ADR-3). */
  seriesReadAt: Record<string, string>;
  observedAt: string;
}

/** The three fields of `GET /api/v3/series` the gap join actually needs. */
export interface SeriesSummary {
  id: number;
  title: string;
  path: string;
  monitored: boolean;
  /** Sonarr keeps the quality profile on the series, never on the episode. */
  qualityProfileId: number | null;
}

/**
 * One season's counts, as Sonarr reports them in `seasons[].statistics`.
 *
 * Both numbers are upstream's. helparr never derives "already filed" by
 * subtracting its own gap count: an unmonitored episode with no file is not a
 * gap, so that subtraction reports it as filed — wrong in the one direction a
 * pre-write warning cannot afford (ADR-4).
 */
export interface SeasonStatistic {
  seasonNumber: number;
  episodeCount: number;
  episodeFileCount: number;
}

/**
 * `GET /api/v3/series/{id}`, reduced. Read on demand when a season-attach
 * confirmation opens — never cached, because `episodeFileCount` is exactly what
 * changes inside the series cache's ten-minute window (ADR-4).
 */
export interface SeriesDetail {
  id: number;
  title: string;
  path: string;
  seasons: SeasonStatistic[];
}

/** One row of `GET /api/v3/history` for a single item, as returned. */
export interface HistoryEvent {
  at: string;
  /** Upstream's own vocabulary — `grabbed`, `downloadFolderImported`, … */
  eventType: string;
  sourceTitle: string;
}

export interface GapHistoryRead {
  events: HistoryEvent[];
  /** Null when the history is empty — an inference with no evidence is a guess. */
  inferred: InferredReason | null;
}

/** What the *arr resolved for a synthesized title, plus whether it is the gap. */
export interface AttachPreview {
  /** The name helparr will push. The instance maps the download by parsing it. */
  title: string;
  target: ParsedTarget;
  /**
   * False when the instance resolved something other than the selected gap.
   * The dialog names both in that case — it is the branch the pre-flight
   * exists for (REQ-GAPS-017).
   */
  matchesGap: boolean;
  /** Where the instance would file it, from the gap's own record. */
  path: string | null;
}

/**
 * The season-scoped sibling of `AttachPreview` (FR4..FR6).
 *
 * Two independent reads feed it — the parse and the one-series detail — and
 * either can fail without the other. Both counts are therefore nullable, and
 * null means *absent*: the confirmation renders nothing rather than `0`, which
 * would read as "no episode of this season has a file".
 */
export interface SeasonAttachPreview {
  /** The name helparr will push — a season token, no episode token. */
  title: string;
  target: ParsedTarget;
  /** False when the instance resolved another series, or another season. */
  matchesSeason: boolean;
  path: string | null;
  /** The season the operator chose. Named back so the dialog cannot drift. */
  season: number;
  /** `seasons[].statistics.episodeCount` — Sonarr's count, or absent. */
  seasonEpisodeCount: number | null;
  /** `seasons[].statistics.episodeFileCount` — how many already have a file. */
  seasonFileCount: number | null;
}

export interface BulkSearchOutcome {
  instanceId: string;
  instanceLabel: string;
  /** How many gaps this instance's single command carried. */
  count: number;
  status: 'queued' | 'failed';
  reason: string | null;
}

/* ── Bulk rename (bulk-rename-preview) ────────────────────────────────────── */

/**
 * Which half of the *arr world a title lives in.
 *
 * Kept separate from `InstanceKind` because the same Sonarr instance answers
 * about `series` while a Radarr answers about `movie`, and the plan rows are
 * read back long after the instance that produced them may have been deleted.
 */
export type RenameTitleKind = 'series' | 'movie';

export const RENAME_PLAN_PHASES = [
  'building',
  'ready',
  'applying',
  'done',
  'expired',
  'refused',
] as const;
export type RenamePlanPhase = (typeof RENAME_PLAN_PHASES)[number];

/** One title the operator selected. The unit FR1 calls a scope entry. */
export interface RenameScopeEntry {
  instanceId: string;
  kind: RenameTitleKind;
  upstreamId: number;
  /** Carried so the progress list can name a title before its preview lands. */
  label: string;
}

/**
 * Why a row deserves a distinct flag (FR6, ADR-9).
 *
 * These are helparr's own derivations, not relayed upstream text — the spike
 * established that neither Sonarr nor Radarr returns any warning field. The
 * wording rendered for each must therefore never attribute the warning to the
 * instance.
 */
export const RENAME_WARNINGS = [
  /** `dirname(proposed) !== dirname(existing)` — a move, not a rename. */
  'moves-directory',
  /** Two rows in one plan resolve to the same destination path. */
  'destination-collision',
  /**
   * A file that is *not* in this plan already occupies the destination.
   *
   * Observed live on 2026-09-17 rather than reasoned about: Sonarr proposed
   * moving a duplicate into a path its correctly-named counterpart already
   * held, accepted the command, reported it `completed`/`successful`, and
   * renamed nothing.
   *
   * The occupant was a file Sonarr had never imported, so it appeared in no
   * library endpoint. Detecting it means asking the instance what is actually
   * on disk — one read per destination directory. See ADR-9.
   */
  'destination-exists',
  /** One file covering more than one episode. Sonarr only. */
  'multi-episode',
] as const;
export type RenameWarning = (typeof RENAME_WARNINGS)[number];

export const RENAME_OUTCOMES = ['pending', 'succeeded', 'failed', 'skipped'] as const;
export type RenameOutcome = (typeof RENAME_OUTCOMES)[number];

/** One file the upstream preview proposed to rename. */
export interface RenamePlanRow {
  id: string;
  instanceId: string | null;
  instanceLabel: string;
  instanceKind: InstanceKind;
  titleKind: RenameTitleKind;
  titleUpstreamId: number;
  titleLabel: string;
  /** `episodeFileId` / `movieFileId` — what `RenameFiles` takes (ADR-6). */
  fileId: number;
  /** Half of the precondition pair (ADR-3), captured at preview time. */
  existingPath: string;
  proposedPath: string;
  warnings: RenameWarning[];
  excluded: boolean;
  outcome: RenameOutcome;
  outcomeDetail: string | null;
}

/**
 * A title that was selected and had nothing pending (FR5).
 *
 * Reported rather than dropped: "no changes" and "we never asked" look
 * identical to an operator, and only one of them is true.
 */
export interface RenameTitleStatus {
  instanceId: string;
  instanceLabel: string;
  kind: RenameTitleKind;
  upstreamId: number;
  label: string;
  state: 'pending' | 'rescanning' | 'previewing' | 'no-changes' | 'has-changes' | 'errored';
  fileCount: number;
  /** Verbatim upstream failure, when this one title could not be read. */
  reason: string | null;
}

export interface RenamePlanDto {
  id: string;
  phase: RenamePlanPhase;
  titles: RenameTitleStatus[];
  rows: RenamePlanRow[];
  /** Every row, excluded or not — what FR4's "total" means. */
  totalFiles: number;
  totalTitles: number;
  /** What the typed-count gate is checked against: non-excluded rows (FR7). */
  affectedFiles: number;
  builtAt: string | null;
  expiresAt: string | null;
  appliedAt: string | null;
  /**
   * Set when a plan was refused — drift or expiry. The UI offers regeneration
   * and nothing else; there is no field here a bypass could travel through.
   */
  refusal: RenameRefusal | null;
}

export interface RenameRefusal {
  kind: 'expired' | 'precondition-drift' | 'empty';
  reason: string;
  /** Paths whose precondition no longer holds, for the refusal detail. */
  drifted: string[];
}

/**
 * One selectable title in the scope picker (FR1).
 *
 * Only titles the instance holds at least one file for appear here — a rename
 * moves a file, so a monitored-but-absent title has nothing to preview, and
 * offering it would make "no changes" the picker's most common outcome for a
 * reason the operator could have been told before selecting.
 */
export interface RenameTitleOption {
  /** `${instanceId}:${kind}:${upstreamId}` — the same composite a plan row is keyed by. */
  id: string;
  instanceId: string;
  instanceLabel: string;
  instanceKind: InstanceKind;
  kind: RenameTitleKind;
  upstreamId: number;
  label: string;
  fileCount: number;
}

/**
 * The picker's read, with per-instance failures attributed rather than folded
 * into an empty list — the same contract `GapsResponse` carries.
 */
export interface RenameTitlesRead {
  titles: RenameTitleOption[];
  errors: InstanceReadError[];
}

/** The final summary FR13 requires — three buckets, counted from outcomes. */
export interface RenameApplySummary {
  succeeded: number;
  failed: number;
  skipped: number;
}
