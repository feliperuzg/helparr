import { NextResponse } from 'next/server';

import { requireSession } from '@/server/auth/guard';
import { readRenameTitles } from '@/server/rename/titles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the scope picker chooses from (FR1, T10).
 *
 * Always 200, even when every instance failed — the same contract as
 * `/api/gaps` and `/api/queue`, for the same reason. `readRenameTitles` has no
 * failure mode of its own, and a non-2xx would put TanStack Query into
 * retry-and-backoff at the moment the picker most needs to render the titles it
 * did get, alongside a line naming the instance it did not.
 *
 * A read, and only a read. Nothing on this path can rescan, preview or rename;
 * the only route that renames a file is `plan/[id]/apply` (NFR1).
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // The client's abort is forwarded so the fan-out stops rather than holding a
  // library-scale read open against every instance for a response nobody will
  // read.
  const read = await readRenameTitles({ signal: request.signal });

  return NextResponse.json(read, { headers: { 'Cache-Control': 'no-store' } });
}
