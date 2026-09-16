import { NextResponse } from 'next/server';
import { z } from 'zod';

import { GAP_KINDS } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { readGapHistory } from '@/server/gaps/aggregate';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One item's history plus helparr's reading of it (REQ-GAPS-005, ADR-6, T8).
 *
 * A GET, and deliberately not part of `/api/gaps`: this is one upstream request
 * per item, so it happens when the operator opens the inspector on a row and
 * never while the grid is merely rendering.
 */

const historySchema = z.object({
  instanceId: z.string().min(1),
  kind: z.enum(GAP_KINDS),
  upstreamId: z.coerce.number().int().positive(),
});

export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const params = new URL(request.url).searchParams;
  let input: z.infer<typeof historySchema>;
  try {
    input = historySchema.parse({
      instanceId: params.get('instanceId'),
      kind: params.get('kind'),
      upstreamId: params.get('upstreamId'),
    });
  } catch {
    return NextResponse.json({ error: 'Invalid history request.' }, { status: 400 });
  }

  const outcome = await readGapHistory(
    input.instanceId,
    { kind: input.kind, upstreamId: input.upstreamId },
    request.signal,
  );
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  // An empty history is a 200 with an empty array and a null inference — the
  // inspector has a designed state for "nothing has been tried yet", and it is
  // the honest one. Inventing a reason to fill the panel is the failure ADR-6
  // exists to prevent.
  return NextResponse.json(outcome.value, { headers: { 'Cache-Control': 'no-store' } });
}
