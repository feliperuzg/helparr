#!/usr/bin/env node
/**
 * T11 / AC1–AC8, AC10 — verify the properties of the shipped image that no
 * test lane can see.
 *
 * The node lane runs against source. The a11y and e2e lanes boot
 * `.next/standalone/server.js` on the host, which is the right artifact but the
 * wrong environment: it cannot observe the runtime uid, the declared volume,
 * the traced Linux native bindings, or whether the layer contains application
 * source. Those are properties of an image, and an image is not something
 * vitest can assert about — so they are asserted here instead.
 *
 * Everything this script does is to throwaway resources: a uniquely named
 * container and volume, both removed on exit including on failure. It never
 * touches an operator's data, never reads ~/.helparr-verify.env, and never
 * contacts an *arr instance. The key and passwords it uses are generated fresh
 * per run and are never printed.
 *
 * Usage:
 *
 *   npm run build:image && npm run verify:image
 *
 * Or against a published tag:
 *
 *   IMAGE=ghcr.io/you/helparr:1.0.0 node scripts/verify-image.mjs
 *
 * Exit codes: 0 = every check passed, 1 = at least one failed, 2 = could not
 * run the checks at all (no Docker, image missing).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';

const IMAGE = process.env.IMAGE?.trim() || 'helparr:local';
const PORT = Number(process.env.VERIFY_PORT || 3991);
const BASE = `http://127.0.0.1:${PORT}`;

const suffix = randomUUID().slice(0, 8);
const CONTAINER = `helparr-verify-${suffix}`;
const VOLUME = `helparr-verify-${suffix}`;

// Generated per run, never printed, never written to a file. A verification
// script that leaves a known key behind on a developer's machine is a
// verification script that creates the problem it exists to rule out.
const KEY = randomBytes(24).toString('base64');
const FIRST_PASSWORD = `first-${randomBytes(12).toString('hex')}`;
const SECOND_PASSWORD = `second-${randomBytes(12).toString('hex')}`;

let failures = 0;
let checks = 0;

function pass(label, detail = '') {
  checks += 1;
  console.log(`  ok    ${label}${detail ? `  — ${detail}` : ''}`);
}

function fail(label, detail) {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
}

function assert(condition, label, detail) {
  if (condition) pass(label, typeof condition === 'string' ? condition : '');
  else fail(label, detail);
}

function docker(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${error.stderr || error.message}`);
  }
}

/**
 * Container logs, both streams. `docker logs` forwards the container's stdout
 * and stderr to its own, and helparr's startup failure is deliberately written
 * to stderr — so reading only stdout here would report "it exited, silently"
 * about a process that explained itself perfectly well.
 */
function dockerLogs(tail = 'all') {
  try {
    return execSync(`docker logs --tail ${tail} ${CONTAINER} 2>&1`, { encoding: 'utf8' }).trim();
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
  }
}

function inImage(shell) {
  return docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', shell], { allowFailure: true });
}

function removeContainer() {
  docker(['rm', '-f', CONTAINER], { allowFailure: true });
}

function cleanup() {
  removeContainer();
  docker(['volume', 'rm', '-f', VOLUME], { allowFailure: true });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitForLiveness(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health/live`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet. The container may also have exited — check, so a crashed
      // start fails in seconds instead of after the full timeout.
      const running = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { allowFailure: true });
      if (running === 'false') return false;
    }
    await sleep(500);
  }
  return false;
}

async function waitForExit(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { allowFailure: true }) === 'false') {
      // One more beat so the last stderr write lands in `docker logs`.
      await sleep(500);
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function waitForDockerHealthy(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = docker(['inspect', '-f', '{{.State.Health.Status}}', CONTAINER], { allowFailure: true });
    if (status === 'healthy') return true;
    if (status === 'unhealthy') return false;
    await sleep(1_000);
  }
  return false;
}

function startContainer(env = {}) {
  const args = [
    'run', '-d', '--name', CONTAINER,
    '-v', `${VOLUME}:/data`,
    '-p', `127.0.0.1:${PORT}:3000`,
  ];
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`);
  args.push(IMAGE);
  docker(args);
}

