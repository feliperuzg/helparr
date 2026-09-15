import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { readQueue } from '@/server/queue/aggregate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The unified queue read (ADR-8, T9).
 *
 * Always 200, even when every instance failed. `readQueue` has no failure mode
 * of its own — an unreadable instance becomes an entry in `errors` — and the
 * status code has to mean the same thing, because a non-2xx puts TanStack Query
 * into retry-and-backoff exactly when the screen most needs to keep rendering
 * the rows it did get (REQ-QUEUE-007).
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // The client's abort — a navigation away, or a refetch superseding this one —
  // is forwarded so the fan-out stops rather than holding sockets open against
  // every instance for a response nobody will read.
  const queue = await readQueue(request.signal);

  return NextResponse.json(queue, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
