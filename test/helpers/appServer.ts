import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

/**
 * Boots the real standalone build on a real port.
 *
 * Shared by every browser-lane test because they all need the same thing: the
 * production server, not a component harness. The properties these suites
 * assert — focus rings from the token cascade, a virtualized grid's rendered
 * row window, a DELETE that actually reaches an upstream — are all properties
 * of the built app, and jsdom resolves none of them.
 */

export interface AppServer {
  origin: string;
  /** The data directory this server booted against — pass it back to restart. */
  dataDir: string;
  close: () => Promise<void>;
}

export async function startApp(options: {
  port: number;
  password: string;
  /** Extra environment for the server process, e.g. the refresh interval. */
  env?: Record<string, string>;
  /**
   * An existing data directory to boot against, kept when the server closes.
   *
   * For the suites that assert something survives a restart: without it every
   * `startApp` gets a fresh database, and "it is still there afterwards" would
   * be a claim about a file that was never the same file.
   */
  dataDir?: string;
}): Promise<AppServer> {
  const origin = `http://127.0.0.1:${options.port}`;
  const dir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'helparr-e2e-'));
  const ownsDir = options.dataDir === undefined;

  const server: ChildProcess = spawn(process.execPath, ['.next/standalone/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(options.port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      HELPARR_DB_PATH: join(dir, 'helparr.db'),
      HELPARR_ENCRYPTION_KEY: 'e2e-encryption-key-0123456789abc',
      HELPARR_INITIAL_PASSWORD: options.password,
      HELPARR_LOG_LEVEL: 'error',
      ...options.env,
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/login`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      server.kill();
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
      throw new Error(`Standalone server never became ready on ${origin}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const exited = new Promise<void>((resolve) => { server.once('exit', () => resolve()); });

  return {
    origin,
    dataDir: dir,
    close: async () => {
      server.kill();
      // Awaited, not slept on. A successor booting on this port while the old
      // process is still listening finds the port taken and dies, and the
      // readiness probe then happily succeeds against the corpse — which is
      // indistinguishable from a healthy restart until the first request lands
      // on the process that was supposed to have replaced it.
      await Promise.race([
        exited,
        new Promise((resolve) => { setTimeout(resolve, 10_000).unref(); }),
      ]);
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function login(page: Page, origin: string, password: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.fill('#operator-password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${origin}/`);
}

/**
 * Seeds an instance through the real API, from inside the page so the session
 * cookie rides along. Going through /test first is not a shortcut around the
 * test-before-save gate — it is the gate, exercised the way the UI does it.
 */
export async function seedInstance(
  page: Page,
  kind: string,
  label: string,
  baseUrl: string,
  credential: unknown,
): Promise<void> {
  await page.evaluate(
    async ([k, l, url, cred]) => {
      const test = await fetch('/api/instances/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: k, baseUrl: url, credential: cred }),
      }).then((r) => r.json());

      if (test.outcome !== 'ok') throw new Error(`seed test failed: ${JSON.stringify(test)}`);

      const created = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: k, label: l, baseUrl: url, credential: cred, testToken: test.testToken,
        }),
      });
      if (!created.ok) throw new Error(`seed save failed: ${created.status}`);
    },
    [kind, label, baseUrl, credential] as const,
  );
}
