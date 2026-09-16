import 'server-only';

import type { InstanceKind, TorrentState } from '@/lib/types';
import { classifyResponse, readJson, requestWithRetry } from './http';
import {
  DEFAULT_TIMEOUT_MS,
  describeNetworkError,
  normalizeBaseUrl,
  type ClientConfig,
  type ClientFailure,
  type ClientResult,
  type InstanceClient,
  type ProbeResult,
  type TorrentClient,
} from './types';

/**
 * qBittorrent WebUI client (ADR-5, verified in research.md's planning addendum).
 *
 * The only stateful client in the system. Three rules it must follow, each
 * corresponding to a real failure that is intermittent and hard to diagnose:
 *
 *  1. Never parse the body to determine success. 5.2.0 changed a successful
 *     login from `200 OK` with `Ok.` to `204 No Content` with an empty body,
 *     while older versions return `200` with `Fails.` on *failure*. Any
 *     body-based check is wrong on some version. Success is a 2xx status plus
 *     a session cookie in `Set-Cookie` — whose *name* is also version-dependent
 *     (`SID` pre-5.1, `QBT_SID_<port>` after), so the whole `name=value` pair is
 *     kept and replayed rather than the value under an assumed name.
 *  2. Always send `Referer`. qBittorrent rejects requests whose `Referer` or
 *     `Origin` does not match `Host` with a 403 that looks exactly like an auth
 *     failure — the "works in curl, fails from the app" classic.
 *  3. Re-login exactly once. A 403 on a request carrying a cached SID is
 *     ambiguous: expired session, or rejected credential. One retry
 *     distinguishes them; retrying beyond that turns a wrong password into a
 *     hammering loop.
 */

/**
 * In-memory, per process, keyed by instance id. Holds the whole `name=value`
 * cookie pair. Never persisted: a live session in the database would be a
 * credential in a backup with none of the lifetime guarantees of the password it
 * came from. A restart costs one extra login.
 */
const sessions = new Map<string, string>();

