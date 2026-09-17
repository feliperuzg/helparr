import 'server-only';

import type {
  GapKind,
  HistoryEvent,
  InstanceKind,
  ParsedTarget,
  RemovalRequest,
  RenameTitleKind,
  SeasonStatistic,
  SeriesDetail,
  SeriesSummary,
  StatusMessage,
} from '@/lib/types';
import type { Credential } from '@/server/instances/credential';
import { BaseArrClient } from './base';
import { classifyResponse, readJson, requestWithRetry } from './http';
import {
  describeNetworkError,
  type ArrGapRead,
  type ArrGapRecord,
  type ArrCommandStatus,
  type ArrQueueClient,
  type ArrQueueRead,
  type ArrQueueRecord,
  type ArrRenameRow,
  type ClientResult,
  type GapClient,
  type PushOutcome,
  type QualityProfileSummary,
  type ReleaseCandidate,
  type ReleaseClient,
  type ReleaseDescriptor,
  type RenameClient,
  type RenameCommandRequest,
  type SearchCommandRequest,
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

/**
 * `wanted/missing` is bounded exactly like the queue, and for a sharper reason:
 * a library can legitimately have tens of thousands of missing episodes, and
 * "every gap" is a read the operator triggers by opening a screen.
 *
 * 25 × 200 = 5000 records, and hitting the ceiling is reported (REQ-GAPS-002).
 */
const GAPS_PAGE_SIZE = 200;
const GAPS_MAX_PAGES = 25;
const GAPS_DEADLINE_MS = 30_000;

/**
 * Enough to show why an item is still missing without paging: the inference
 * only ever looks at the most recent grab/import/failure for one item.
 */
const HISTORY_PAGE_SIZE = 20;

export class ArrClient extends BaseArrClient
  implements ArrQueueClient, ReleaseClient, GapClient, RenameClient {
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

  /* ── Library gaps ──────────────────────────────────────────────────────── */

  private async wantedPage(
    page: number,
    signal: AbortSignal,
  ): Promise<ClientResult<{ records: ArrGapRecord[]; totalRecords: number }>> {
    const context = `${this.kind} wanted/missing`;

    const response = await requestWithRetry(
      this.url('/wanted/missing', {
        page,
        pageSize: GAPS_PAGE_SIZE,
        // Always explicit (AC3). Sonarr's undocumented default sort key has
        // changed between releases and a 500 on page 1 reads, from here, as
        // "you have no gaps" — the one answer this screen must never invent.
        sortKey: this.kind === 'sonarr' ? 'airDateUtc' : 'title',
        sortDirection: this.kind === 'sonarr' ? 'descending' : 'ascending',
        monitored: true,
      }),
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
          reason: `${context} returned a body with no records array — this does not look like an *arr wanted list.`,
        },
      };
    }

    return {
      ok: true,
      value: {
        records: envelope.records.map((raw) => toGapRecord(raw, this.kind)),
        totalRecords: typeof envelope.totalRecords === 'number'
          ? envelope.totalRecords
          : envelope.records.length,
      },
    };
  }

  async wantedMissing(signal?: AbortSignal): Promise<ClientResult<ArrGapRead>> {
    const deadline = this.withTimeout(signal, GAPS_DEADLINE_MS);
    // Keyed for the same reason the queue is: a monitored item can gain a file
    // while we page, and a record that shifts across a page boundary would
    // otherwise be listed twice.
    const seen = new Map<number, ArrGapRecord>();
    let totalRecords = 0;
    let page = 1;
    let truncated = false;

    for (;;) {
      const result = await this.wantedPage(page, deadline);
      if (!result.ok) return result;

      totalRecords = result.value.totalRecords;
      for (const record of result.value.records) seen.set(record.upstreamId, record);

      if (result.value.records.length === 0) break;
      if (seen.size >= totalRecords) break;

      if (page >= GAPS_MAX_PAGES) {
        truncated = true;
        break;
      }
      page += 1;
    }

    return { ok: true, value: { records: [...seen.values()], totalRecords, truncated } };
  }

  /**
   * The Sonarr join source (ADR-3). A missing episode carries `seriesId` and
   * nothing else — no series title, no root path — so the grid's group heading
   * and the attach dialog's destination path both come from here.
   *
   * Radarr answers without a request: its missing records are self-contained.
   */
  async series(signal?: AbortSignal): Promise<ClientResult<SeriesSummary[]>> {
    if (this.kind !== 'sonarr') return { ok: true, value: [] };

    const context = 'sonarr series';
    const combined = this.withTimeout(signal, GAPS_DEADLINE_MS);

    const response = await requestWithRetry(
      this.url('/series'),
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
        error: { kind: 'upstream-error', reason: `${context} did not return a series array.` },
      };
    }

    // Reduced to four fields on the way in. The full objects are large — a
    // thousand-series library is megabytes of images, seasons and statistics —
    // and none of it survives past the join.
    return { ok: true, value: body.value.map(toSeriesSummary) };
  }

  /**
   * One series, with the `seasons[].statistics` `series()` throws away.
   *
   * Deliberately not cached and deliberately not folded into the library read:
   * the number it exists to produce — how many episodes of this season already
   * have a file — is precisely what changes inside the cache's ten-minute
   * window, and it is stated in a dialog that is about to write (ADR-4).
   */
  async seriesDetail(id: number, signal?: AbortSignal): Promise<ClientResult<SeriesDetail>> {
    const context = 'sonarr series detail';
    if (this.kind !== 'sonarr') {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: 'Only Sonarr has seasons.' },
      };
    }

    const combined = this.withTimeout(signal);

    const response = await requestWithRetry(
      this.url(`/series/${id}`),
      this.requestInit(combined),
      combined,
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    const raw = body.value as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: `${context} did not return a series.` },
      };
    }

    return { ok: true, value: toSeriesDetail(raw) };
  }

  async qualityProfiles(signal?: AbortSignal): Promise<ClientResult<QualityProfileSummary[]>> {
    const context = `${this.kind} quality profiles`;
    const combined = this.withTimeout(signal);

    const response = await requestWithRetry(
      this.url('/qualityprofile'),
      this.requestInit(combined),
      combined,
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    // An empty list is not an error: the `Wanted` column degrades to an em dash
    // rather than the whole read failing over a cosmetic column.
    if (!Array.isArray(body.value)) return { ok: true, value: [] };

    return {
      ok: true,
      value: body.value
        .map((raw) => {
          const entry = (raw ?? {}) as Record<string, unknown>;
          return { id: asNumber(entry.id, -1), name: asString(entry.name) };
        })
        .filter((profile) => profile.id >= 0 && profile.name.length > 0),
    };
  }

  /**
   * One item's history, read only when the operator opens the inspector.
   *
   * Never called per row: this is one request per *item*, and a grid of 400
   * gaps would otherwise fire 400 requests at an instance that is already the
   * slowest thing in the fan-out.
   */
  async historyFor(
    target: { kind: GapKind; upstreamId: number },
    signal?: AbortSignal,
  ): Promise<ClientResult<HistoryEvent[]>> {
    const context = `${this.kind} history`;
    const combined = this.withTimeout(signal);

    // Sonarr filters the paged collection; Radarr exposes a dedicated
    // per-movie route that answers with a bare array. Both shapes are read.
    const url = this.kind === 'sonarr'
      ? this.url('/history', {
        episodeId: target.upstreamId,
        pageSize: HISTORY_PAGE_SIZE,
        sortKey: 'date',
        sortDirection: 'descending',
      })
      : this.url('/history/movie', { movieId: target.upstreamId });

    const response = await requestWithRetry(url, this.requestInit(combined), combined);
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    const envelope = body.value as { records?: unknown } | null;
    const raw = Array.isArray(body.value)
      ? body.value
      : (Array.isArray(envelope?.records) ? envelope.records : null);

    if (raw === null) {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: `${context} did not return a history array.` },
      };
    }

    return { ok: true, value: raw.map(toHistoryEvent).slice(0, HISTORY_PAGE_SIZE) };
  }

  /**
   * Queues the instance's *own* indexer search — helparr issues no query and
   * sees no releases. The answer is "accepted", never "found" (REQ-GAPS-009).
   *
   * One command carrying every id, not one command per id: the *arr commands
   * are serialised anyway, and fifty separate commands would be fifty separate
   * things for the operator to cancel if they changed their mind.
   *
   * No retry, for the same reason `pushRelease` has none — a queued command
   * that lost its response would be queued twice.
   */
  async searchCommand(
    request: SearchCommandRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<null>> {
    const context = `${this.kind} search command`;
    if (request.ids.length === 0) return { ok: true, value: null };

    const combined = this.withTimeout(signal);
    const payload = request.kind === 'episode'
      ? { name: 'EpisodeSearch', episodeIds: request.ids }
      : { name: 'MoviesSearch', movieIds: request.ids };

    let response: Response;
    try {
      response = await fetch(this.url('/command'), {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: combined,
        cache: 'no-store',
      });
    } catch (error) {
      return { ok: false, error: { kind: 'unreachable', reason: describeNetworkError(error) } };
    }

    if (!response.ok) {
      return { ok: false, error: classifyResponse(response, context) };
    }
    await response.body?.cancel().catch(() => {});
    return { ok: true, value: null };
  }

  /* ── Rename (bulk-rename-preview) ───────────────────────────────────────── */

  /**
   * POSTs one command and returns the id the instance assigned it.
   *
   * Shares `searchCommand`'s no-retry rule for the same reason, sharpened: a
   * `RenameFiles` that lost its response would be issued twice, and the second
   * issue would be against a library the first one already moved. The id comes
   * back in the body here (unlike `searchCommand`, which discards it) because
   * every rename command has to be waited on before its result can be read.
   */
  private async postCommand(
    payload: Record<string, unknown>,
    context: string,
    signal?: AbortSignal,
  ): Promise<ClientResult<number>> {
    const combined = this.withTimeout(signal);

    let response: Response;
    try {
      response = await fetch(this.url('/command'), {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
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

    const id = asNumberOrNull((body.value as { id?: unknown } | null)?.id);
    if (id === null) {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: `${context} did not return a command id.` },
      };
    }
    return { ok: true, value: id };
  }

  /**
   * Rescan one title so the preview is computed against what is on disk now
   * (ADR-2). The two backends disagree on the shape — Sonarr takes a scalar
   * `seriesId`, Radarr an array `movieIds` — and on nothing else.
   */
  async rescanTitle(
    target: { kind: RenameTitleKind; upstreamId: number },
    signal?: AbortSignal,
  ): Promise<ClientResult<number>> {
    const payload = target.kind === 'series'
      ? { name: 'RescanSeries', seriesId: target.upstreamId }
      : { name: 'RescanMovie', movieIds: [target.upstreamId] };
    return this.postCommand(payload, `${this.kind} rescan command`, signal);
  }

  async commandStatus(
    commandId: number,
    signal?: AbortSignal,
  ): Promise<ClientResult<ArrCommandStatus>> {
    const context = `${this.kind} command status`;
    const combined = this.withTimeout(signal);

    const response = await requestWithRetry(
      this.url(`/command/${commandId}`),
      this.requestInit(combined),
      combined,
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    const record = (body.value ?? {}) as { id?: unknown; status?: unknown; message?: unknown };
    return {
      ok: true,
      value: {
        id: asNumber(record.id, commandId),
        state: toCommandState(record.status),
        message: asStringOrNull(record.message),
      },
    };
  }

  /**
   * `GET /rename` — preview only. It computes; it moves nothing.
   *
   * An empty array is a real answer ("nothing pending"), and the caller must be
   * able to tell it apart from a read that failed (REQ-RENAME-006) — which is
   * why the not-an-array case is an error rather than a silent `[]`.
   */
  async renamePreview(
    target: { kind: RenameTitleKind; upstreamId: number },
    signal?: AbortSignal,
  ): Promise<ClientResult<ArrRenameRow[]>> {
    const context = `${this.kind} rename preview`;
    const combined = this.withTimeout(signal);

    const url = target.kind === 'series'
      ? this.url('/rename', { seriesId: target.upstreamId })
      : this.url('/rename', { movieId: target.upstreamId });

    const response = await requestWithRetry(url, this.requestInit(combined), combined);
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    if (!Array.isArray(body.value)) {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: `${context} did not return a rename array.` },
      };
    }

    const rows: ArrRenameRow[] = [];
    for (const raw of body.value) {
      const row = toRenameRow(raw, target.kind);
      if (row) rows.push(row);
    }
    return { ok: true, value: rows };
  }

  /**
   * `GET /episodefile?seriesId=` / `GET /moviefile?movieId=` — every file the
   * instance holds for the title, whether or not it has a rename pending.
   *
   * One extra read per title, which the measured preview cost (Sonarr median
   * 21ms) makes affordable, and it buys the one collision shape the preview
   * cannot show: a destination already occupied by a file that is *not* being
   * renamed, and so is not in the preview at all.
   */
  /**
   * The title's root directory, as the instance reports it.
   *
   * `GET /rename` speaks in paths relative to this, so it is the one piece
   * needed to turn a proposed destination into something the filesystem
   * endpoint can be asked about.
   */
  private async titleRoot(
    target: { kind: RenameTitleKind; upstreamId: number },
    signal: AbortSignal,
  ): Promise<ClientResult<string>> {
    const context = `${this.kind} title path`;
    const url = target.kind === 'series'
      ? this.url(`/series/${target.upstreamId}`)
      : this.url(`/movie/${target.upstreamId}`);

    const response = await requestWithRetry(url, this.requestInit(signal), signal);
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, context) };
    }

    const body = await readJson(response.value, context);
    if (!body.ok) return body;

    const path = asStringOrNull((body.value as Record<string, unknown> | null)?.path);
    if (!path) {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: `${context} did not include a path.` },
      };
    }
    return { ok: true, value: path };
  }

  async listExistingPaths(
    target: { kind: RenameTitleKind; upstreamId: number },
    relativeDirs: string[],
    signal?: AbortSignal,
  ): Promise<ClientResult<string[]>> {
    const context = `${this.kind} directory listing`;
    const combined = this.withTimeout(signal);

    const root = await this.titleRoot(target, combined);
    if (!root.ok) return root;

    const base = root.value.replace(/[/\\]+$/, '');
    const found: string[] = [];

    for (const dir of [...new Set(relativeDirs)]) {
      // The trailing slash is load-bearing. Without it the endpoint resolves the
      // *parent* of the named directory and answers about the wrong folder —
      // measured on 2026-09-17, where the query returned the series root's four
      // files instead of the season's forty-six.
      const absolute = dir === '' ? `${base}/` : `${base}/${dir}/`;
      const url = this.url('/filesystem', { path: absolute, includeFiles: true });

      const response = await requestWithRetry(url, this.requestInit(combined), combined);
      if (!response.ok) return response;
      if (!response.value.ok) {
        return { ok: false, error: classifyResponse(response.value, context) };
      }

      const body = await readJson(response.value, context);
      if (!body.ok) return body;

      const files = (body.value as Record<string, unknown> | null)?.files;
      // A directory that does not exist yet is not an error — it is the answer
      // "nothing occupies this destination".
      if (!Array.isArray(files)) continue;

      for (const raw of files) {
        if (!raw || typeof raw !== 'object') continue;
        const name = asStringOrNull((raw as Record<string, unknown>).name);
        if (!name) continue;
        found.push(dir === '' ? name : `${dir}/${name}`);
      }
    }

    return { ok: true, value: found };
  }

  /**
   * `RenameFiles` with an explicit file list (ADR-6). `RenameSeries` /
   * `RenameMovie` are not a fallback: they cannot *represent* an exclusion, so
   * a row the operator unchecked would be renamed anyway.
   */
  async renameFiles(
    request: RenameCommandRequest,
    signal?: AbortSignal,
  ): Promise<ClientResult<number>> {
    if (request.fileIds.length === 0) {
      return {
        ok: false,
        error: { kind: 'upstream-error', reason: 'Refusing to issue RenameFiles with no files.' },
      };
    }

    const payload = request.kind === 'series'
      ? { name: 'RenameFiles', seriesId: request.titleId, files: request.fileIds }
      : { name: 'RenameFiles', movieId: request.titleId, files: request.fileIds };
    return this.postCommand(payload, `${this.kind} rename command`, signal);
  }
}

