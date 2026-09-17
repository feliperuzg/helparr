import { NextResponse } from 'next/server';
import { z } from 'zod';

import { SAVED_SEARCH_NAME_MAX } from '@/lib/savedSearch';
import { requireSession } from '@/server/auth/guard';
import { logger } from '@/server/logging/redact';
import {
  deleteSavedSearch,
  getSavedSearch,
  renameSavedSearch,
  SavedSearchError,
} from '@/server/search/savedSearches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Rename and delete for one saved search (REQ-SEARCH-015).
 *
 * `PATCH` accepts a name and nothing else. The definition is not editable in
 * place — see `renameSavedSearch` for why a query that can be rewritten under
 * an unchanged name is worse than a second saved search.
 */
const patchSchema = z.object({
  name: z.string().min(1).max(SAVED_SEARCH_NAME_MAX),
});

export async function PATCH(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid name.' }, { status: 400 });
  }

  try {
    const search = renameSavedSearch(id, parsed.name);
    return NextResponse.json({ search });
  } catch (error) {
    if (error instanceof SavedSearchError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  // Read before delete so the log line can name what went, and so a second
  // delete of the same id is a 404 rather than a silent 204 — the confirmation
  // named a search, and "it was already gone" is a different answer from "done".
  const existing = getSavedSearch(id);
  if (!existing || !deleteSavedSearch(id)) {
    return NextResponse.json({ error: 'That saved search is gone.' }, { status: 404 });
  }

  logger.info('saved search deleted', { id });
  return new NextResponse(null, { status: 204 });
}
