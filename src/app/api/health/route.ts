import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { probeAll } from '@/server/health/poller';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const health = await probeAll();

  // Always 200. Per-instance state is the payload, not the status code — a 503
  // here would make one down instance look like helparr itself being down, and
  // would give TanStack Query a reason to retry the whole fan-out (FR10).
  return NextResponse.json(health, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
