import { NextResponse } from 'next/server';

import { SESSION_COOKIE, cookieOptions, revokeAllSessions } from '@/server/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Server-side revocation, not just cookie deletion: REQ-AUTH-006 requires
  // that replaying the prior cookie is refused, which clearing the browser's
  // copy alone would not guarantee.
  revokeAllSessions();

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, '', { ...cookieOptions(request), maxAge: 0 });
  return response;
}
