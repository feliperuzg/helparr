import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { SearchResponse } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { runSearch } from '@/server/search/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The search fan-out (REQ-SEARCH-001..004, -007; ADR-9, T8).
 *
 * `POST` rather than `GET` because the criteria are a body — a list of indexer
 * ids and categories in a query string is a URL long enough to be truncated by
 * something in the middle — and because a search is not a cacheable read: it
 * costs every indexer a live query.
 *
 * Always 200 when the request itself is well-formed, including when every
 * indexer failed and including when Prowlarr is down. `lib/api.ts` throws on any
 * non-2xx, which would turn "LimeTorrents timed out, here are the other 183
 * results" into a generic transport error with both halves discarded.
 */

const searchSchema = z.object({
  query: z.string().min(1).max(512),
  // Prowlarr binds `indexerIds` as `List<int>`; a non-integer here would become
  // an HTTP 400 from Prowlarr with a message the operator cannot act on, so it
  // is rejected where the cause is still visible.
  indexerIds: z.array(z.number().int().positive()).max(64).default([]),
  categories: z.array(z.number().int().positive()).max(32).default([]),
  minSeeders: z.number().int().min(0).max(100_000).default(0),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let criteria: z.infer<typeof searchSchema>;
  try {
    criteria = searchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid search criteria.' }, { status: 400 });
  }

  // The client's abort — a superseding search, or a navigation away — is
  // forwarded so the indexers stop being queried for a response nobody will
  // read. An abandoned search still costs every tracker a real query.
  const outcome = await runSearch(criteria, request.signal);

  const body: SearchResponse = outcome.available
    ? { available: true, ...outcome.read }
    : { ...outcome.outage, available: false };

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
