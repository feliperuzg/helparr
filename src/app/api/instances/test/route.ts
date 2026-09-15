import { NextResponse } from 'next/server';
import { z } from 'zod';

import { INSTANCE_KINDS, type TestOutcome } from '@/lib/types';
import { requireSession } from '@/server/auth/guard';
import { buildClient } from '@/server/instances/registry';
import { credentialSchema } from '@/server/instances/credential';
import { issueTestToken } from '@/server/instances/testToken';
import { logger } from '@/server/logging/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  kind: z.enum(INSTANCE_KINDS),
  baseUrl: z.string().url(),
  credential: credentialSchema,
});

/**
 * Connection test (REQ-INST-002, REQ-INST-003 / FR2, AC2–AC4).
 *
 * The response carries a token bound to the exact tuple that was tested. That
 * token is what the save endpoint requires — which is why the test-before-save
 * rule survives a caller who never opens the UI.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid connection details.' }, { status: 400 });
  }

  // A test is not a persisted instance, so there is no id yet. A synthetic one
  // keeps the qBittorrent session cache from colliding with a saved instance's.
  const probeId = `test:${parsed.kind}:${parsed.baseUrl}`;
  const client = buildClient(probeId, parsed.kind, parsed.baseUrl, parsed.credential);
  const result = await client.probe();

  logger.info('connection test', { kind: parsed.kind, outcome: result.state });

  const outcome: TestOutcome = result.state === 'ok'
    ? {
      outcome: 'ok',
      version: result.version,
      latencyMs: result.latencyMs,
      testToken: issueTestToken({
        kind: parsed.kind,
        baseUrl: parsed.baseUrl,
        credential: parsed.credential,
      }),
    }
    : result.state === 'unauthorized'
      ? { outcome: 'unauthorized', reason: result.reason }
      : result.state === 'unreachable'
        ? { outcome: 'unreachable', reason: result.reason }
        : { outcome: 'unexpected-response', reason: result.reason };

  // Always 200 — the outcome is the payload, not the status. A failed test is
  // a successful request that reports a negative result.
  return NextResponse.json(outcome);
}
