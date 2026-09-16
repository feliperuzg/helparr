import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { bulkSearch } from '@/server/gaps/search';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The confirmed bulk search (FR9, REQ-GAPS-008, -009; T12).
 *
 * A POST that is never issued implicitly: no refetch, no screen load and no
 * selection change reaches it. It exists only behind a dialog that has already
 * shown the operator the exact number of items and warned that this spends
 * indexer API quota.
 *
 * The response is per instance and says `queued`, never `found`. The instance
 * runs its own search; helparr only asked. The gaps stay on screen.
 */

const searchSchema = z.object({
  // Capped, because this is quota the operator is spending. The dialog does not
  // offer a selection this large, and a request that arrives with one is a
  // client that has gone wrong rather than an operator who meant it.
  gapIds: z.array(z.string().min(1).max(256)).min(1).max(500),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof searchSchema>;
  try {
    input = searchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid search request.' }, { status: 400 });
  }

  // No `request.signal`, as with every other write on this screen: once the
  // commands are out, an abort would only cost helparr the answer — the
  // instances would still be searching, and nothing would say so.
  const outcome = await bulkSearch(input.gapIds);
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  // 200 even when every instance failed. Each one is named with its own reason,
  // and collapsing a partial success into an error would hide the instances
  // that did accept their command.
  return NextResponse.json({ outcomes: outcome.value }, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
