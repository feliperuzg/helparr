import 'server-only';

import type { IndexerRead, ReleaseRead } from '@/lib/types';
import { BaseArrClient } from './base';
import { classifyResponse, readJson, requestWithRetry } from './http';
import type { ClientResult, SearchClient, SearchScope } from './types';

/**
 * Prowlarr's search surface (REQ-SEARCH-001..003).
 *
 * Prowlarr deliberately exposes no aggregate Torznab feed — its per-indexer
 * `/{id}/api` endpoints hit one tracker each — so `GET /api/v1/search` is the
 * only way to query every indexer, and it is not optional for us.
 */

/**
 * A search is a live query against real trackers, not a database read. The
 * shared 8s client budget is too tight: the spike saw multi-second responses
 * from healthy indexers under no load.
 */
const SEARCH_DEADLINE_MS = 30_000;

export class ProwlarrClient extends BaseArrClient implements SearchClient {
  /**
   * The indexer roster, with health folded in.
   *
   * `/indexerstatus` lists the indexers Prowlarr has currently backed off from
   * after consecutive failures. It is read best-effort: if that endpoint is
   * missing on an older build, every indexer reports healthy rather than the
   * whole roster failing. A missing health channel is a smaller lie than an
   * empty screen.
   */
  async indexers(signal?: AbortSignal): Promise<ClientResult<IndexerRead[]>> {
    const context = 'prowlarr indexers';
    const combined = this.withTimeout(signal);

    const response = await requestWithRetry(
      this.url('/indexer'),
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
          reason: `${context} did not return an indexer array — this does not look like Prowlarr.`,
        },
      };
    }

    const unhealthy = await this.backedOff(combined);

    return {
      ok: true,
      value: body.value.map((raw) => toIndexer(raw, unhealthy)),
    };
  }

  private async backedOff(signal: AbortSignal): Promise<Set<number>> {
    const ids = new Set<number>();
    try {
      const response = await fetch(this.url('/indexerstatus'), {
        ...this.requestInit(signal),
        cache: 'no-store',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return ids;
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return ids;
      for (const entry of body) {
        const status = entry as { indexerId?: unknown; disabledTill?: unknown } | null;
        if (typeof status?.indexerId !== 'number') continue;
        // A past `disabledTill` is a healed indexer Prowlarr has not yet pruned.
        const till = typeof status.disabledTill === 'string' ? Date.parse(status.disabledTill) : NaN;
        if (Number.isNaN(till) || till > Date.now()) ids.add(status.indexerId);
      }
    } catch {
      // Best-effort by design — see the method comment.
    }
    return ids;
  }

  /**
   * One search, scoped exactly as asked.
   *
   * `indexerIds` binds as an ASP.NET Core `List<int>`, so `buildQuery` appends
   * it once per element (ADR-1). An empty `indexerIds` omits the parameter,
   * which is how "all indexers" is expressed — `-1` is **not** a wildcard, it
   * is HTTP 400.
   */
  async search(scope: SearchScope, signal?: AbortSignal): Promise<ClientResult<ReleaseRead[]>> {
    const context = scope.indexerIds.length === 1
      ? `prowlarr search (indexer ${scope.indexerIds[0]})`
      : 'prowlarr search';

    const combined = this.withTimeout(signal, SEARCH_DEADLINE_MS);
    const url = this.url('/search', {
      query: scope.query,
      type: 'search',
      indexerIds: scope.indexerIds.length > 0 ? scope.indexerIds : undefined,
      categories: scope.categories.length > 0 ? scope.categories : undefined,
    });

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
        error: { kind: 'upstream-error', reason: `${context} did not return a result array.` },
      };
    }

    return { ok: true, value: body.value.map(toRelease) };
  }
}

/* ── Result parsing ───────────────────────────────────────────────────────── */

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

function toProtocol(value: unknown): 'torrent' | 'usenet' {
  return asString(value).toLowerCase() === 'usenet' ? 'usenet' : 'torrent';
}

export function toIndexer(input: unknown, unhealthy: Set<number>): IndexerRead {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = asNumber(raw.id, -1);
  return {
    id,
    name: asString(raw.name, `Indexer ${id}`),
    protocol: toProtocol(raw.protocol),
    // Prowlarr's field is `enable`, singular — not `enabled`.
    enabled: raw.enable !== false,
    healthy: !unhealthy.has(id),
  };
}

/**
 * `freeleech` is derived, not read. The spike enumerated the result shape and
 * there is no `freeleech` key — the signal lives in `indexerFlags`, whose
 * spelling varies by tracker (`freeleech`, `G_Freeleech`, `FreeLeech`).
 */
export function isFreeleech(flags: unknown): boolean {
  if (!Array.isArray(flags)) return false;
  return flags.some((flag) => typeof flag === 'string' && flag.toLowerCase().includes('freeleech'));
}

/**
 * The link the grab will hand to the *arr.
 *
 * Prowlarr proxies downloads through itself, so `downloadUrl` carries
 * Prowlarr's own API key — the credential to the whole application, which is
 * why it is registered as a secret on receipt and hashed before it reaches the
 * operation log (NFR2, ADR-7). Usenet results have no magnet to fall back to,
 * and a result with no link at all is kept rather than dropped: the operator
 * still wants to see it exists, and the grab path refuses it explicitly.
 */
function grabUrl(raw: Record<string, unknown>): string {
  return asStringOrNull(raw.downloadUrl)
    ?? asStringOrNull(raw.magnetUrl)
    ?? '';
}

export function toRelease(input: unknown): ReleaseRead {
  const raw = (input ?? {}) as Record<string, unknown>;
  const publishDate = asString(raw.publishDate);

  return {
    guid: asString(raw.guid),
    title: asString(raw.title, 'Untitled release'),
    indexerId: asNumber(raw.indexerId, -1),
    indexer: asString(raw.indexer, 'unknown indexer'),
    protocol: toProtocol(raw.protocol),
    size: asNumber(raw.size),
    // Null, not zero. A usenet result has no seeders at all, and rendering that
    // as "0 seeders" would read as a dead torrent.
    seeders: asNumberOrNull(raw.seeders),
    leechers: asNumberOrNull(raw.leechers),
    ageHours: asNumber(raw.ageHours, asNumber(raw.age) * 24),
    publishDate,
    infoHash: asStringOrNull(raw.infoHash),
    freeleech: isFreeleech(raw.indexerFlags),
    downloadUrl: grabUrl(raw),
  };
}
