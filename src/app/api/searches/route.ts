import { NextResponse } from 'next/server';
import { z } from 'zod';

import { SAVED_SEARCH_NAME_MAX } from '@/lib/savedSearch';
import { requireSession } from '@/server/auth/guard';
import { logger } from '@/server/logging/redact';
import {
  createSavedSearch,
  listSavedSearches,
  SavedSearchError,
} from '@/server/search/savedSearches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Saved searches (FR11, FR12; REQ-SEARCH-011, -013, -015; T14).
 *
 * `/api/searches`, plural, and separate from `/api/search`: this is a small CRUD
 * over local SQLite, and it must keep answering while Prowlarr is unreachable.
 * REQ-SEARCH-013 wants the definition back after a restart, and a restart is
 * precisely the moment nothing upstream has answered yet — so nothing on this
 * route touches an indexer. Re-running, which does, lives at
 * `/api/searches/[id]/run`.
 */

/**
 * The same criteria vocabulary `POST /api/search` validates, plus the name.
 *
 * `indexers` carries `{indexerId, name}` rather than bare ids because a
 * reference that cannot be named cannot be reported as missing (ADR-6,
 * REQ-SEARCH-014). The name is the browser's — it comes from the roster the
 * chip was rendered from — and it is stored verbatim, not re-derived here: the
 * point is to record what the indexer was called *then*.
 */
const refSchema = z.object({
  indexerId: z.number().int().positive(),
  name: z.string().min(1).max(128),
});

const createSchema = z.object({
  name: z.string().min(1).max(SAVED_SEARCH_NAME_MAX),
  query: z.string().min(1).max(512),
  indexers: z.array(refSchema).max(64).default([]),
  categories: z.array(z.number().int().positive()).max(32).default([]),
  minSeeders: z.number().int().min(0).max(100_000).default(0),
});

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  return NextResponse.json(
    { searches: listSavedSearches() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid saved search.' }, { status: 400 });
  }

  try {
    const search = createSavedSearch(input);
    // The name and the scope size, never the query: what an operator searches
    // their indexers for is the one field on this route that is nobody else's
    // business, including a log reader's.
    logger.info('saved search created', { id: search.id, indexers: search.indexers.length });
    return NextResponse.json({ search }, { status: 201 });
  } catch (error) {
    if (error instanceof SavedSearchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