export function clearSession(instanceId: string): void {
  sessions.delete(instanceId);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export class QbitClient implements InstanceClient, TorrentClient {
  readonly kind: InstanceKind = 'download-client';

  readonly baseUrl: string;

  private readonly instanceId: string;

  private readonly username: string;

  private readonly password: string;

  private readonly timeoutMs: number;

  constructor(instanceId: string, config: ClientConfig) {
    if (config.credential.type !== 'userpass') {
      throw new Error('download-client requires a userpass credential');
    }
    this.instanceId = instanceId;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.username = config.credential.username;
    this.password = config.credential.password;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private signal(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  /** Rule 2 — every request carries a Referer matching the target host. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Referer: this.baseUrl,
      Origin: this.baseUrl,
      ...extra,
    };
  }

  /**
   * Returns the session cookie pair on success, or a failure result the caller
   * can surface directly. Rule 1 lives here.
   */
  private async login(
    signal?: AbortSignal,
  ): Promise<{ cookie: string } | Extract<ProbeResult, { state: 'unauthorized' | 'unreachable' | 'degraded' }>> {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body,
        signal: this.signal(signal),
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch (error) {
      return { state: 'unreachable', reason: describeNetworkError(error) };
    }

    if (response.status === 403) {
      // Reported distinctly rather than collapsed into "credential rejected",
      // because the operator's fix is entirely different.
      return {
        state: 'degraded',
        reason: 'qBittorrent rejected the request as cross-site (403). Its CSRF check '
          + 'compares Referer against Host — make the configured base URL match the '
          + 'address qBittorrent is reached on, or disable host-header validation there.',
      };
    }

    const cookie = extractSessionCookie(response.headers);

    // Rule 1: 2xx AND a session cookie. Not the body, on any version.
    if (!response.ok || !cookie) {
      return {
        state: 'unauthorized',
        reason: 'qBittorrent rejected the username or password.',
      };
    }

    sessions.set(this.instanceId, cookie);
    return { cookie };
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();

    let session = sessions.get(this.instanceId);
    if (!session) {
      const result = await this.login(signal);
      if ('state' in result) return result;
      session = result.cookie;
    }

    const attempt = async (cookie: string): Promise<Response | ProbeResult> => {
      try {
        return await fetch(`${this.baseUrl}/api/v2/app/version`, {
          headers: this.headers({ Cookie: cookie, Accept: 'text/plain' }),
          signal: this.signal(signal),
          cache: 'no-store',
        });
      } catch (error) {
        return { state: 'unreachable', reason: describeNetworkError(error) };
      }
    };

    let response = await attempt(session);
    if (!(response instanceof Response)) return response;

    // Rule 3 — exactly one re-login, never a loop.
    if (response.status === 401 || response.status === 403) {
      sessions.delete(this.instanceId);
      const relogin = await this.login(signal);
      if ('state' in relogin) return relogin;
      response = await attempt(relogin.cookie);
      if (!(response instanceof Response)) return response;
      if (response.status === 401 || response.status === 403) {
        return {
          state: 'unauthorized',
          reason: 'qBittorrent rejected the session immediately after a successful login. '
            + 'Check that the account is not restricted by IP subnet.',
        };
      }
    }

    if (!response.ok) {
      return { state: 'degraded', reason: `qBittorrent returned HTTP ${response.status}.` };
    }

    const version = (await response.text()).trim();
    if (!version) {
      return { state: 'degraded', reason: 'qBittorrent returned an empty version string.' };
    }

    return { state: 'ok', version, latencyMs: Date.now() - started };
  }

  /**
   * A GET that carries the session and honours Rule 3 — exactly one re-login on
   * a 401/403, never a loop. Shares the login path with `probe`, so an expired
   * SID is resolved once for whichever call hits it first.
   */
  private async authorized(path: string, signal: AbortSignal): Promise<ClientResult<Response>> {
    let session = sessions.get(this.instanceId);
    if (!session) {
      const result = await this.login(signal);
      if ('state' in result) return { ok: false, error: toClientFailure(result) };
      session = result.cookie;
    }

    const send = (cookie: string) => requestWithRetry(
      `${this.baseUrl}${path}`,
      {
        headers: this.headers({ Cookie: cookie, Accept: 'application/json' }),
        signal,
      },
      signal,
    );

    let response = await send(session);
    if (!response.ok) return response;

    if (response.value.status === 401 || response.value.status === 403) {
      await response.value.body?.cancel().catch(() => {});
      sessions.delete(this.instanceId);
      const relogin = await this.login(signal);
      if ('state' in relogin) return { ok: false, error: toClientFailure(relogin) };
      response = await send(relogin.cookie);
      if (!response.ok) return response;
    }

    if (!response.value.ok) {
      return { ok: false, error: classifyResponse(response.value, 'qBittorrent') };
    }
    return { ok: true, value: response.value };
  }

  /**
   * Every torrent the client knows about (REQ-QUEUE-003).
   *
   * Read wholesale rather than per-hash: one request serves a queue of any size,
   * and the alternative is N round trips against a service that is frequently
   * the slowest thing on the network.
   */
  async torrents(signal?: AbortSignal): Promise<ClientResult<TorrentState[]>> {
    const response = await this.authorized('/api/v2/torrents/info', this.signal(signal));
    if (!response.ok) return response;

    const body = await readJson(response.value, 'qBittorrent');
    if (!body.ok) return body;

    if (!Array.isArray(body.value)) {
      return {
        ok: false,
        error: {
          kind: 'upstream-error',
          reason: 'qBittorrent returned something other than a torrent list for /torrents/info.',
        },
      };
    }

    // A torrent with no hash cannot be joined to anything, so it is dropped here
    // rather than carried through the enrichment as a permanent non-match.
    return {
      ok: true,
      value: body.value.map(toTorrentState).filter((torrent) => torrent.hash !== ''),
    };
  }
}

function toClientFailure(
  result: Extract<ProbeResult, { state: 'unauthorized' | 'unreachable' | 'degraded' }>,
): ClientFailure {
  if (result.state === 'unauthorized') return { kind: 'unauthorized', reason: result.reason };
  if (result.state === 'unreachable') return { kind: 'unreachable', reason: result.reason };
  return { kind: 'upstream-error', reason: result.reason };
}

/**
 * The two states in which qBittorrent has a torrent but not yet its metadata.
 * This is the condition REQ-QUEUE-005 is about: the *arr reports the download as
 * healthy because, from its side, nothing has gone wrong yet.
 */
const METADATA_STATES = new Set(['metaDL', 'forcedMetaDL']);

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function toTorrentState(input: unknown): TorrentState {
  const raw = (input ?? {}) as Record<string, unknown>;
  const state = typeof raw.state === 'string' ? raw.state : 'unknown';
  return {
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    progress: num(raw.progress),
    numSeeds: num(raw.num_seeds),
    numLeechs: num(raw.num_leechs),
    dlspeed: num(raw.dlspeed),
    eta: num(raw.eta),
    state,
    fetchingMetadata: METADATA_STATES.has(state),
  };
}

/**
 * Exported for the unit tests, which assert SID detection across every
 * documented response shape rather than the happy path alone.
 */
/**
 * Returns the session cookie as a whole `name=value` pair, ready to be replayed
 * verbatim in a `Cookie` header — not just its value.
 *
 * qBittorrent 5.1 renamed the cookie from `SID` to `QBT_SID_<port>` so that two
 * instances behind one host stop clobbering each other's session. Matching only
 * `SID=` therefore fails to log in at all against any current server, and
 * matching the value while replaying it under a hardcoded name would earn a 403.
 * Carrying the pair is immune to both, and to whatever the name becomes next.
 *
 * Verified against qBittorrent v5.2.3 / WebAPI 2.15.1, which issues
 * `QBT_SID_8080=…; HttpOnly; SameSite=Lax; path=/`.
 */
export function extractSessionCookie(headers: Headers): string | null {
  // `getSetCookie` preserves multiple Set-Cookie headers; a plain `get` would
  // fold them into one comma-joined string and break on cookies containing
  // an Expires date.
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((v): v is string => v !== null);

  for (const cookie of cookies) {
    // The session cookie is the first attribute of the header; everything after
    // the first `;` is metadata (HttpOnly, SameSite, expires, path).
    const pair = cookie.split(';', 1)[0]?.trim();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;

    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value) continue;

    // `SID` is pre-5.1; `QBT_SID_<port>` is current. Anything else in the jar
    // is not a session and must not be mistaken for one.
    if (name === 'SID' || /^QBT_SID_\d+$/.test(name)) return pair;
  }
  return null;
}
