import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ensureBootstrapPassword, hasOperatorPassword, verifyOperatorPassword } from '@/server/auth/password';
import { checkRateLimit, rateLimitSource, recordAttempt } from '@/server/auth/rateLimit';
import { SESSION_COOKIE, cookieOptions, issueSessionValue } from '@/server/auth/session';
import { logger } from '@/server/logging/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ password: z.string().min(1) });

export async function POST(request: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'A password is required.' }, { status: 400 });
  }

  const source = rateLimitSource(request.headers);

  await ensureBootstrapPassword();
  if (!hasOperatorPassword()) {
    return NextResponse.json(
      {
        error: 'No operator password is configured. Set HELPARR_INITIAL_PASSWORD and restart.',
      },
      { status: 503 },
    );
  }

  // Checked before the password is evaluated at all, so a throttled attempt
  // costs an attacker an argon2 verification they never get.
  const verdict = checkRateLimit(source);
  if (!verdict.allowed) {
    logger.warn('login throttled', { source });
    return NextResponse.json(
      { error: 'Too many failed attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } },
    );
  }

  const ok = await verifyOperatorPassword(parsed.password);
  recordAttempt(source, ok);

  if (!ok) {
    // Generic on purpose — the response must not hint at how close the
    // submitted value was, and the attempt itself is never logged.
    logger.info('login failed', { source });
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, issueSessionValue(), cookieOptions(request));
  logger.info('login succeeded', { source });
  return response;
}
