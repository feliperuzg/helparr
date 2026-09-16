import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { listIndexers } from '@/server/search/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The indexer roster for the toolbar chips (REQ-SEARCH-008, T8).
 *
 * This is also how the screen learns Prowlarr is down: the same
 * `SearchAvailability` body the search route returns on its outage branch, so
 * there is one outage renderer rather than two that can drift.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const availability = await listIndexers(request.signal);

  return NextResponse.json(availability, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
