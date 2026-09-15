import { NextResponse } from 'next/server';
import { z } from 'zod';

import { INSTANCE_KINDS } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { credentialSchema } from '@/server/instances/credential';
import { assertCredentialMatchesKind, createInstance, listInstances } from '@/server/instances/registry';
import { consumeTestToken } from '@/server/instances/testToken';
import { logger } from '@/server/logging/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // `listInstances` returns InstanceDto, which has no credential field — the
  // response cannot carry one even by accident (AC6).
  return NextResponse.json({ instances: listInstances() });
}

const createSchema = z.object({
  kind: z.enum(INSTANCE_KINDS),
  label: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  credential: credentialSchema,
  enabled: z.boolean().optional(),
  testToken: z.string().optional(),
});

export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let parsed: z.infer<typeof createSchema>;
  try {
    parsed = createSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid instance details.' }, { status: 400 });
  }

  try {
    assertCredentialMatchesKind(parsed.kind, parsed.credential);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Credential type mismatch.' },
      { status: 400 },
    );
  }

  // FR2 enforced server-side. A UI-only gate would be bypassed by this very
  // request shape.
  const verdict = consumeTestToken(parsed.testToken, {
    kind: parsed.kind,
    baseUrl: parsed.baseUrl,
    credential: parsed.credential,
  });

  if (!verdict.valid) {
    const message = {
      missing: 'Run a connection test before saving.',
      expired: 'The connection test has expired. Run it again.',
      stale: 'These values differ from the ones that were tested. Run the test again.',
    }[verdict.reason];
    return NextResponse.json({ error: message, reason: verdict.reason }, { status: 409 });
  }

  try {
    const instance = createInstance(parsed);
    logger.info('instance created', { id: instance.id, kind: instance.kind });
    return NextResponse.json({ instance }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to save the instance.';
    const conflict = message.includes('UNIQUE');
    return NextResponse.json(
      { error: conflict ? 'An instance of that kind and label already exists.' : message },
      { status: conflict ? 409 : 500 },
    );
  }
}
