import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { QueueErrorKind } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { countsAsBreakerFailure, isArrQueueClient } from '@/server/clients/types';
import { buildImportPlan, type BuildImportPlanError } from '@/server/import/build';
import { importWriteEnabled } from '@/server/import/kinds';
import { clientFor } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen } from '@/server/resilience/breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Force-import plan creation (ADR-3, ADR-4, ADR-8; T7, T11).
 *
 * The body names an instance and a queue record, never a file or a mapping —
 * everything `buildImportPlan` persists comes from `manualimport`, the
 * instance's own read. There is no `building` phase to poll (`build.ts`'s own
 * doc comment): `manualimport` is one synchronous read, so this route returns
 * the finished plan directly rather than a bare id, unlike rename's `POST
 * /api/rename/plan`.
 *
 * The record's `downloadId` and resolved target label are not in the request
 * body — a caller cannot assert them, because a mistyped `downloadId` would
 * aim `manualimport` at a different download than the one the operator
 * opened. Both are read fresh from the instance's own queue, through the same
 * breaker every other queue read goes through (ADR-1 of `stuck-item-triage`'s
 * cause work).
 */

const createSchema = z.object({
  instanceId: z.string().min(1).max(256),
  recordId: z.number().int().positive(),
}).strict();

const QUEUE_READ_STATUS: Record<QueueErrorKind, number> = {
  unreachable: 502,
  unauthorized: 401,
  'upstream-error': 502,
  timeout: 504,
  // Never actually returned by a client — `fireOn`'s own `isCircuitOpen` is
  // checked first — but the type is total, so this table must be too.
  'circuit-open': 503,
};

const BUILD_STATUS: Record<BuildImportPlanError['kind'], number> = {
  // The instance was disabled or deleted between the queue read above and
  // `buildImportPlan`'s own lookup — a narrow race, reported the same way
  // `clientFor` reports it everywhere else.
  'instance-unavailable': 404,
  // The instance exists but cannot import files (wrong kind, or a capability
  // the client does not have) — a configuration fact, not a missing resource.
  unsupported: 409,
  // `manualimport` itself failed on a reachable, supported instance.
  upstream: 502,
};

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof createSchema>;
  try {
    input = createSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid force-import request.' }, { status: 400 });
  }

  const target = clientFor(input.instanceId);
  if (!target) {
    return NextResponse.json({ error: 'No such enabled instance.' }, { status: 404 });
  }
  if (!isArrQueueClient(target.client)) {
    return NextResponse.json(
      { error: `${target.label} has no queue to import from.` },
      { status: 404 },
    );
  }
  const client = target.client;

  const read = await fireOn(
    input.instanceId,
    () => client.queue(request.signal),
    { isFailure: countsAsBreakerFailure },
  ).catch((error: unknown) => {
    logger.warn('import plan queue read threw', { instanceId: input.instanceId, error });
    return null;
  });

  if (read === null) {
    return NextResponse.json({ error: 'The queue read did not complete.' }, { status: 502 });
  }
  if (isCircuitOpen(read)) {
    return NextResponse.json({ error: read.reason }, { status: 503 });
  }
  if (!read.ok) {
    return NextResponse.json(
      { error: read.error.reason },
      { status: QUEUE_READ_STATUS[read.error.kind] },
    );
  }

  const record = read.value.records.find((candidate) => candidate.recordId === input.recordId);
  if (!record) {
    return NextResponse.json({ error: 'No such queue record on that instance.' }, { status: 404 });
  }
  if (!record.downloadId) {
    return NextResponse.json(
      { error: 'This queue record has no download to import.' },
      { status: 409 },
    );
  }

  const result = await buildImportPlan({
    instanceId: input.instanceId,
    queueRecordId: input.recordId,
    downloadId: record.downloadId,
    // The resolved target, not the release name — "Nightfall Protocol (2024)",
    // matching `screen-force-import.md`'s header, not the file's own title.
    title: record.targetLabel,
  }, request.signal);

  if (!result.ok) {
    logger.info('import plan build refused', { instanceId: input.instanceId, kind: result.error.kind });
    return NextResponse.json(
      { error: result.error.reason },
      { status: BUILD_STATUS[result.error.kind] },
    );
  }

  logger.info('import plan built', { planId: result.plan.id, instanceId: input.instanceId, recordId: input.recordId });

  // The same shape every read of a plan returns, so the screen can seed its
  // cache from this response without a second round trip.
  const body = {
    ...result.plan,
    importing: false,
    writeEnabled: importWriteEnabled(result.plan.instanceKind),
  };
  return NextResponse.json(body, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' },
  });
}
