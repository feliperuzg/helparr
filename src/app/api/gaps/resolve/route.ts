import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { previewAttach, previewSeasonAttach } from '@/server/gaps/attach';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the destination makes of the name helparr would push (REQ-GAPS-011,
 * ADR-1, T11).
 *
 * Read-only: a synthesized title and a `GET /parse`, nothing that can write.
 * It exists because `/release/push` decides what a release *is* by parsing its
 * name — so the only honest confirmation is one that shows what the instance
 * resolved, not one that echoes the row the operator clicked.
 *
 * A POST despite being a read: the body carries the gap id, and the answer is
 * explicitly uncacheable.
 */

/**
 * Scope lives in the body, not in the path (ADR-7). `season` present means a
 * season-scoped pre-flight; absent means the episode one, which calls literally
 * the same function it called before this feature existed (FR9).
 *
 * Bounded rather than free: `-1` is not a season, and Sonarr's own numbering
 * starts at 0 for specials.
 */
const resolveSchema = z.object({
  gapId: z.string().min(1).max(256),
  season: z.number().int().min(0).max(999).optional(),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof resolveSchema>;
  try {
    input = resolveSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid resolve request.' }, { status: 400 });
  }

  const outcome = input.season === undefined
    ? await previewAttach(input.gapId, request.signal)
    : await previewSeasonAttach(input.gapId, input.season, request.signal);
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  // `resolved: false` and `matchesGap: false` are both 200s. The dialog has a
  // designed state for each, and the attach is still allowed from both — the
  // operator is told what the instance said and chooses.
  return NextResponse.json(outcome.value, { headers: { 'Cache-Control': 'no-store' } });
}
