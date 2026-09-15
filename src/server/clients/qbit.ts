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
 * qBittorrent WebUI client (ADR-5, verified in research.md's planning addendum).
 *
 * The only stateful client in the system. Three rules it must follow, each
 * corresponding to a real failure that is intermittent and hard to diagnose:
 *
 *  1. Never parse the body to determine success. 5.2.0 changed a successful
 *     login from `200 OK` with `Ok.` to `204 No Content` with an empty body,
 *     while older versions return `200` with `Fails.` on *failure*. Any
 *     body-based check is wrong on some version. Success is a 2xx status plus
 *     a `SID` in `Set-Cookie`.
 *  2. Always send `Referer`. qBittorrent rejects requests whose `Referer` or
 *     `Origin` does not match `Host` with a 403 that looks exactly like an auth
 *     failure — the "works in curl, fails from the app" classic.
 *  3. Re-login exactly once. A 403 on a request carrying a cached SID is
 *     ambiguous: expired session, or rejected credential. One retry
 *     distinguishes them; retrying beyond that turns a wrong password into a
 *     hammering loop.
 */

/**
 * In-memory, per process, keyed by instance id. Never persisted: a SID in the
 * database would be a credential in a backup with none of the lifetime
 * guarantees of the password it came from. A restart costs one extra login.
 */
const sessions = new Map<string, string>();

export function clearSession(instanceId: string): void {
  sessions.delete(instanceId);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export class QbitClient implements InstanceClient {
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
   * Returns the SID on success, or a failure result the caller can surface
   * directly. Rule 1 lives here.
   */
  private async login(
    signal?: AbortSignal,
  ): Promise<{ sid: string } | Extract<ProbeResult, { state: 'unauthorized' | 'unreachable' | 'degraded' }>> {
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

    const sid = extractSid(response.headers);

    // Rule 1: 2xx AND a SID. Not the body, on any version.
    if (!response.ok || !sid) {
      return {
        state: 'unauthorized',
        reason: 'qBittorrent rejected the username or password.',
      };
    }

    sessions.set(this.instanceId, sid);
    return { sid };
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();

    let sid = sessions.get(this.instanceId);
    if (!sid) {
      const result = await this.login(signal);
      if ('state' in result) return result;
      sid = result.sid;
    }

    const attempt = async (cookie: string): Promise<Response | ProbeResult> => {
      try {
        return await fetch(`${this.baseUrl}/api/v2/app/version`, {
          headers: this.headers({ Cookie: `SID=${cookie}`, Accept: 'text/plain' }),
          signal: this.signal(signal),
          cache: 'no-store',
        });
      } catch (error) {
        return { state: 'unreachable', reason: describeNetworkError(error) };
      }
    };

    let response = await attempt(sid);
    if (!(response instanceof Response)) return response;

    // Rule 3 — exactly one re-login, never a loop.
    if (response.status === 401 || response.status === 403) {
      sessions.delete(this.instanceId);
      const relogin = await this.login(signal);
      if ('state' in relogin) return relogin;
      response = await attempt(relogin.sid);
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
}

/**
 * Exported for the unit tests, which assert SID detection across every
 * documented response shape rather than the happy path alone.
 */
export function extractSid(headers: Headers): string | null {
  // `getSetCookie` preserves multiple Set-Cookie headers; a plain `get` would
  // fold them into one comma-joined string and break on cookies containing
  // an Expires date.
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((v): v is string => v !== null);

  for (const cookie of cookies) {
    const match = /(?:^|;\s*)SID=([^;]+)/.exec(cookie);
    if (match && match[1]) return match[1];
  }
  return null;
}