/* ── Rename parsing ───────────────────────────────────────────────────────── */

/**
 * Sonarr and Radarr name the same three things differently and agree on
 * nothing else. Measured key unions (research.md): Sonarr returns
 * `episodeFileId`/`existingPath`/`newPath`/`episodeNumbers`/`seasonNumber`/
 * `seriesId`; Radarr returns `movieFileId`/`existingPath`/`newPath`/`movieId`.
 *
 * A row missing a file id or either path is dropped rather than defaulted: a
 * rename row with a guessed path is worse than one that is absent, because the
 * operator would approve the guess.
 */
function toRenameRow(raw: unknown, kind: RenameTitleKind): ArrRenameRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const fileId = asNumberOrNull(kind === 'series' ? record.episodeFileId : record.movieFileId);
  if (fileId === null) return null;

  const existingPath = asStringOrNull(record.existingPath);
  const proposedPath = asStringOrNull(record.newPath);
  if (!existingPath || !proposedPath) return null;

  // Radarr has no analogue — null means "not applicable", never "one".
  const episodeNumbers = record.episodeNumbers;
  const episodeCount = kind === 'series' && Array.isArray(episodeNumbers)
    ? episodeNumbers.length
    : null;

  return { fileId, existingPath, proposedPath, episodeCount };
}

