import 'server-only';

import type { InstanceKind } from '@/lib/types';
import type { Credential } from '@/server/instances/credential';
import {
  DEFAULT_TIMEOUT_MS,
  describeNetworkError,
  normalizeBaseUrl,
  type ClientConfig,
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

export class ArrClient implements InstanceClient {
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
}

export function isArrKind(kind: InstanceKind): boolean {
  return kind !== 'download-client';
}

export function assertApiKeyCredential(credential: Credential): asserts credential is Extract<Credential, { type: 'api-key' }> {
  if (credential.type !== 'api-key') throw new Error('expected an api-key credential');
}
