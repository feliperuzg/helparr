import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { setOperatorPassword, verifyOperatorPassword } from '@/server/auth/password';
import { checkRateLimit, passwordChangeSource, recordAttempt } from '@/server/auth/rateLimit';
import {
  SESSION_COOKIE,
  cookieOptions,
  issueSessionValue,
  revokeAllSessions,
} from '@/server/auth/session';
import { MIN_INITIAL_PASSWORD_LENGTH } from '@/server/config';
import { logger } from '@/server/logging/redact';

/**
 * Operator password rotation (REQ-AUTH-009, REQ-AUTH-010).
 *
 * The current password is required even though the caller already holds a
 * session. A homelab tab left open on a shared machine is the *normal* state of
 * this application, not an edge case, and the re-authentication also closes the
 * CSRF hole that a session-only change would open.
 *
 * The order of the last three steps is forced and not rearrangeable:
 *
 *   verify current → store new → revoke every session → issue a fresh cookie
 *
 * Revocation is all-or-nothing by construction (`session.ts` rotates the
 * signing material rather than tracking session rows), so revoking after
 * issuing would kill the cookie just handed out, and issuing before revoking
 * would hand out a cookie signed under the doomed generation. Run in this
 * order, "terminate every other session" and "keep the operator signed in"
 * stop being conflicting requirements.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export async function POST(request: Request) {
  // Before anything else, including the body parse: an unauthenticated caller
  // must not be able to tell a correct current password from an incorrect one,
  // or a well-formed body from a malformed one.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: 'Both the current and the new password are required.' },
      { status: 400 },
    );
  }

  // Its own throttle namespace (ADR-6). Sharing login's source would mean a
  // successful rotation clears the login failure window — a throttle bypass
  // available to anyone holding a session.
  const source = passwordChangeSource(request.headers);

  const verdict = checkRateLimit(source);
  if (!verdict.allowed) {
    logger.warn('password change throttled', { source });
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
    );
  }

  const ok = await verifyOperatorPassword(parsed.currentPassword);
  recordAttempt(source, ok);

  if (!ok) {
    logger.info('password change refused: current password incorrect', { source });
    return NextResponse.json({ error: 'The current password is incorrect.' }, { status: 401 });
  }

  // Checked after the current password, so length feedback is only ever given
  // to someone who has already proved they are the operator.
  if (parsed.newPassword.length < MIN_INITIAL_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `The new password must be at least ${MIN_INITIAL_PASSWORD_LENGTH} characters.` },
      { status: 400 },
    );
  }

  await setOperatorPassword(parsed.newPassword);
  revokeAllSessions();

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, issueSessionValue(), cookieOptions(request));
  logger.info('operator password changed; all other sessions revoked', { source });
  return response;
}