async function login(password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  return response.status;
}

// --- checks ---------------------------------------------------------------

function checkImageConfig() {
  console.log('\nImage configuration');

  const user = docker(['image', 'inspect', '-f', '{{.Config.User}}', IMAGE]);
  // AC4. "not empty and not 0" rather than "=== helparr", so renaming the user
  // does not fail a check whose subject is privilege, not naming.
  assert(user !== '' && user !== 'root' && user !== '0', 'runs as a non-root user', `Config.User is "${user}"`);

  const volumes = docker(['image', 'inspect', '-f', '{{json .Config.Volumes}}', IMAGE]);
  assert(volumes.includes('/data'), 'declares /data as a volume', `Config.Volumes is ${volumes}`);

  const healthcheck = docker(['image', 'inspect', '-f', '{{json .Config.Healthcheck}}', IMAGE]);
  assert(
    healthcheck.includes('healthcheck.mjs'),
    'declares a HEALTHCHECK that calls the liveness route',
    `Config.Healthcheck is ${healthcheck}`,
  );

  const entrypoint = docker(['image', 'inspect', '-f', '{{json .Config.Entrypoint}}', IMAGE]);
  assert(entrypoint.includes('start.mjs'), 'starts through the shared launcher', entrypoint);

  // The launcher defaults to loopback, which inside a container means
  // unreachable. Checked as an image property rather than by connecting,
  // because a published port would hide it: `docker run -p` forwards to the
  // container's interface, and a server bound to 127.0.0.1 inside would simply
  // refuse (FR6 / REQ-DEPLOY-006).
  const env = docker(['image', 'inspect', '-f', '{{json .Config.Env}}', IMAGE]);
  assert(env.includes('HOSTNAME=0.0.0.0'), 'overrides the loopback default for the container', env);
}

function checkImageContents() {
  console.log('\nImage contents (REQ-DEPLOY-003 / AC3)');

  // AC3, first half: no application source. TypeScript never reaches a runtime,
  // so a .ts or .tsx under /app that is not a type declaration means the build
  // copied the working tree in rather than the traced output.
  const source = inImage(
    "find /app -name '*.tsx' -not -path '*/node_modules/*' "
    + "-o -name '*.ts' -not -name '*.d.ts' -not -path '*/node_modules/*' | head -20",
  );
  assert(source === '', 'contains no application source', source.split('\n').slice(0, 3).join(', '));

  const dirs = inImage("for d in src test arx scripts .git; do [ -e /app/$d ] && echo $d; done; true");
  assert(dirs === '', 'contains no src/, test/, arx/ or scripts/ directory', dirs.replace(/\n/g, ', '));

  // AC3, second half: one dependency tree, not two. `next build`'s trace IS the
  // minimal node_modules, so a second top-level tree means an `npm ci` leaked
  // into the runner stage.
  const trees = inImage("find /app -mindepth 1 -maxdepth 1 -type d -name node_modules");
  assert(trees === '/app/node_modules', 'ships exactly one top-level node_modules', trees.replace(/\n/g, ', '));

  const nested = inImage("[ -e /app/.next/standalone ] && echo present; true");
  assert(nested === '', 'does not nest a second standalone output inside itself', nested);

  const dev = inImage(
    "for p in typescript eslint vitest @types/node; do [ -e /app/node_modules/$p ] && echo $p; done; true",
  );
  assert(dev === '', 'contains no dev dependencies', dev.replace(/\n/g, ', '));

  // AC6's precondition: the native bindings were traced, and they are Linux
  // ones, compiled in the builder rather than copied from a host.
  const native = inImage("find /app/node_modules -name '*.node' | head -20");
  assert(native.includes('better_sqlite3.node'), 'ships the traced SQLite native binding', native.replace(/\n/g, ' '));
  assert(
    !/darwin|win32/.test(native),
    'ships no host-platform native binding',
    native.split('\n').filter((l) => /darwin|win32/.test(l)).join(', '),
  );

  const statics = inImage("[ -d /app/.next/static ] && echo yes; true");
  assert(statics === 'yes', 'ships .next/static beside the server', statics);

  const publicDir = inImage("[ -d /app/public ] && echo yes; true");
  assert(publicDir === 'yes', 'ships public/', publicDir);
}

