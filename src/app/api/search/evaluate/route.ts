import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { evaluateRelease } from '@/server/search/grab';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The destination's own verdict on a release, on request only (ADR-5, T9).
 *
 * Never called automatically. `GET /api/v3/release` is a *live interactive
 * search* — it makes the instance query its own indexers and can take the better
 * part of a minute — so firing it for every visible row would turn a results
 * grid into a denial-of-service against the operator's own trackers.
 *
 * What comes back is why the instance would decline: "Existing file meets
 * cutoff", "Not a preferred word upgrade". Read before grabbing, not after.
 */

const evaluateSchema = z.object({
  instanceId: z.string().min(1),
  title: z.string().min(1).max(512),
  /** Matched first when present — a title can be rewritten, a hash cannot. */
  infoHash: z.string().min(1).max(128).nullable().default(null),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof evaluateSchema>;
  try {
    input = evaluateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid evaluate request.' }, { status: 400 });
  }

  const outcome = await evaluateRelease(
    input.instanceId,
    input.title,
    input.infoHash,
    request.signal,
  );
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  return NextResponse.json(outcome.value, { headers: { 'Cache-Control': 'no-store' } });
}
