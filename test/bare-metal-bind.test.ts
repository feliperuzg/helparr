import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * T23 / AC9 — FR6; REQ-DEPLOY-006.
 *
 * The bare-metal process binds loopback unless it is told otherwise.
 *
 * Next's standalone server defaults `HOSTNAME` to `0.0.0.0`, which for the
 * container target is correct and for this one is a self-hosted app holding the
 * API keys to an entire *arr stack, listening on every interface the host has.
 * `scripts/start.mjs` inverts that default, and this is the only place that
 * claim is checked against a socket rather than against a comment.
 *
 * Both halves matter. A server that refuses the external address because it
 * failed to start would pass the first assertion for the wrong reason, so the
 * second boot sets `HOSTNAME=0.0.0.0` and requires the same address to answer.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`), which is what
 * builds the standalone bundle this spawns.
 */

const LOOPBACK_PORT = 3982;
const EXPOSED_PORT = 3981;

/**
 * An IPv4 address this host answers on that is not 127.0.0.1 — the address a
 * machine on the LAN would use.
 *
 * A host with no such interface exists (an isolated CI container), and there
 * the external half of this test has nothing to say. It is reported rather than
 * silently skipped: "we could not check" and "we checked and it was fine" are
 * not the same result.
 */
function externalAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

let server: ChildProcess | null = null;
let dataDir: string | null = null;

/**
 * Boots the launcher the way an operator would: from the bundle, with the
 * environment they were given — and, crucially, without `HOSTNAME` unless the
 * caller sets it. `delete` rather than an empty string, because empty is a
 * value Next would try to bind.
 */
async function start(port: number, hostname?: string): Promise<string[]> {
  dataDir = mkdtempSync(join(tmpdir(), 'helparr-bind-'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    HELPARR_DB_PATH: join(dataDir, 'helparr.db'),
    HELPARR_ENCRYPTION_KEY: 'bind-test-encryption-key-0123456',
    HELPARR_INITIAL_PASSWORD: 'operator-password-for-the-bind-test',
    HELPARR_LOG_LEVEL: 'error',
  };
  delete env.HOSTNAME;
  if (hostname !== undefined) env.HOSTNAME = hostname;

  server = spawn(process.execPath, ['.next/standalone/start.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out: string[] = [];
  server.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => out.push(chunk.toString()));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/live`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`launcher never became ready:\n${out.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return out;
}

/** True when the address answers, false when the connection is refused. */
async function answers(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health/live`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe('the bare-metal listen address', { timeout: 120_000 }, () => {
  afterEach(async () => {
    if (server) {
      const exited = new Promise<void>((resolve) => { server?.once('exit', () => resolve()); });
      server.kill();
      await Promise.race([exited, new Promise((r) => { setTimeout(r, 10_000).unref(); })]);
      server = null;
    }
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it('binds loopback only when HOSTNAME is not set, and says so', async () => {
    const out = await start(LOOPBACK_PORT);

    expect(await answers(`http://127.0.0.1:${LOOPBACK_PORT}`), 'loopback did not answer').toBe(true);

    const external = externalAddress();
    expect(external, 'this host has no non-loopback IPv4 — the external half was not checked')
      .not.toBeNull();
    expect(
      await answers(`http://${external}:${LOOPBACK_PORT}`),
      `${external} answered — the process is listening beyond loopback`,
    ).toBe(false);

    // A default the operator can act on rather than one they have to discover
    // by failing to connect.
    expect(out.join('')).toContain('HOSTNAME not set');
  });

  it('listens everywhere when HOSTNAME says so', async () => {
    // The other half of FR6, and what makes the refusal above mean something:
    // the same build, the same address, reachable the moment it is asked for.
    await start(EXPOSED_PORT, '0.0.0.0');

    const external = externalAddress();
    expect(external).not.toBeNull();
    expect(
      await answers(`http://${external}:${EXPOSED_PORT}`),
      `${external} refused with HOSTNAME=0.0.0.0`,
    ).toBe(true);
  });
});
