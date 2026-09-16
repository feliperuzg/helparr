import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { attach } from '@/server/gaps/attach';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manual attach — the only write on the gaps screen (FR6..FR8,
 * REQ-GAPS-010..013; ADR-1, ADR-7, T11).
 *
 * The body carries the gap and the pasted link, and nothing else. The title
 * that reaches `/release/push` is re-synthesized server-side from the gap the
 * id names — the browser gets to say *which* gap, never *what to call it*, so a
 * tampered client cannot decide what the operation is recorded as.
 *
 * A rejected attach is HTTP 200, for the same reason a rejected grab is: the
 * instance was reached, it read the release, and it declined with reasons. The
 * row stays listed in all three cases — accepted, rejected, failed — because
 * only a later library read can say whether the gap actually closed.
 */

const attachSchema = z.object({
  gapId: z.string().min(1).max(256),
  // A magnet or a `.torrent` URL. Shape-checked again in `attach()`, which
  // refuses anything else with a `no-url` refusal rather than pushing it.
  link: z.string().min(1).max(4096),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof attachSchema>;
  try {
    input = attachSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid attach request.' }, { status: 400 });
  }

  // No `request.signal`, matching `/api/grab` and for the same reason: a
  // navigation away mid-push must not cancel a request the instance may already
  // have accepted, which would leave a download running and no row saying so.
  const outcome = await attach(input);
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  return NextResponse.json(outcome.value, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
