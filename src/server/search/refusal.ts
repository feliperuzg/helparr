import 'server-only';

import { NextResponse } from 'next/server';

import type { Refusal } from './grab';

/**
 * The one place a `Refusal` becomes a status code, shared by the three routes
 * that can produce one.
 *
 * These are 4xx on purpose, and they are the *only* 4xx on the grab path. A
 * refusal means the request could not be carried out as asked — the instance is
 * gone, or it is not something a release can be pushed into. An instance that
 * answered and said no is a 200 carrying its reasons (ADR-9), because those
 * reasons are what the operator opened the dialog to read.
 */
const STATUS: Record<Refusal['kind'], number> = {
  'no-instance': 404,
  'not-grabbable': 400,
  'no-url': 400,
};

export function refusalResponse(refusal: Refusal): NextResponse {
  return NextResponse.json(
    { error: refusal.reason, reason: refusal.kind },
    { status: STATUS[refusal.kind] },
  );
}
