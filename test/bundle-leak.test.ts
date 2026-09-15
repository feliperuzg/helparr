import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * T17 / AC6 — nothing that talks to an instance reaches the browser.
 *
 * `project.md` allows a minimal auth story because helparr is LAN-first, but
 * it does not budge on one point: "API keys must never be exposed client-side
 * regardless". The BFF boundary is what enforces that, and a boundary is only
 * real if something checks it — an accidental `import` from a client component
 * would otherwise pull the *arr client, and the `X-Api-Key` header with it,
 * straight into a public chunk.
 *
 * This reads the actual build output rather than reasoning about imports, so
 * it catches leaks through re-exports and barrel files too.
 *
 * Gated behind HELPARR_BUNDLE_TEST because it needs `next build` to have run;
 * `npm run test:bundle` sets it. The gate is an env var rather than a
 * `skipIf` so a missing build fails loudly instead of passing silently.
 */

const CLIENT_DIR = join(process.cwd(), '.next', 'static');
const SERVER_DIR = join(process.cwd(), '.next', 'server');

/**
 * Each sentinel is a string that only server code has any business containing.
 * `HELPARR_ENCRYPTION_KEY` is deliberately NOT one: the Settings screen names
 * it in user-facing copy, and a variable name is not a secret.
 */
const SENTINELS = [
  'X-Api-Key',
  'better-sqlite3',
  'argon2',
  '/system/status',
  'CREATE TABLE instance',
];

function filesWithExt(dir: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(ext)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const read = (files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');

describe('client bundle boundary', () => {
  let clientSource = '';
  let serverSource = '';

  beforeAll(() => {
    if (!existsSync(CLIENT_DIR) || !existsSync(SERVER_DIR)) {
      throw new Error(
        `No build output at ${CLIENT_DIR}. Run \`npm run build\` before \`npm run test:bundle\`.`,
      );
    }
    clientSource = read(filesWithExt(CLIENT_DIR, '.js'));
    serverSource = read(filesWithExt(SERVER_DIR, '.js'));
  });

  it('shipped a client bundle worth inspecting', () => {
    // A negative assertion over an empty string passes for the wrong reason.
    // This pins the walk to something real before the real checks run.
    expect(filesWithExt(CLIENT_DIR, '.js').length).toBeGreaterThan(0);
    expect(clientSource).toContain('Settings');
  });

  it.each(SENTINELS)('keeps %s out of the browser', (sentinel) => {
    expect(clientSource).not.toContain(sentinel);
  });

  it.each(SENTINELS)('still has %s on the server, where it belongs', (sentinel) => {
    // The mirror of the test above. Without it, renaming a symbol would make
    // the leak check pass while silently testing nothing.
    expect(serverSource).toContain(sentinel);
  });

  it('does not inline the *arr API version paths into a client chunk', () => {
    // `/api/v1` vs `/api/v3` is the Prowlarr-versus-everything-else split, and
    // it only exists inside the server client. Seeing it in a chunk means the
    // browser is being set up to call an instance directly.
    expect(clientSource).not.toMatch(/['"`]\/api\/v[13]['"`]/);
  });

  it('never names the credential column in prerendered markup', () => {
    // RSC flight payloads are embedded in the prerendered HTML, so a server
    // component that over-fetched would leak through the HTML, not the JS.
    const html = read(filesWithExt(SERVER_DIR, '.html'));

    expect(html).not.toMatch(/"credential"\s*:/);
    expect(html).not.toMatch(/"apiKey"\s*:/);
  });
});
