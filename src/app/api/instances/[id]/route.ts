import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireSession } from '@/server/auth/guard';
import { credentialSchema } from '@/server/instances/credential';
import { deleteInstance, getInstance, updateInstance } from '@/server/instances/registry';
import { consumeTestToken } from '@/server/instances/testToken';
import { logger } from '@/server/logging/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  baseUrl: z.string().url().optional(),
  credential: credentialSchema.optional(),
  enabled: z.boolean().optional(),
  testToken: z.string().optional(),
});

export async function PATCH(request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const existing = getInstance(id);
  if (!existing) return NextResponse.json({ error: 'No such instance.' }, { status: 404 });

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid instance details.' }, { status: 400 });
  }

  // Toggling enabled is not a connection change, so it does not require a
  // fresh test — FR8 makes disable distinct from delete precisely so an
  // operator can silence a known-down instance without re-entering a key.
  const touchesConnection = parsed.baseUrl !== undefined || parsed.credential !== undefined;

  if (touchesConnection) {
    const verdict = consumeTestToken(parsed.testToken, {
      kind: existing.kind,
      baseUrl: parsed.baseUrl ?? existing.baseUrl,
      // A credential must be resupplied to change one; the stored value is
      // never read back out to build this binding.
      credential: parsed.credential!,
    });
    if (!verdict.valid) {
      return NextResponse.json(
        { error: 'Run a connection test for the new values before saving.', reason: verdict.reason },
        { status: 409 },
      );
    }
  }

  const instance = updateInstance(id, parsed);
  logger.info('instance updated', { id, connectionChanged: touchesConnection });
  return NextResponse.json({ instance });
}

export async function DELETE(_request: Request, { params }: Params) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  if (!deleteInstance(id)) {
    return NextResponse.json({ error: 'No such instance.' }, { status: 404 });
  }
  logger.info('instance removed', { id });
  return new NextResponse(null, { status: 204 });
}
