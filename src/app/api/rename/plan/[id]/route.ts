import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { getPlan, setExcluded } from '@/server/rename/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The plan, whole, on every read (FR4, FR5, FR7; ADR-5; T8).
 *
 * This is the build poll and the applying poll and the final read — one shape
 * for all three, because the browser's job is to render whatever phase it finds
 * rather than to track which request it thinks it is making. `getPlan` retires
 * an over-age plan as it reads it, so an expired plan is reported as expired
 * here rather than being served as if it were still good.
 */
export async function GET(_request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const plan = getPlan(id);
  if (!plan) {
    return NextResponse.json({ error: 'No such rename plan.' }, { status: 404 });
  }

  return NextResponse.json(plan, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

const exclusionSchema = z.object({
  rowIds: z.array(z.string().min(1).max(256)).min(1).max(5_000),
  excluded: z.boolean(),
});

/**
 * Per-row and per-title exclusion (FR7, REQ-RENAME-009).
 *
 * The body names rows by *plan row id* — ids the server minted at build time —
 * never by file id. A caller cannot use this to introduce a file the plan does
 * not contain, because an unknown id matches nothing and the update is scoped
 * to one plan in its `WHERE` clause.
 *
 * `setExcluded` is guarded to `phase = 'ready'` inside the UPDATE, so an
 * exclusion arriving mid-apply changes nothing: the set of files being renamed
 * is fixed at the moment the typed count was accepted, which is the set the
 * operator read.
 */
export async function PATCH(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let input: z.infer<typeof exclusionSchema>;
  try {
    input = exclusionSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid exclusion request.' }, { status: 400 });
  }

  if (!getPlan(id)) {
    return NextResponse.json({ error: 'No such rename plan.' }, { status: 404 });
  }

  setExcluded(id, input.rowIds, input.excluded);

  // Re-read rather than returning the update's own count: `affectedFiles` is
  // what the typed-count gate checks against, and it has to come from the same
  // place on this response as it does on the poll.
  const plan = getPlan(id);
  if (!plan) {
    return NextResponse.json({ error: 'No such rename plan.' }, { status: 404 });
  }

  return NextResponse.json(plan, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