async function checkRunningContainer() {
  console.log('\nRunning container');

  startContainer({
    HELPARR_ENCRYPTION_KEY: KEY,
    HELPARR_INITIAL_PASSWORD: FIRST_PASSWORD,
  });

  const alive = await waitForLiveness();
  if (!alive) {
    fail('starts and answers liveness', dockerLogs(30));
    return false;
  }
  pass('starts and answers liveness without a session');

  const body = await (await fetch(`${BASE}/api/health/live`)).json();
  assert(
    JSON.stringify(Object.keys(body)) === '["status"]',
    'liveness reveals nothing but a status',
    JSON.stringify(body),
  );

  const guarded = await fetch(`${BASE}/api/health`, { redirect: 'manual' });
  assert(guarded.status === 401, 'the per-instance health endpoint still requires a session', `HTTP ${guarded.status}`);

  const healthy = await waitForDockerHealthy();
  assert(healthy, "Docker reports the container healthy", docker(['inspect', '-f', '{{json .State.Health}}', CONTAINER], { allowFailure: true }).slice(0, 300));

  const uid = docker(['exec', CONTAINER, 'id', '-u'], { allowFailure: true });
  assert(uid !== '0' && uid !== '', 'the process runs as a non-root uid', `uid ${uid}`);

  return true;
}

