import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { resolveTarget } from '@/server/search/grab';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the destination makes of a release name (REQ-OPS-007, ADR-3, T9).
 *
 * Read-only, and called once when the confirmation dialog opens. The *arr
 * decides what a pushed release *is* by parsing its title, so the only honest
 * way to tell the operator what they are about to grab into is to ask the
 * instance that will do the parsing — not to echo back the row they clicked.
 */

const resolveSchema = z.object({
  instanceId: z.string().min(1),
  title: z.string().min(1).max(512),
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

  const outcome = await resolveTarget(input.instanceId, input.title, request.signal);
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  // An unresolved target is `resolved: false`, not an error. The dialog has a
  // designed state for it and the grab is still allowed — the *arr may well
  // place a release its parser could not.
  return NextResponse.json(outcome.value, { headers: { 'Cache-Control': 'no-store' } });
}
