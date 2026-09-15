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
