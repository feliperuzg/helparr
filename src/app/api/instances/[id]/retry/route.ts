import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { getInstance } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { halfOpen } from '@/server/resilience/breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * `[Retry now]` — force a half-open probe ahead of schedule (ADR-5, T17).
 *
 * This does not itself contact the instance. It collapses the breaker's reset
 * window so the *next* read is allowed through, which keeps one code path
 * responsible for talking to instances. The operator sees the result on the
 * refresh that follows, which is also the honest thing to show: a probe that
 * succeeds in isolation but fails under the real read would be a worse lie than
 * a few seconds of waiting.
 */
export async function POST(_request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  if (!getInstance(id)) {
    return NextResponse.json({ error: 'No such instance.' }, { status: 404 });
  }

  halfOpen(id);
  logger.info('breaker half-open forced by operator', { instanceId: id });
  return new NextResponse(null, { status: 204 });
}
