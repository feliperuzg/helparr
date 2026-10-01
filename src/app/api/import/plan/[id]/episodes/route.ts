import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { episodeChoices } from '@/server/import/build';
import { getImportPlan } from '@/server/import/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The series episode picker's source (ADR-4, `screen-force-import.md`'s
 * "Change…", T11). Read on demand when the picker opens, never pre-fetched
 * for every row (`episodeChoices`'s own doc comment, NFR2).
 *
 * 404 only when the plan itself is gone — anything `episodeChoices` could not
 * resolve from there (no series context yet, or the instance unreachable) is
 * a transient read failure rather than a missing resource, so it is reported
 * at 502 with the reason in the body rather than claimed as "not found".
 */
export async function GET(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  if (!getImportPlan(id)) {
    return NextResponse.json({ error: 'No such force-import plan.' }, { status: 404 });
  }

  const result = await episodeChoices(id, request.signal);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json(
    { episodes: result.episodes },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
