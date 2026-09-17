import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { startBuild } from '@/server/rename/build';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Plan creation (FR1..FR3, REQ-RENAME-001..005; T8).
 *
 * Returns a plan id immediately and builds behind it. A scope of a dozen titles
 * means a dozen rescans, each of which the instance queues and runs at its own
 * pace — holding the request open for that would time out at the proxy long
 * before the plan was ready, and the operator would have no id to poll with.
 *
 * Nothing here is destructive. This route issues rescans and previews; it
 * cannot rename anything, and the plan it creates is inert until
 * `POST /api/rename/plan/:id/apply` names it.
 */

const scopeSchema = z.object({
  // Bounded because every entry costs a rescan and a preview against a live
  // instance. Fifty is well past what FR1's picker can express and still
  // finishes inside the build's own patience.
  scope: z
    .array(
      z.object({
        instanceId: z.string().min(1).max(256),
        kind: z.enum(['series', 'movie']),
        upstreamId: z.number().int().positive(),
        label: z.string().min(1).max(512),
      }),
    )
    .min(1)
    .max(50),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof scopeSchema>;
  try {
    input = scopeSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid rename scope.' }, { status: 400 });
  }

  // Duplicates would double a title's rescan and put two copies of every row in
  // the plan, which the typed count would then ask the operator to confirm.
  const seen = new Set<string>();
  const scope = input.scope.filter((entry) => {
    const key = `${entry.instanceId}\0${entry.kind}\0${entry.upstreamId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const planId = startBuild(scope);

  // 202: the work is accepted and running, and the body carries the only thing
  // the caller can act on. A 200 would claim the plan is ready to read.
  return NextResponse.json(
    { planId },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
