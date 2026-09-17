import { NextResponse } from 'next/server';

import type { SavedSearchRun } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { runSavedSearch } from '@/server/search/query';
import { getSavedSearch, markSavedSearchRun } from '@/server/search/savedSearches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Re-running a saved search (FR11, FR12; REQ-SEARCH-012, -014; ADR-6, T14).
 *
 * `POST` with no body, and a route of its own rather than a flag on the
 * collection: this is the one saved-search operation that spends indexer quota,
 * and REQ-SEARCH-002 requires an explicit act to spend it. Selecting a saved
 * search in the UI does not come here — it resolves client-side against the
 * roster already in hand and waits for the operator to press Search.
 *
 * The response is always both halves (`SavedSearchRun`): the results and the
 * references that have since disappeared. `search` is null exactly when the
 * scope resolved to nothing, which is the case the spec requires the execute
 * action to be disabled for — and the reason travels in `resolution`, so the
 * screen never has to render a bare failure.
 */
export async function POST(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const saved = getSavedSearch(id);
  if (!saved) return NextResponse.json({ error: 'That saved search is gone.' }, { status: 404 });

  // The client's abort is forwarded for the same reason the plain search
  // forwards it: an abandoned search still costs every tracker a real query.
  const outcome: SavedSearchRun = await runSavedSearch(saved, request.signal);

  // Only when something was actually asked of the indexers. A refusal because
  // every reference is gone is not a run, and recording it as one would put a
  // timestamp on a search that never happened.
  if (outcome.search !== null) markSavedSearchRun(id);

  return NextResponse.json(outcome, { headers: { 'Cache-Control': 'no-store' } });
}