/**
 * An unrecognised status becomes `unknown`, not `completed`. The caller treats
 * `unknown` as "keep waiting, then verify" — mapping it to a terminal success
 * would report files as renamed on the strength of a string nobody checked.
 */
function toCommandState(value: unknown): ArrCommandStatus['state'] {
  switch (value) {
    case 'queued':
      return 'queued';
    case 'started':
      return 'started';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'aborted':
    case 'cancelled':
      return 'failed';
    default:
      return 'unknown';
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

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Strict: a missing flag is false, never truthy-by-coercion. */
function asBool(value: unknown): boolean {
  return value === true;
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
      // A film has no season. Inert, so the shared type stays one type.
      seasonNumber: null,
      fullSeason: false,
      isMultiSeason: false,
      episodeCount: 0,
    };
  }

  const series = raw.series as Record<string, unknown> | null | undefined;
  const info = (raw.parsedEpisodeInfo ?? null) as Record<string, unknown> | null;
  const seriesId = typeof series?.id === 'number' ? series.id : null;
  const episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
  return {
    resolved: seriesId !== null,
    seriesId,
    movieId: null,
    label: series ? episodeLabel({ series, episodes: raw.episodes }) : null,
    quality: qualityName(info),
    releaseGroup: asStringOrNull(info?.releaseGroup),
    // Sonarr's reading of the name, carried through. `episodeCount` is the
    // length of what it resolved — helparr never asserts the set itself (FR2).
    seasonNumber: asNumberOrNull(info?.seasonNumber),
    fullSeason: asBool(info?.fullSeason),
    isMultiSeason: asBool(info?.isMultiSeason),
    episodeCount: episodes.length,
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

/* ── Gap record parsing ───────────────────────────────────────────────────── */

/**
 * The earliest date on which the film could plausibly be downloaded.
 *
 * Digital and physical are preferred over `inCinemas` deliberately: a film in
 * cinemas is released in the sense Radarr means and *not* released in the sense
 * that matters to an indexer, and listing it as an actionable gap would be
 * telling the operator to search for something that does not exist yet.
 */
function earliestReleaseDate(raw: Record<string, unknown>): string | null {
  const candidates = [raw.digitalRelease, raw.physicalRelease]
    .map(asStringOrNull)
    .filter((value): value is string => value !== null);

  if (candidates.length === 0) return asStringOrNull(raw.inCinemas);
  return candidates.sort()[0];
}

export function toGapRecord(input: unknown, kind: InstanceKind): ArrGapRecord {
  const raw = (input ?? {}) as Record<string, unknown>;

  if (kind === 'radarr') {
    const year = asNumber(raw.year, 0);
    return {
      kind: 'movie',
      upstreamId: asNumber(raw.id, -1),
      seriesId: null,
      seasonNumber: null,
      itemCode: year > 0 ? String(year) : '—',
      title: asString(raw.title, 'Untitled'),
      airDate: earliestReleaseDate(raw),
      // Radarr alone records this. Sonarr has no per-episode equivalent, and
      // inventing one from history would be a guess presented as a fact (ADR-5).
      lastSearchAt: asStringOrNull(raw.lastSearchTime),
      path: asStringOrNull(raw.path),
      qualityProfileId: typeof raw.qualityProfileId === 'number' ? raw.qualityProfileId : null,
      // Absent reads as monitored, not unmonitored: `wanted/missing` only ever
    // returns monitored items, so a field an older build omits must not make
    // the belt-and-braces guard downstream throw the whole list away.
    monitored: raw.monitored !== false,
      hasFile: raw.hasFile === true,
      releaseStatus: asStringOrNull(raw.status),
    };
  }

  const season = asNumber(raw.seasonNumber, -1);
  const number = asNumber(raw.episodeNumber, -1);
  return {
    kind: 'episode',
    upstreamId: asNumber(raw.id, -1),
    seriesId: typeof raw.seriesId === 'number' ? raw.seriesId : null,
    // Kept, not re-derived from `itemCode`: the same number the season attach
    // will name to Sonarr, from Sonarr.
    seasonNumber: season >= 0 ? season : null,
    itemCode: season >= 0 && number >= 0 ? `S${pad(season)}E${pad(number)}` : '—',
    title: asString(raw.title, 'Untitled'),
    airDate: asStringOrNull(raw.airDateUtc) ?? asStringOrNull(raw.airDate),
    lastSearchAt: null,
    // Both come from the series, via the join — the episode record carries
    // neither, which is exactly why the join exists.
    path: null,
    qualityProfileId: null,
    // Absent reads as monitored, not unmonitored: `wanted/missing` only ever
    // returns monitored items, so a field an older build omits must not make
    // the belt-and-braces guard downstream throw the whole list away.
    monitored: raw.monitored !== false,
    hasFile: raw.hasFile === true,
    releaseStatus: null,
  };
}

export function toSeriesSummary(input: unknown): SeriesSummary {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    id: asNumber(raw.id, -1),
    title: asString(raw.title, 'Untitled series'),
    path: asString(raw.path),
    // Absent reads as monitored, not unmonitored: `wanted/missing` only ever
    // returns monitored items, so a field an older build omits must not make
    // the belt-and-braces guard downstream throw the whole list away.
    monitored: raw.monitored !== false,
    qualityProfileId: typeof raw.qualityProfileId === 'number' ? raw.qualityProfileId : null,
  };
}

/**
 * The season counts, and nothing else the series object carries.
 *
 * A season whose `statistics` block is missing is **dropped**, not defaulted to
 * zero: the confirmation renders an absent count as absent, and a fabricated
 * `0 of 0` would read as "nothing is filed here" — a claim helparr would be
 * making on Sonarr's behalf.
 */
export function toSeriesDetail(input: unknown): SeriesDetail {
  const raw = (input ?? {}) as Record<string, unknown>;
  const seasons = Array.isArray(raw.seasons) ? raw.seasons : [];

  return {
    id: asNumber(raw.id, -1),
    title: asString(raw.title, 'Untitled series'),
    path: asString(raw.path),
    seasons: seasons
      .map((entry): SeasonStatistic | null => {
        const season = (entry ?? {}) as Record<string, unknown>;
        const number = asNumberOrNull(season.seasonNumber);
        const stats = (season.statistics ?? null) as Record<string, unknown> | null;
        const episodeCount = asNumberOrNull(stats?.episodeCount);
        const episodeFileCount = asNumberOrNull(stats?.episodeFileCount);
        if (number === null || episodeCount === null || episodeFileCount === null) return null;
        return { seasonNumber: number, episodeCount, episodeFileCount };
      })
      .filter((season): season is SeasonStatistic => season !== null),
  };
}

export function toHistoryEvent(input: unknown): HistoryEvent {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    at: asString(raw.date),
    eventType: asString(raw.eventType, 'unknown'),
    // The release name the event is about. Shown verbatim — a truncated or
    // prettified release name is useless for working out what went wrong.
    sourceTitle: asString(raw.sourceTitle),
  };
}

export function isArrKind(kind: InstanceKind): boolean {
  return kind !== 'download-client';
}

export function assertApiKeyCredential(credential: Credential): asserts credential is Extract<Credential, { type: 'api-key' }> {
  if (credential.type !== 'api-key') throw new Error('expected an api-key credential');
}
