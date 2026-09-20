import 'server-only';

import { getDb } from '@/server/db';

/**
 * Login rate limiting (REQ-AUTH-004 / NFR2, AC12).
 *
 * A LAN-exposed port otherwise allows offline-speed guessing against a single
 * password. Attempts are recorded in SQLite rather than in memory so the limit
 * survives the restart an attacker could otherwise trigger.
 */

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

interface CountRow {
  failures: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(source: string): RateLimitVerdict {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = getDb().prepare(`
    SELECT count(*) AS failures
      FROM login_attempt
     WHERE source = ? AND succeeded = 0 AND attempted_at > ?
  `).get(source, since) as CountRow;

  if (row.failures < MAX_FAILURES) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const oldest = getDb().prepare(`
    SELECT attempted_at FROM login_attempt
     WHERE source = ? AND succeeded = 0 AND attempted_at > ?
     ORDER BY attempted_at ASC LIMIT 1
  `).get(source, since) as { attempted_at: string } | undefined;

  const expiresAt = oldest
    ? new Date(oldest.attempted_at).getTime() + WINDOW_MS
    : Date.now() + WINDOW_MS;

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
  };
}

export function recordAttempt(source: string, succeeded: boolean): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO login_attempt (source, attempted_at, succeeded) VALUES (?, ?, ?)',
  ).run(source, new Date().toISOString(), succeeded ? 1 : 0);

  // A successful login clears the window so an operator who mistyped four
  // times is not throttled on their next session.
  if (succeeded) {
    db.prepare('DELETE FROM login_attempt WHERE source = ? AND succeeded = 0').run(source);
  }

  // Bounded retention — this table is a rate-limit window, not an audit log.
  db.prepare(`
    DELETE FROM login_attempt WHERE attempted_at < ?
  `).run(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
}

/**
 * Identifies the caller for rate-limiting purposes. On a LAN behind a reverse
 * proxy every request shares the proxy's socket address, so the forwarded
 * header is preferred when present.
 */
export function rateLimitSource(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip') ?? 'unknown';
}

/**
 * The same caller, in a separate throttle namespace for password changes
 * (ADR-6).
 *
 * `recordAttempt(source, true)` clears the failure window for its source, which
 * is right for login and wrong for anything else sharing that source: a
 * successful password change under the bare address would wipe an in-progress
 * login throttle, handing anyone with a session a throttle bypass. The
 * `login_attempt.source` column is free-text, so the two windows cost nothing
 * but this prefix.
 */
export function passwordChangeSource(headers: Headers): string {
  return `pwchange:${rateLimitSource(headers)}`;
}
