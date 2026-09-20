import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { isBootstrapCredential } from '@/server/auth/password';
import { probeAll } from '@/server/health/poller';

import type { HealthResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // The provenance answer is memoized per process, so riding this 60-second
  // poll costs one argon2 verify for the lifetime of the container rather than
  // one per poll (ADR-3).
  const [health, bootstrapCredential] = await Promise.all([
    probeAll(),
    isBootstrapCredential(),
  ]);

  const payload: HealthResponse = { ...health, bootstrapCredential };

  // Always 200. Per-instance state is the payload, not the status code — a 503
  // here would make one down instance look like helparr itself being down, and
  // would give TanStack Query a reason to retry the whole fan-out (FR10).
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
