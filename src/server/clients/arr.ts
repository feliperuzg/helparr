import 'server-only';

import type { InstanceKind, RemovalRequest, StatusMessage } from '@/lib/types';
import type { Credential } from '@/server/instances/credential';
import { classifyResponse, readJson, requestWithRetry } from './http';
import {
  DEFAULT_TIMEOUT_MS,
  describeNetworkError,
  normalizeBaseUrl,
  type ArrQueueClient,
  type ArrQueueRead,
  type ArrQueueRecord,
  type ClientConfig,
  type ClientResult,
  type InstanceClient,
  type ProbeResult,
} from './types';

/**
 * Stateless client for Sonarr, Radarr and Prowlarr (REQ-INST-004, REQ-INST-011).
 *
 * All three take the same `X-Api-Key` header, but not the same API version:
 * Sonarr and Radarr are on `/api/v3`, Prowlarr on `/api/v1`. Assuming v3
 * everywhere is the mistake that makes a correctly-configured Prowlarr report
 * "unreachable" — the host answers, the path 404s.
 */

const API_BASE: Record<Exclude<InstanceKind, 'download-client'>, string> = {
  sonarr: '/api/v3',
  radarr: '/api/v3',
  prowlarr: '/api/v1',
};

export function arrApiBase(kind: InstanceKind): string {
  const base = API_BASE[kind as Exclude<InstanceKind, 'download-client'>];
  if (!base) throw new Error(`${kind} is not an *arr instance`);
  return base;
}

/**
 * Forced rather than left to the upstream default (REQ-QUEUE-001). Sonarr's
 * default is 10 — a 40-item queue read without paging silently returns a
 * quarter of it, which is the exact failure the screen exists to prevent.
 */
const QUEUE_PAGE_SIZE = 200;

/**
 * The read is bounded twice, because the paging parameters are not in Sonarr's
 * OpenAPI definition — their behaviour is observed, not contracted. A ceiling
 * stops a misbehaving upstream (one that ignores `page`, say) from looping
 * forever; the deadline stops a slow one from holding the whole fan-out.
 *
 * 25 × 200 = 5000 records. Hitting it is reported, never silently truncated.
 */
const QUEUE_MAX_PAGES = 25;
const QUEUE_DEADLINE_MS = 20_000;

export class ArrClient implements InstanceClient, ArrQueueClient {
  readonly kind: InstanceKind;

  readonly baseUrl: string;

  private readonly apiKey: string;

  private readonly timeoutMs: number;

  constructor(config: ClientConfig) {
    if (config.credential.type !== 'api-key') {
      throw new Error(`${config.kind} requires an api-key credential`);
    }
    this.kind = config.kind;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.credential.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private url(path: string): string {
    return `${this.baseUrl}${arrApiBase(this.kind)}${path}`;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    // `/system/status` is the cheap liveness endpoint and the one that also
    // proves the credential. `/health` is deliberately not used here: it only
    // reads the upstream's own cached task results, so polling it fast buys
    // nothing, and Sonarr's SystemTimeCheck can throw when the host is
    // offline and abort the whole run.
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(this.url('/system/status'), {
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
        },
        signal: combined,
        cache: 'no-store',
      });
    } catch (error) {
      return { state: 'unreachable', reason: describeNetworkError(error) };
    }

    const latencyMs = Date.now() - started;

    if (response.status === 401 || response.status === 403) {
      return {
        state: 'unauthorized',
        reason: 'The API key was rejected. Regenerate it in the upstream app and paste the new value.',
      };
    }

    if (response.status === 404) {
      return {
        state: 'degraded',
        reason: `The host answered but ${arrApiBase(this.kind)}/system/status does not exist. `
          + 'Check the base URL — a URL base or reverse-proxy prefix is a common cause.',
      };
    }

