import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import { getEncryptionKey } from '@/server/crypto';

/**
 * Session cookie (ADR-3, REQ-AUTH-003, REQ-AUTH-006).
 *
 * The cookie value is `<issuedAt>.<nonce>.<hmac>`, signed with a key derived
 * from HELPARR_ENCRYPTION_KEY plus the per-process signing material below.
 * Stateless verification keeps the hot path off the database; revocation
 * works by rotating that material rather than by storing session rows.
 */

export const SESSION_COOKIE = 'helparr_session';

const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

/**
 * Revocation is folded into the signing key rather than compared against a
 * timestamp: a cookie issued in the same millisecond as the logout would
 * survive a `issuedAt < epoch` check, and `Date.now()` is exactly that coarse.
 * Changing the key makes every previously issued signature fail outright,
 * which is what makes "reusing the prior cookie SHALL be refused"
 * (REQ-AUTH-006) true without a session table.
 *
 * Both parts are process-local, so a restart also invalidates every session —
 * the conservative direction for an app whose whole job is holding other
 * systems' credentials.
 */
const processSalt = randomBytes(16).toString('base64url');
let generation = 0;

function signingKey(): string {
  return `session:${getEncryptionKey()}:${processSalt}:${generation}`;
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export function issueSessionValue(): string {
  const payload = `${Date.now()}.${randomBytes(18).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionValue(value: string | undefined): boolean {
  if (!value) return false;
  const lastDot = value.lastIndexOf('.');
  if (lastDot <= 0) return false;

  const payload = value.slice(0, lastDot);
  const provided = value.slice(lastDot + 1);
  const expected = sign(payload);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  // Revocation was already enforced by the signature check above; the
  // timestamp is only here to cap how long a still-valid session lives.
  const issuedAt = Number(payload.split('.')[0]);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt < MAX_AGE_SECONDS * 1000;
}

export function revokeAllSessions(): void {
  generation += 1;
}

/**
 * `Secure` is conditional, not unconditional. helparr's stated deployment is
 * LAN-first over plain HTTP, where an unconditional Secure flag makes login
 * silently impossible — the browser accepts the redirect and drops the cookie.
 */
export function cookieOptions(request: { url: string; headers: Headers }) {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const secure = forwardedProto
    ? forwardedProto.split(',')[0]!.trim() === 'https'
    : request.url.startsWith('https://');

  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure,
    maxAge: MAX_AGE_SECONDS,
  };
}

/** Reads and verifies the session from the incoming request's cookies. */
export async function hasValidSession(): Promise<boolean> {
  const store = await cookies();
  return verifySessionValue(store.get(SESSION_COOKIE)?.value);
}
