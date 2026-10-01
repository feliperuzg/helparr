import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { readUnmapped } from '@/server/unmapped/aggregate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unmapped root-folder entries across every Sonarr and Radarr (REQ-GAPS-025,
 * ADR-9).
 *
 * Always 200, even when every instance failed — the same contract as
 * `/api/queue` and `/api/gaps`. A failed instance is a row in the body with its
 * own error, not a status code, so the screen keeps rendering what it did get.
 *
 * `?refresh=1` is accepted for parity with the other reads, but the read is
 * uncached: every request already goes to the instances. The button exists so
 * the operator who just tidied a folder can ask again without a reload.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const unmapped = await readUnmapped(request.signal);

  return NextResponse.json(unmapped, { headers: { 'Cache-Control': 'no-store' } });
}
