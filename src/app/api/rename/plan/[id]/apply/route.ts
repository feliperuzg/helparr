import { NextResponse } from 'next/server';
import { z } from 'zod';

import type { RenameRefusal } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { logger } from '@/server/logging/redact';
import { startApply } from '@/server/rename/apply';
import { getPlan } from '@/server/rename/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The only route in helparr that can rename a file (NFR1, REQ-RENAME-010..011;
 * T8).
 *
 * The body is `{ typedCount }` and the plan id is in the path. That is the
 * whole request — and it is what makes "no rename command is constructible
 * without a plan" a property of the data flow rather than a check someone could
 * forget to write. There is no file-ID field here for a caller to populate, no
 * title field, and no force flag. `RenameCommandRequest` is assembled inside
 * `apply.ts` from rows the server itself persisted at build time, so the
 * strongest thing a tampered client can do is name a different plan id or a
 * wrong count, and both are refused below.
 *
 * There is deliberately no bypass parameter (ADR-8, NFR3). The prototype's
 * "this step can be turned off in Settings" is not implemented anywhere,
 * including here.
 */

const applySchema = z
  .object({
    // The count the operator typed. Checked against the plan's own
    // non-excluded row count server-side — the dialog's check is the browser's
    // opinion, this one is the server's.
    typedCount: z.number().int().min(0).max(100_000),
  })
  .strict();

const STATUS: Record<RenameRefusal['kind'], number> = {
  // The plan is gone or too old: the thing being addressed no longer exists in
  // a usable state, and the only control offered is regeneration.
  expired: 409,
  // The library moved under the preview. Nothing was renamed.
  'precondition-drift': 409,
  // Every row excluded — a well-formed request asking for no work.
  empty: 400,
};

export async function POST(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let input: z.infer<typeof applySchema>;
  try {
    input = applySchema.parse(await request.json());
  } catch {
    // `.strict()` lands here too, so an unexpected field is a rejected request
    // rather than a silently ignored one. On this route in particular, a caller
    // sending something helparr does not recognise should be told no.
    return NextResponse.json({ error: 'Invalid apply request.' }, { status: 400 });
  }

  if (!getPlan(id)) {
    return NextResponse.json({ error: 'No such rename plan.' }, { status: 404 });
  }

  // No `request.signal`. A navigation away mid-apply must not cancel commands
  // the instances may already be executing — there is no inverse operation, so
  // an abandoned apply with no record of it is the worst available outcome.
  const started = await startApply(id, input.typedCount);
  if (!started.ok) {
    logger.info('rename apply refused', { planId: id, kind: started.refusal.kind });
    return NextResponse.json(
      { error: started.refusal.reason, reason: started.refusal.kind, drifted: started.refusal.drifted },
      { status: STATUS[started.refusal.kind], headers: { 'Cache-Control': 'no-store' } },
    );
  }

  logger.info('rename apply started', { planId: id, rowCount: started.rowCount });

  // 202, and the body says how many files are in flight rather than how many
  // were renamed. Nothing may be reported as renamed until its own evidence
  // exists (REQ-RENAME-015), and that evidence is a preview re-run that has not
  // happened yet. The caller polls `GET /api/rename/plan/:id` for outcomes.
  return NextResponse.json(
    { planId: id, rowCount: started.rowCount },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
