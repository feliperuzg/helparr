import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { NextRequest } from 'next/server';

import { cleanupTestDir } from './helpers/env';
import { GET as liveness } from '@/app/api/health/live/route';
import { proxy } from '@/proxy';
import { closeDb, getDb } from '@/server/db';

/**
 * T6 / REQ-DEPLOY-011, AC12; OQ-4.
 *
 * The container healthcheck is an unauthenticated caller on the LAN, and the
 * reason this route exists at all is that the alternatives were both wrong:
 * baking a session cookie into the image is a secret in an image layer, and
 * pointing the healthcheck at the guarded `/api/health` makes every fresh
 * container unhealthy until a human logs in.
 *
 * So what is asserted here is the pair of claims that make the split safe —
 * the route is reachable without a session, and it is *incapable* of naming an
 * instance rather than merely declining to.
 */

const ROUTE_PATH = join(process.cwd(), 'src/app/api/health/live/route.ts');

describe('liveness', () => {
  afterAll(() => {
    closeDb();
    cleanupTestDir();
  });

  it('answers 200 with nothing but a status', async () => {
    getDb();
    const response = liveness();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json() as Record<string, unknown>;
    // Exactly one key. Not "no instance names in the payload" — no payload to
    // put them in, so a future call site cannot quietly widen it.
    expect(Object.keys(body)).toEqual(['status']);
    expect(body.status).toBe('ok');
  });

  it('is reachable without a session cookie', () => {
    const response = proxy(new NextRequest('http://localhost/api/health/live'));
    // `next()` rather than the 401 every other /api/ path gets while
    // unauthenticated.
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not make the per-instance endpoint public along with it', async () => {
    const response = proxy(new NextRequest('http://localhost/api/health'));
    expect(response.status).toBe(401);

    // The prefix mistake this guards against would have been invisible: both
    // routes would work, and the guarded one would simply have stopped
    // guarding.
    const nested = proxy(new NextRequest('http://localhost/api/health/live/detail'));
    expect(nested.status).toBe(401);
  });

  it('cannot reach instance topology, structurally', () => {
    const source = readFileSync(ROUTE_PATH, 'utf8');
    const imports = source.match(/^import .*$/gm) ?? [];

    // Asserted against the source rather than the behaviour, because the
    // behavioural version can only show that today's code path does not name
    // an instance. This shows there is no path to one at all.
    for (const forbidden of ['instances/registry', 'health/poller', 'resilience/breaker', 'auth/guard']) {
      expect(imports.join('\n')).not.toContain(forbidden);
    }
    expect(imports.some((line) => line.includes('@/server/db'))).toBe(true);
  });

  it('reports 503, and only 503, when the database will not answer', async () => {
    closeDb();
    const db = getDb();
    // Closing the handle out from under the module simulates the case the
    // healthcheck exists for: the process is alive but its storage is not.
    db.close();

    const response = liveness();
    expect(response.status).toBe(503);

    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['status']);
    expect(body.status).toBe('error');
    // No message, no stack, no path. The cause is in the operator's logs.
    // ("error" itself is the status value, which is the whole vocabulary.)
    expect(JSON.stringify(body)).not.toMatch(/helparr\.db|SQLITE_|stack|closed/i);

    closeDb();
  });
});
