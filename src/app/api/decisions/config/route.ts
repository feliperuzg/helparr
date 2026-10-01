import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { getDecisionsConfig } from '@/server/decisions/configCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Re-read one instance's custom formats and quality profiles now (ADR-11).
 *
 * The cache holds them for ten minutes; this is the explainer's "Refresh"
 * control for the operator who just edited a profile and does not want to wait
 * out the TTL. Returns only when the config was read, with `fetchedAt` so the
 * screen can say how fresh it is. Always 200 with `{ ok }`.
 */

const refreshSchema = z.object({
  instanceId: z.string().min(1).max(256),
}).strict();

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof refreshSchema>;
  try {
    input = refreshSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid refresh request.' }, { status: 400 });
  }

  const result = await getDecisionsConfig(input.instanceId, { refresh: true }, request.signal);
  if (!result.ok) return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });

  return NextResponse.json(
    { ok: true, value: { fetchedAt: result.value.fetchedAt } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
