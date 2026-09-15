import { NextResponse, type NextRequest } from 'next/server';

/**
 * Presence check only — NOT the authorization control (REQ-AUTH-005).
 *
 * This runs on the Edge runtime, where the crypto used to verify the session
 * signature and the SQLite handle are both unavailable. It therefore checks
 * only that a session cookie exists, so an unauthenticated operator lands on
 * /login instead of on a page that will 401 its way to an empty state.
 *
 * Every protected route handler calls `requireSession()` independently. A
 * forged cookie gets past this and fails there.
 */

const SESSION_COOKIE = 'helparr_session';
const PUBLIC_PATHS = ['/login'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }

  // API routes get a 401 rather than a redirect — a fetch following a 302 to
  // an HTML login page produces a confusing JSON parse error at the call site.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets and the auth endpoints
    // (which must be reachable while unauthenticated).
    '/((?!_next/static|_next/image|favicon.ico|api/auth/).*)',
  ],
};
