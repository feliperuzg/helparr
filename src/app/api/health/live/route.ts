import { NextResponse } from 'next/server';

import { getDb } from '@/server/db';

/**
 * Unauthenticated liveness (REQ-DEPLOY-011 / AC12, OQ-4).
 *
 * The container `HEALTHCHECK` has no session and cannot be given one: baking a
 * cookie into an image is a secret in an image layer, which NFR3 forbids, and
 * pointing the healthcheck at the guarded `/api/health` would make every
 * container report unhealthy from its first tick until a human logged in.
 *
 * So the question is split rather than answered one way. This route says only
 * whether the process is up and the database opens. It does not say how many
 * instances exist, what they are called, or whether any of them is down —
 * and it cannot: the handler never imports the instance registry, the health
 * poller or any *arr client, so there is no code path from here to instance
 * topology to get wrong. `/api/health` keeps its full per-instance payload and
 * its session guard, unchanged.
 *
 * The status code carries the verdict here, which is the opposite of
 * `/api/health`'s "always 200, state is the payload". Deliberate: an
 * orchestrator reads the code, while `/api/health`'s consumer is TanStack Query
 * in the browser, which wants a 200 it can render from.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  try {
    // Cheap, but not free — it touches the keyed pages, so a database that
    // opened at startup and has since become unreadable answers "not alive"
    // rather than "alive because the handle object still exists".
    getDb().prepare('SELECT 1').get();
  } catch {
    // No detail, not even the error's message. An unauthenticated caller on
    // the LAN gets to learn that helparr is unhealthy, not why — the cause is
    // in the operator's logs, where it is already reported in full.
    return NextResponse.json(
      { status: 'error' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
