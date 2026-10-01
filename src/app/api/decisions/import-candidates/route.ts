import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { explainImportCandidates } from '@/server/decisions/explain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The queue's `import-rejected` cause, explained file by file (FR17, T19).
 *
 * Reads the download's own `manualimport` candidates and compares each one
 * the instance rejected against the file it would replace. Only on request:
 * the inspector calls this from a button, never on open.
 *
 * Always 200, like the other decisions routes: a failed read is a result the
 * panel renders, with the instance and the reason named (REQ-DEC-008).
 */

const schema = z.object({
  instanceId: z.string().min(1).max(256),
  downloadId: z.string().min(1).max(256),
}).strict();

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const result = await explainImportCandidates(input.instanceId, input.downloadId, request.signal);
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
