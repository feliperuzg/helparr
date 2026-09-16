import 'server-only';

import type { InstanceKind } from '@/lib/types';
import {
  DEFAULT_TIMEOUT_MS,
  describeNetworkError,
  normalizeBaseUrl,
  type ClientConfig,
  type InstanceClient,
  type ProbeResult,
} from './types';

/**
 * The half of the *arr client surface that has nothing to do with what the
 * upstream actually does: the credential, the base URL, the API version prefix,
 * the timeout plumbing and `probe()`.
 *
 * Sonarr, Radarr and Prowlarr all take the same `X-Api-Key` header but not the
 * same API version — Sonarr and Radarr are on `/api/v3`, Prowlarr on `/api/v1`.
 * Assuming v3 everywhere is the mistake that makes a correctly-configured
 * Prowlarr report "unreachable": the host answers, the path 404s.
 *
 * Prowlarr's search surface has nothing in common with a download queue, so the
 * two diverge below this class rather than accumulating in one file.
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
 * A query value that is an array appends **once per element** — `ids=4&ids=7` —
 * never as CSV (ADR-1).
 *
 * This is not a stylistic preference. `indexerIds` binds as an ASP.NET Core
 * `List<int>`, and the alternatives were measured against Prowlarr 2.5.2.5491:
 * CSV returns `400 The value '1,6,9,4' is not valid.`, and `-1` — widely
 * documented as the all-indexers wildcard — returns
 * `400 Search failed due to all selected indexers being unavailable`. "All"
 * is expressed by omitting the parameter, which an empty array does here.
 */
export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined | null;

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, String(entry));
      continue;
    }
    search.append(key, String(value as string | number | boolean));
  }
  return search.toString();
}

export abstract class BaseArrClient implements InstanceClient {
  readonly kind: InstanceKind;

  readonly baseUrl: string;

  protected readonly apiKey: string;

  protected readonly timeoutMs: number;

  constructor(config: ClientConfig) {
    if (config.credential.type !== 'api-key') {
      throw new Error(`${config.kind} requires an api-key credential`);
    }
    this.kind = config.kind;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.credential.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `path` is API-relative; `params` binds arrays per `buildQuery`. */
  protected url(path: string, params?: Record<string, QueryValue>): string {
    const base = `${this.baseUrl}${arrApiBase(this.kind)}${path}`;
    if (!params) return base;
    const query = buildQuery(params);
    return query ? `${base}?${query}` : base;
  }

  /** Every request in every subclass carries the same auth and JSON headers. */
  protected requestInit(signal: AbortSignal, method = 'GET'): RequestInit {
    return {
      method,
      headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
      signal,
    };
  }

  /** The client's own per-request deadline, combined with the caller's. */
  protected withTimeout(external?: AbortSignal, ms = this.timeoutMs): AbortSignal {
    const own = AbortSignal.timeout(ms);
    return external ? AbortSignal.any([external, own]) : own;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    // `/system/status` is the cheap liveness endpoint and the one that also
    // proves the credential. `/health` is deliberately not used here: it only
    // reads the upstream's own cached task results, so polling it fast buys
    // nothing, and Sonarr's SystemTimeCheck can throw when the host is
    // offline and abort the whole run.
    const started = Date.now();
    const combined = this.withTimeout(signal);

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
}