async function checkAssets() {
  console.log('\nAssets (AC2)');

  const page = await fetch(`${BASE}/login`, { redirect: 'manual' });
  if (!page.ok) {
    fail('serves the login page', `HTTP ${page.status}`);
    return;
  }
  const html = await page.text();
  pass('serves the login page');

  // AC2 is specifically about CSS *loading*, not about the HTML rendering — a
  // standalone image that forgot `.next/static` serves perfect markup and an
  // unstyled page, which is the failure this catches.
  const hrefs = [...html.matchAll(/href="([^"]*\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
  if (hrefs.length === 0) {
    fail('the page references a stylesheet', 'no /_next/static/*.css link in the HTML');
  } else {
    let ok = true;
    let bytes = 0;
    for (const href of hrefs) {
      const response = await fetch(new URL(href, BASE));
      const text = await response.text();
      bytes += text.length;
      if (!response.ok || text.length === 0) {
        ok = false;
        fail('every stylesheet loads', `${href} → HTTP ${response.status}, ${text.length} bytes`);
        break;
      }
    }
    if (ok) pass(`every stylesheet loads`, `${hrefs.length} file(s), ${bytes} bytes`);
  }

  const scripts = [...html.matchAll(/src="([^"]*\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  if (scripts.length === 0) {
    fail('the page references its client bundle', 'no /_next/static/*.js script in the HTML');
  } else {
    const response = await fetch(new URL(scripts[0], BASE));
    assert(response.ok, 'the client bundle loads', `${scripts[0]} → HTTP ${response.status}`);
  }

  // Served from public/, which is a separate copy in the Dockerfile from
  // .next/static and therefore a separate way to get the image wrong.
  const asset = await fetch(`${BASE}/icon-1024.png`);
  assert(asset.ok, 'files from public/ are served', `/icon-1024.png → HTTP ${asset.status}`);
}

async function checkEncryptedDatabase() {
  console.log('\nEncrypted database on the volume (AC6)');

  const listing = docker(['exec', CONTAINER, 'ls', '/data'], { allowFailure: true });
  assert(listing.includes('helparr.db'), 'the database is created under the declared volume', listing.replace(/\n/g, ' '));

  // The whole point of better-sqlite3-multiple-ciphers: a plaintext SQLite file
  // starts with the magic string "SQLite format 3". An encrypted one must not,
  // and a check that only asserts "the file exists" would pass either way.
  const header = docker(
    ['exec', CONTAINER, 'node', '-e',
      "const {readSync,openSync}=require('fs');const b=Buffer.alloc(16);readSync(openSync('/data/helparr.db','r'),b,0,16,0);console.log(b.toString('latin1'))"],
    { allowFailure: true },
  );
  assert(
    !header.startsWith('SQLite format 3'),
    'the database on disk is encrypted, not plaintext SQLite',
    `header starts "${header.slice(0, 16)}"`,
  );

  const status = await login(FIRST_PASSWORD);
  assert(status === 204, 'the operator can log in with the bootstrap password', `HTTP ${status}`);
}

async function checkRecreatePreservesData() {
  console.log('\nRecreate preserves data (AC5)');

  removeContainer();

  // A different bootstrap password on purpose. If the container came up on a
  // fresh database, this is the password that would work; if it came up on the
  // preserved one, bootstrap is skipped and the original still works. The pair
  // of assertions distinguishes "data survived" from "data was recreated",
  // which a single successful login could not.
  startContainer({
    HELPARR_ENCRYPTION_KEY: KEY,
    HELPARR_INITIAL_PASSWORD: SECOND_PASSWORD,
  });

  if (!await waitForLiveness()) {
    fail('starts again against the existing volume', dockerLogs(30));
    return;
  }
  pass('starts again against the existing volume');

  const migrated = dockerLogs();
  assert(
    !migrated.includes('applied schema migrations'),
    'runs no migrations against an already-current schema',
    'the second start re-applied migrations',
  );

  const original = await login(FIRST_PASSWORD);
  assert(original === 204, 'the original password still works after recreate', `HTTP ${original}`);

  const replacement = await login(SECOND_PASSWORD);
  assert(
    replacement === 401,
    'the new bootstrap password was ignored, so the database was not recreated',
    `HTTP ${replacement} — a fresh database would have accepted it`,
  );
}

async function checkStartupRefusals() {
  console.log('\nStartup refusals (AC7, AC10)');

  for (const [label, env, expected] of [
    ['a missing encryption key', {}, 'HELPARR_ENCRYPTION_KEY'],
    [
      'a base path the image was not built for',
      { HELPARR_ENCRYPTION_KEY: KEY, HELPARR_BASE_PATH: '/helparr' },
      'compiled',
    ],
  ]) {
    removeContainer();
    startContainer(env);
    // No liveness to wait for — the expectation is that it dies. Polled rather
    // than slept, because Next prints its ready banner before `register()` has
    // finished and a fixed wait reads the logs while the real message is still
    // on its way.
    await waitForExit();

    const running = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { allowFailure: true });
    const code = docker(['inspect', '-f', '{{.State.ExitCode}}', CONTAINER], { allowFailure: true });
    const logs = dockerLogs();

    assert(running === 'false' && code !== '0', `refuses to start with ${label}`, `running=${running} exit=${code}`);
    assert(
      logs.includes('helparr failed to start') && logs.includes(expected),
      `names the cause of ${label}`,
      logs.split('\n').filter(Boolean).slice(-4).join(' | '),
    );
  }
}

// --- main -----------------------------------------------------------------

async function main() {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    console.error('Docker is not available. Start it and re-run.');
    process.exit(2);
  }

  try {
    docker(['image', 'inspect', IMAGE]);
  } catch {
    console.error(`Image ${IMAGE} not found. Build it first:\n\n  npm run build:image\n`);
    process.exit(2);
  }

  console.log(`Verifying ${IMAGE}`);
  console.log(`  container ${CONTAINER}, volume ${VOLUME}, port ${PORT} (all removed on exit)`);

  checkImageConfig();
  checkImageContents();

  if (await checkRunningContainer()) {
    await checkAssets();
    await checkEncryptedDatabase();
    await checkRecreatePreservesData();
  }
  await checkStartupRefusals();

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED — this image does not meet the packaging requirements.`);
    process.exit(1);
  }
  console.log('\nThis image meets the packaging requirements.');
  process.exit(0);
}

process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}

main().catch((error) => {
  cleanup();
  console.error(`\nCould not complete the checks — ${error.message}`);
  process.exit(2);
});