    if (!response.ok) {
      return {
        state: 'degraded',
        reason: `Upstream returned HTTP ${response.status}.`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // An HTML login page served with 200 is the classic signature of a
      // reverse proxy that intercepted the request. Reporting "ok" here would
      // let a broken configuration pass the test-before-save gate.
      return {
        state: 'degraded',
        reason: 'The host answered but the response was not JSON — something is intercepting the request.',
      };
    }

    const version = (body as { version?: unknown } | null)?.version;
    if (typeof version !== 'string') {
      return {
        state: 'degraded',
        reason: 'The response did not carry a version field — this does not look like an *arr API.',
      };
    }

    return { state: 'ok', version, latencyMs };
  }

  /** Every request in this client carries the same auth and JSON headers. */
  private requestInit(signal: AbortSignal, method = 'GET'): RequestInit {
    return {
      method,
      headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
      signal,
    };
  }

  /**
   * One shared deadline for the whole paginated read, combined with the
   * caller's. Per-page timeouts alone would let a queue with twelve pages take
   * twelve times the budget an operator is willing to wait.
   */
  private deadline(external?: AbortSignal): AbortSignal {
    const own = AbortSignal.timeout(QUEUE_DEADLINE_MS);
    return external ? AbortSignal.any([external, own]) : own;
  }

  private queryFor(page: number): string {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(QUEUE_PAGE_SIZE),
    });
    // Without these the records carry bare ids and the table can only show the
    // release name — which is precisely the string the operator cannot map back
    // to a series or a movie when the parse is what went wrong.
    if (this.kind === 'sonarr') {
      params.set('includeUnknownSeriesItems', 'true');
      params.set('includeSeries', 'true');
      params.set('includeEpisode', 'true');
    } else if (this.kind === 'radarr') {
      params.set('includeUnknownMovieItems', 'true');
      params.set('includeMovie', 'true');
    }
    return params.toString();
  }

  private async queuePage(
    page: number,
    signal: AbortSignal,
  ): Promise<ClientResult<{ records: ArrQueueRecord[]; totalRecords: number }>> {
    const context = `${this.kind} queue`;
    const response = await requestWithRetry(
      `${this.url('/queue')}?${this.queryFor(page)}`,
      this.requestInit(signal),
      signal,
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    const envelope = body.value as { records?: unknown; totalRecords?: unknown } | null;
    if (!envelope || !Array.isArray(envelope.records)) {
      return {
        ok: false,
        error: {
          kind: 'upstream-error',
          reason: `${context} returned a body with no records array — this does not look like an *arr queue.`,
        },
      };
    }

    return {
      ok: true,
      value: {
        records: envelope.records.map((raw) => toQueueRecord(raw, this.kind)),
        totalRecords: typeof envelope.totalRecords === 'number'
          ? envelope.totalRecords
          : envelope.records.length,
      },
    };
  }

  async queue(signal?: AbortSignal): Promise<ClientResult<ArrQueueRead>> {
    const deadline = this.deadline(signal);
    const seen = new Map<number, ArrQueueRecord>();
    let totalRecords = 0;
    let page = 1;
    let truncated = false;

    for (;;) {
      const result = await this.queuePage(page, deadline);
      // A partial read is not reported as a partial success: half a queue looks
      // exactly like a queue where things have already been removed.
      if (!result.ok) return result;

      totalRecords = result.value.totalRecords;

      // Keyed by id rather than concatenated, because the queue mutates while we
      // page through it. A record that shifts across the page boundary would
      // otherwise appear twice, and the operator would try to remove a row that
      // is already gone.
      for (const record of result.value.records) seen.set(record.recordId, record);

      if (result.value.records.length === 0) break;
      if (seen.size >= totalRecords) break;

      if (page >= QUEUE_MAX_PAGES) {
        truncated = true;
        break;
      }
      page += 1;
    }

    return {
      ok: true,
      value: { records: [...seen.values()], totalRecords, truncated },
    };
  }

  /**
   * The three flags are passed through exactly as the operator set them — no
   * defaults are applied here (ADR-4). `skipRedownload` is not cosmetic: without
   * it the *arr immediately searches for a replacement, which is a side effect
   * the operator never asked for and cannot see happening.
   */
  async removeFromQueue(
    recordId: number,
    flags: RemovalRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<null>> {
    const context = `${this.kind} queue removal`;
    const params = new URLSearchParams({
      removeFromClient: String(flags.removeFromClient),
      blocklist: String(flags.blocklist),
      skipRedownload: String(flags.skipRedownload),
    });

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // No retry. A removal is not idempotent from the operator's point of view —
    // a retried delete that "fails" after the first one succeeded reports a
    // failure for an item that is gone, which is the one lie this screen must
    // not tell.
    let response: Response;
    try {
      response = await fetch(
        `${this.url(`/queue/${recordId}`)}?${params.toString()}`,
        { ...this.requestInit(combined, 'DELETE'), cache: 'no-store' },
      );
    } catch (error) {
      return { ok: false, error: { kind: 'unreachable', reason: describeNetworkError(error) } };
    }

    if (!response.ok) {
      return { ok: false, error: classifyResponse(response, context) };
    }
    await response.body?.cancel().catch(() => {});
    return { ok: true, value: null };
  }
}

/* ── Queue record parsing ─────────────────────────────────────────────────── */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseStatusMessages(raw: unknown): StatusMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const source = entry as { title?: unknown; messages?: unknown } | null;
      return {
        title: asString(source?.title),
        messages: Array.isArray(source?.messages)
          ? source.messages.filter((m): m is string => typeof m === 'string')
          : [],
      };
    })
    .filter((message) => message.title !== '' || message.messages.length > 0);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function episodeLabel(raw: Record<string, unknown>): string | null {
  const series = raw.series as { title?: unknown } | undefined;
  const title = asStringOrNull(series?.title);
  if (!title) return null;

  // Sonarr v3 attaches a single `episode`; v4 attaches `episodes`. Reading both
  // is cheaper than version-sniffing, and a multi-episode file is a real case.
  const episodes = Array.isArray(raw.episodes)
    ? raw.episodes
    : (raw.episode ? [raw.episode] : []);

  const codes = episodes
    .map((entry) => {
      const episode = entry as { seasonNumber?: unknown; episodeNumber?: unknown } | null;
      const season = asNumber(episode?.seasonNumber, -1);
      const number = asNumber(episode?.episodeNumber, -1);
      return season >= 0 && number >= 0 ? `S${pad(season)}E${pad(number)}` : null;
    })
    .filter((code): code is string => code !== null);

  return codes.length > 0 ? `${title} — ${codes.join(', ')}` : title;
}

