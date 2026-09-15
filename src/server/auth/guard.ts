import 'server-only';

import { NextResponse } from 'next/server';

import { hasValidSession } from './session';

/**
 * Handler-level authorization (REQ-AUTH-005 / ADR-3, AC11).
 *
 * Next.js guidance is explicit that middleware alone must not be relied on for
 * authorization: it runs before the route, but it is not a substitute for a
 * check where the data is actually read. So the split is —
 *
 *   middleware      cheap presence check, redirects to /login. A UX affordance.
 *   this guard      every handler that touches an instance or a credential
 *                   independently verifies the session. This is the control.
 *
 * A handler reachable without the middleware (a direct fetch, a rewrite, a
 * future route added outside the matcher) is still protected.
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (await hasValidSession()) return null;
  return NextResponse.json(
    { error: 'Authentication required.' },
    { status: 401 },
  );
}
