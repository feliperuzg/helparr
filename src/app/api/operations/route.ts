import { NextResponse } from 'next/server';

import { OPERATION_FILTERS, type OperationFilter } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { logger } from '@/server/logging/redact';
import { countOperations, listOperations, purgeOperations } from '@/server/operations/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The operation log viewer and its one deletion (REQ-OPS-003..006, T11).
 *
 * Reads are local — SQLite, no instance is contacted — so unlike every other
 * route in this change there is no degradation to report and no partial state
 * to describe.
 */

function filterFrom(url: string): OperationFilter | null {
  const raw = new URL(url).searchParams.get('filter');
  if (raw === null) return 'all';
  return (OPERATION_FILTERS as readonly string[]).includes(raw)
    ? (raw as OperationFilter)
    : null;
}

export async function GET(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const filter = filterFrom(request.url);
  if (filter === null) {
    return NextResponse.json({ error: 'Unknown outcome filter.' }, { status: 400 });
  }

  // `counts` is computed across the whole table, not the filtered rows, so the
  // chips keep reading "Failed 3" while the operator is looking at those three.
  return NextResponse.json(listOperations(filter), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * The purge — everything, or nothing.
 *
 * `expect` carries the row count the confirmation dialog showed. A mismatch is
 * 409, not a silent purge of a different number of rows: it means something was
 * written between the dialog opening and the operator confirming, so the
 * sentence they agreed to ("This deletes all 47 operation records, including
 * the 3 failures") no longer describes what would happen.
 *
 * This is the same reasoning as the removal flags (ADR-4) — a destructive
 * action must not depend on state the operator never saw. A UI-only gate would
 * be bypassed by this very request shape.
 */
export async function DELETE(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const raw = new URL(request.url).searchParams.get('expect');
  const expected = Number(raw);
  if (raw === null || !Number.isInteger(expected) || expected < 0) {
    return NextResponse.json(
      { error: 'A purge must state the number of rows it was confirmed against.' },
      { status: 400 },
    );
  }

  const current = countOperations();
  if (current !== expected) {
    return NextResponse.json(
      {
        error: 'The log changed since the confirmation was shown. Review it and purge again.',
        reason: 'stale',
        counts: listOperations('all').counts,
      },
      { status: 409 },
    );
  }

  const purged = purgeOperations();
  logger.info('operation log purged', { purged });

  return NextResponse.json({ purged }, { status: 200 });
}
