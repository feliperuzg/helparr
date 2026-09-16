import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { grab } from '@/server/search/grab';
import { refusalResponse } from '@/server/search/refusal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The grab (FR7..FR9, REQ-OPS-001..004; ADR-6, ADR-9, T10).
 *
 * The first write helparr performs, and the only one in this change. It runs
 * once per confirmed dialog, it does not retry, and it records exactly one
 * operation row from whatever the instance answered.
 *
 * A rejected grab is HTTP 200. The instance was reached, it read the release,
 * and it declined with reasons — that is a successful request with a negative
 * answer, and the reasons are the whole point. Collapsing it into a 4xx/5xx
 * would hand the operator "grab failed" and throw away the sentence that says
 * why (FR9).
 */

const grabSchema = z.object({
  instanceId: z.string().min(1),
  title: z.string().min(1).max(512),
  // Not validated as a URL beyond being non-empty: it is Prowlarr's own proxy
  // link, and rejecting a shape helparr does not recognise would refuse a grab
  // Prowlarr would have honoured. `grab()` refuses only the empty case.
  downloadUrl: z.string().min(1).max(4096),
  protocol: z.enum(['torrent', 'usenet']),
  publishDate: z.string().min(1).max(64),
  indexer: z.string().max(128).nullable().default(null),
  /** What the confirmation showed the operator, carried into the log verbatim. */
  entityRef: z.string().max(256).nullable().default(null),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof grabSchema>;
  try {
    input = grabSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid grab request.' }, { status: 400 });
  }

  // No `request.signal`. Every other call in this change forwards the client's
  // abort; this one deliberately does not. A navigation away mid-push must not
  // cancel a request that may already have been accepted — the operator would
  // be left with a release in their download client and no row saying so.
  const outcome = await grab(input);
  if (!outcome.ok) return refusalResponse(outcome.refusal);

  return NextResponse.json(outcome.value, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