function movieLabel(raw: Record<string, unknown>): string | null {
  const movie = raw.movie as { title?: unknown; year?: unknown } | undefined;
  const title = asStringOrNull(movie?.title);
  if (!title) return null;
  const year = asNumber(movie?.year, 0);
  return year > 0 ? `${title} (${year})` : title;
}

export function toQueueRecord(input: unknown, kind: InstanceKind): ArrQueueRecord {
  const raw = (input ?? {}) as Record<string, unknown>;
  const title = asString(raw.title, 'Untitled release');

  // Falls back to the release name rather than to "Unknown": an unmatched
  // record is exactly the case where the operator most needs to see the raw
  // string the parser choked on.
  const targetLabel = (kind === 'sonarr' ? episodeLabel(raw) : movieLabel(raw)) ?? title;

  return {
    recordId: asNumber(raw.id, -1),
    title,
    targetLabel,
    size: asNumber(raw.size),
    sizeleft: asNumber(raw.sizeleft),
    protocol: asString(raw.protocol, 'unknown'),
    indexer: asStringOrNull(raw.indexer),
    status: asString(raw.status, 'unknown'),
    trackedDownloadStatus: asString(raw.trackedDownloadStatus, 'unknown'),
    trackedDownloadState: asString(raw.trackedDownloadState, 'unknown'),
    statusMessages: parseStatusMessages(raw.statusMessages),
    errorMessage: asStringOrNull(raw.errorMessage),
    downloadId: asStringOrNull(raw.downloadId),
    estimatedCompletionTime: asStringOrNull(raw.estimatedCompletionTime),
  };
}

export function isArrKind(kind: InstanceKind): boolean {
  return kind !== 'download-client';
}

export function assertApiKeyCredential(credential: Credential): asserts credential is Extract<Credential, { type: 'api-key' }> {
  if (credential.type !== 'api-key') throw new Error('expected an api-key credential');
}
