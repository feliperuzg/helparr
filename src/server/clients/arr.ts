import 'server-only';

import type { InstanceKind, ParsedTarget, RemovalRequest, StatusMessage } from '@/lib/types';
import type { Credential } from '@/server/instances/credential';
import { BaseArrClient } from './base';
import { classifyResponse, readJson, requestWithRetry } from './http';
import {
  describeNetworkError,
  type ArrQueueClient,
  type ArrQueueRead,
  type ArrQueueRecord,
  type ClientResult,
  type PushOutcome,
  type ReleaseCandidate,
  type ReleaseClient,
  type ReleaseDescriptor,
} from './types';

export { arrApiBase } from './base';

/**
 * Stateless client for Sonarr and Radarr (REQ-INST-004, REQ-INST-011) — the
 * queue surface plus the three endpoints a manual grab needs.
 *
 * Prowlarr shares the credential and the probe but none of this, so it lives in
 * `./prowlarr` on top of the same `BaseArrClient`.
 */

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

/**
 * `GET /release?seriesId=N` is a live interactive search across every indexer
 * the instance has configured — the upstream's own UI warns it "can take a
 * minute". The default 8s budget would turn every evaluation into a timeout.
 */
const EVALUATE_DEADLINE_MS = 120_000;

export class ArrClient extends BaseArrClient implements ArrQueueClient, ReleaseClient {
  /**
   * One shared deadline for the whole paginated read, combined with the
   * caller's. Per-page timeouts alone would let a queue with twelve pages take
   * twelve times the budget an operator is willing to wait.
   */
  private deadline(external?: AbortSignal): AbortSignal {
    return this.withTimeout(external, QUEUE_DEADLINE_MS);
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

  /* ── Manual grab ───────────────────────────────────────────────────────── */

  /**
   * Ask the instance what it would make of a release *name* (ADR-3).
   *
   * `/release/push` takes a title, not a target — the instance decides what the
   * release is by parsing the name. A confirmation that echoed the operator's
   * click would therefore be naming nothing, and REQ-OPS-007 requires it to
   * name the resolved target.
   *
   * Measured read-only: a GET, no indexer traffic, nothing written.
   */
  async parse(title: string, signal?: AbortSignal): Promise<ClientResult<ParsedTarget>> {
    const context = `${this.kind} parse`;
    const combined = this.withTimeout(signal);

    const response = await requestWithRetry(
      this.url('/parse', { title }),
      this.requestInit(combined),
      combined,
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    return { ok: true, value: toParsedTarget(body.value, this.kind) };
  }

  /**
   * The instance's own interactive search for a target it already tracks, read
   * only for its `rejections` arrays (ADR-5, proposal OQ-4).
   *
   * This is expensive — a live query across every indexer the instance has
   * configured, which the upstream itself warns "can take a minute". It is
   * never called on render, on scroll, or on a timer; only when the operator
   * explicitly asks for one release.
   */
  async evaluate(
    target: { seriesId?: number | null; movieId?: number | null },
    signal?: AbortSignal,
  ): Promise<ClientResult<ReleaseCandidate[]>> {
    const context = `${this.kind} evaluate`;
    const params = this.kind === 'sonarr'
      ? { seriesId: target.seriesId ?? undefined }
      : { movieId: target.movieId ?? undefined };

    if (params.seriesId === undefined && params.movieId === undefined) {
      return {
        ok: false,
        error: {
          kind: 'upstream-error',
          reason: `${context} needs a resolved target — the release did not parse to anything ${this.kind} tracks.`,
        },
      };
    }

    const combined = this.withTimeout(signal, EVALUATE_DEADLINE_MS);
    const response = await requestWithRetry(
      this.url('/release', params),
      this.requestInit(combined),
      combined,
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    if (!Array.isArray(body.value)) {
      return {
        ok: false,
        error: {
          kind: 'upstream-error',
          reason: `${context} did not return a release array.`,
        },
      };
    }

    return { ok: true, value: body.value.map(toReleaseCandidate) };
  }

  /**
   * Hand a release to the instance (ADR-2). The only call in this client that
   * mutates anything upstream.
   *
   * `POST /api/v3/release` is deliberately never called: it resolves
   * `guid` + `indexerId` against the target's *own* indexer cache, and a
   * Prowlarr `indexerId` is valid on both sides while naming a different
   * indexer — measured, 0 of 10 ids refer to the same indexer across the two.
   *
   * No retry. A push is not idempotent from the operator's point of view: if
   * it landed and the response was lost, a retry grabs the release twice.
   */
  async pushRelease(
    release: ReleaseDescriptor,
    signal?: AbortSignal,
  ): Promise<ClientResult<PushOutcome>> {
    const context = `${this.kind} grab`;
    const combined = this.withTimeout(signal);

    let response: Response;
    try {
      response = await fetch(this.url('/release/push'), {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: release.title,
          downloadUrl: release.downloadUrl,
          protocol: release.protocol,
          publishDate: release.publishDate,
        }),
        signal: combined,
        cache: 'no-store',
      });
    } catch (error) {
      return { ok: false, error: { kind: 'unreachable', reason: describeNetworkError(error) } };
    }

    if (!response.ok) {
      return { ok: false, error: classifyResponse(response, context) };
    }

    const body = await readJson(response, context);
    if (!body.ok) return body;

    // Sonarr answers with the pushed release; some versions wrap it in an
    // array. Both carry the same `rejected` / `rejections` pair.
    const raw = (Array.isArray(body.value) ? body.value[0] : body.value) as
      { rejected?: unknown; rejections?: unknown } | null;

    const rejections = Array.isArray(raw?.rejections)
      ? raw.rejections.map(rejectionText).filter((entry) => entry.length > 0)
      : [];

    // `rejected` is authoritative. A populated `rejections` array with
    // `rejected: false` happens on informational reasons, and reporting that as
    // a refusal would be the inverse of FR9's mistake.
    const accepted = raw?.rejected !== true;

    return { ok: true, value: { accepted, rejections } };
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

/* ── Grab payload parsing ─────────────────────────────────────────────────── */

/** `quality.quality.name` — the only nesting the *arr APIs agree on. */
function qualityName(info: Record<string, unknown> | null): string | null {
  const quality = info?.quality as { quality?: { name?: unknown } } | undefined;
  return asStringOrNull(quality?.quality?.name);
}

export function toParsedTarget(input: unknown, kind: InstanceKind): ParsedTarget {
  const raw = (input ?? {}) as Record<string, unknown>;

  if (kind === 'radarr') {
    const movie = raw.movie as Record<string, unknown> | null | undefined;
    const info = (raw.parsedMovieInfo ?? null) as Record<string, unknown> | null;
    const movieId = typeof movie?.id === 'number' ? movie.id : null;
    return {
      resolved: movieId !== null,
      seriesId: null,
      movieId,
      label: movie ? movieLabel({ movie }) : null,
      quality: qualityName(info),
      releaseGroup: asStringOrNull(info?.releaseGroup),
    };
  }

  const series = raw.series as Record<string, unknown> | null | undefined;
  const info = (raw.parsedEpisodeInfo ?? null) as Record<string, unknown> | null;
  const seriesId = typeof series?.id === 'number' ? series.id : null;
  return {
    resolved: seriesId !== null,
    seriesId,
    movieId: null,
    label: series ? episodeLabel({ series, episodes: raw.episodes }) : null,
    quality: qualityName(info),
    releaseGroup: asStringOrNull(info?.releaseGroup),
  };
}

/**
 * The *arr APIs are inconsistent about rejection shape: older builds return
 * plain strings, newer ones `{ reason, type }`. Both are rendered verbatim
 * (REQ-SEARCH-006), so the only job here is to find the string.
 */
function rejectionText(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  const source = entry as { reason?: unknown } | null;
  return asString(source?.reason);
}

export function toReleaseCandidate(input: unknown): ReleaseCandidate {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    title: asString(raw.title),
    infoHash: asStringOrNull(raw.infoHash),
    guid: asStringOrNull(raw.guid),
    rejections: Array.isArray(raw.rejections)
      ? raw.rejections.map(rejectionText).filter((entry) => entry.length > 0)
      : [],
  };
}

export function isArrKind(kind: InstanceKind): boolean {
  return kind !== 'download-client';
}

export function assertApiKeyCredential(credential: Credential): asserts credential is Extract<Credential, { type: 'api-key' }> {
  if (credential.type !== 'api-key') throw new Error('expected an api-key credential');
}
