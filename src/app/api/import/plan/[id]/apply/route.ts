import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { startImport } from '@/server/import/apply';
import { getImportPlan } from '@/server/import/store';
import { logger } from '@/server/logging/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The only route in this change that can import a file (ADR-5, ADR-6, ADR-7;
 * REQ-QUEUE-021/022, T8, T11).
 *
 * The body is `{ typedCount }` and the plan id is in the path — the same
 * discipline `rename/plan/[id]/apply` enforces and for the same reason: there
 * is no force or override field of any kind here (ADR-5's "the refusal is
 * whole and has no bypass"). Every file, mapping and candidate this route can
 * act on was persisted by `buildImportPlan`/`editImportRow` before this
 * request existed.
 */

const applySchema = z.object({
  // The count the operator typed, checked server-side against the plan's own
  // included-row count inside `startImport` — the dialog's own check is the
  // browser's opinion, this one is the server's (ADR-5).
  typedCount: z.number().int().min(0).max(100_000),
}).strict();

export async function POST(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let input: z.infer<typeof applySchema>;
  try {
    input = applySchema.parse(await request.json());
  } catch {
    // `.strict()` lands here too — an unrecognised field (a force flag, say)
    // is a rejected request, never a silently ignored one.
    return NextResponse.json({ error: 'Invalid apply request.' }, { status: 400 });
  }

  if (!getImportPlan(id)) {
    return NextResponse.json({ error: 'No such force-import plan.' }, { status: 404 });
  }

  // No `request.signal`: a navigation away mid-import must not cancel a
  // `ManualImport` command the instance may already be running — there is no
  // inverse operation, so an abandoned run with no recorded outcome would be
  // the worst available result (matches rename's apply route).
  const started = await startImport(id, input.typedCount);
  if (!started.ok) {
    if (started.error.kind === 'not-found') {
      return NextResponse.json({ error: started.error.reason }, { status: 404 });
    }

    // Every refusal is 409, whole-plan, naming the reason and what changed
    // (ADR-5). Nothing here distinguishes "count typo" from "drift" by status
    // code — the body is where that distinction lives.
    const { refusal } = started.error;
    logger.info('import apply refused', { planId: id, reason: refusal.reason });
    return NextResponse.json(
      { error: refusal.reason, refusal },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  logger.info('import apply started', { planId: id, rowCount: started.rowCount });

  // 202: the command is accepted and running, and the body says how many
  // files are in flight, never how many were imported — nothing may be
  // reported as imported until history says so (ADR-7). The caller polls
  // `GET /api/import/plan/:id` for outcomes.
  return NextResponse.json(
    { planId: id, rowCount: started.rowCount },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
