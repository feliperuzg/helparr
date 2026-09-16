import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { readGaps } from '@/server/gaps/aggregate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The library gaps read (REQ-GAPS-001, -002, T8).
 *
 * Always 200, even when every instance failed — the same contract as
 * `/api/queue`, for the same reason. `readGaps` has no failure mode of its own,
 * and a non-2xx would put TanStack Query into retry-and-backoff at exactly the
 * moment the screen needs to keep rendering the rows it did get.
 *
 * `?refresh=1` forces the library join to be re-read rather than served from
 * its ten-minute cache (ADR-3). The operator who just added a series should not
 * have to wait out a TTL to see it.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const force = new URL(request.url).searchParams.get('refresh') === '1';

  // The client's abort is forwarded so the fan-out stops rather than holding
  // sockets open against every instance for a response nobody will read.
  const gaps = await readGaps({ force, signal: request.signal });

  return NextResponse.json(gaps, { headers: { 'Cache-Control': 'no-store' } });
}
