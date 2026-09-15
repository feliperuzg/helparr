import { NextResponse } from 'next/server';

import type { RemovalOutcome, RemovalRequest } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { countsAsBreakerFailure, isArrQueueClient } from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { fireOn, isCircuitOpen } from '@/server/resilience/breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ instanceId: string; recordId: string }> };

/**
 * Removal — the only write in this change (REQ-QUEUE-013, ADR-4, T10).
 *
 * One request per item. The batch lives in the client so that one failure in
 * three neither rolls back the two that succeeded nor reports the whole batch
 * as failed (`design/sequence-removal.md`).
 *
 * A *malformed* request is 4xx; a well-formed request whose upstream refused is
 * `200` carrying `status: 'failed'`. The distinction is deliberate: the first is
 * a bug in the caller, the second is an outcome the operator needs to read — and
 * `lib/api.ts` throws on any non-2xx, which would turn "Radarr said no" into a
 * generic transport error with the reason discarded.
 */

/**
 * Strict tri-state: `true`, `false`, or missing. Anything else — `"1"`, `"yes"`,
 * an empty string — is a malformed request rather than a value to coerce,
 * because every coercion rule here decides a destructive side effect.
 */
function flag(params: URLSearchParams, name: string): boolean | null {
  const raw = params.get(name);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function outcome(
  instanceId: string,
  recordId: number,
  reason: string | null,
): RemovalOutcome {
  return {
    instanceId,
    recordId,
    status: reason === null ? 'removed' : 'failed',
    reason,
  };
}

export async function DELETE(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { instanceId, recordId: rawRecordId } = await params;

  const recordId = Number(rawRecordId);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return NextResponse.json({ error: 'Invalid queue record id.' }, { status: 400 });
  }

  // All three flags are required (ADR-4). An omitted flag is a client bug, and
  // defaulting it here would make a destructive action depend on a default the
  // operator never saw in the preview.
  const query = new URL(request.url).searchParams;
  const flags: Partial<RemovalRequest> = {
    removeFromClient: flag(query, 'removeFromClient') ?? undefined,
    blocklist: flag(query, 'blocklist') ?? undefined,
    skipRedownload: flag(query, 'skipRedownload') ?? undefined,
  };
  const missing = (['removeFromClient', 'blocklist', 'skipRedownload'] as const)
    .filter((name) => flags[name] === undefined);
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: 'Every removal flag must be stated explicitly as true or false.',
        missing,
      },
      { status: 400 },
    );
  }

  const target = clientFor(instanceId);
  if (!target) {
    return NextResponse.json({ error: 'No such enabled instance.' }, { status: 404 });
  }
  if (!isArrQueueClient(target.client)) {
    return NextResponse.json(
      { error: `${target.label} has no queue to remove from.` },
      { status: 400 },
    );
  }
  const client = target.client;

  // Through the same per-instance breaker as the reads (ADR-1), so a removal
  // against a dead instance contributes to the one failure history the health
  // rail reports rather than to a second, invisible one.
  const result = await fireOn(
    instanceId,
    () => client.removeFromQueue(recordId, flags as RemovalRequest),
    { isFailure: countsAsBreakerFailure },
  ).catch((error: unknown) => {
    logger.warn('removal threw', { instanceId, recordId, error });
    return null;
  });

  if (result === null) {
    return NextResponse.json(
      outcome(instanceId, recordId, 'The removal did not complete.'),
      { status: 200 },
    );
  }
  if (isCircuitOpen(result)) {
    return NextResponse.json(outcome(instanceId, recordId, result.reason), { status: 200 });
  }
  if (!result.ok) {
    return NextResponse.json(outcome(instanceId, recordId, result.error.reason), { status: 200 });
  }

  logger.info('queue item removed', { instanceId, recordId, ...flags });
  return NextResponse.json(outcome(instanceId, recordId, null), { status: 200 });
}
