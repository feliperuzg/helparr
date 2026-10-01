import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { evaluateReleases } from '@/server/decisions/explain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Gaps' "Evaluate releases" (ADR-13, REQ-GAPS-024).
 *
 * A POST because it is not free: the instance runs an interactive search
 * against its indexers, which spends their API quota. It is reached only from
 * the button whose label says so — never on open, never on a refetch.
 *
 * Exactly one of `episodeId` / `movieId`. Always 200 with `{ ok }`: a failure
 * names the instance and the reason, and the gap stays on screen.
 */

const evaluateSchema = z.object({
  instanceId: z.string().min(1).max(256),
  episodeId: z.number().int().positive().optional(),
  movieId: z.number().int().positive().optional(),
}).strict().refine(
  (input) => (input.episodeId === undefined) !== (input.movieId === undefined),
  'Exactly one of episodeId or movieId.',
);

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof evaluateSchema>;
  try {
    input = evaluateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid evaluate request.' }, { status: 400 });
  }

  const { instanceId, ...target } = input;
  const result = await evaluateReleases(instanceId, target, request.signal);

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
