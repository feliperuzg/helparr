import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import './helpers/env';
import { cleanupTestDir } from './helpers/env';

/**
 * Operator password rotation (REQ-AUTH-009, REQ-AUTH-010, REQ-AUTH-011,
 * REQ-AUTH-008).
 *
 * The claims worth testing here are the ones that are easy to get wrong and
 * silent when they are:
 *
 *   - the ghost session — a device that was signed in before the change must be
 *     refused afterwards (CWE-613), which is the entire point of the feature;
 *   - the acting client survives, because the revocation mechanism is
 *     all-or-nothing and the naive ordering signs the operator out of the
 *     browser they just used;
 *   - a refusal revokes nothing, so a typo cannot be turned into a
 *     denial-of-service against every other device;
 *   - the bootstrap value stays inert across restarts, and the deliberate reset
 *     fires exactly once per time it is asked for.
 */

/** The session the route reads. Swapped per test. */
let cookieValue: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieValue === undefined ? undefined : { name, value: cookieValue }),
  }),
}));

const { POST: changePassword } = await import('@/app/api/auth/password/route');
const {
  ensureBootstrapPassword,
  hasOperatorPassword,
  isBootstrapCredential,
  resetBootstrapProbe,
  setOperatorPassword,
  verifyOperatorPassword,
} = await import('@/server/auth/password');
const { checkRateLimit, recordAttempt } = await import('@/server/auth/rateLimit');
const { issueSessionValue, verifySessionValue, SESSION_COOKIE } = await import('@/server/auth/session');
const { resetConfigCache } = await import('@/server/config');
const { closeDb, getDb } = await import('@/server/db');

const CURRENT = 'the-original-operator-password';
const REPLACEMENT = 'a-replacement-operator-password';

/**
 * A distinct source per test. Every request in this file would otherwise share
 * `pwchange:unknown`, so five deliberate refusals in one test would throttle
 * the next one for fifteen minutes.
 */
function post(body: unknown, source: string): Promise<Response> {
  return changePassword(new Request('http://helparr.local/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': source },
    body: JSON.stringify(body),
  }));
}

/** The session the route handed back, or undefined when it handed none back. */
function issuedCookie(response: Response): string | undefined {
  const header = response.headers.get('set-cookie');
  if (!header) return undefined;
  return header.split(';')[0]!.slice(`${SESSION_COOKIE}=`.length);
}

describe('operator password rotation', () => {
  beforeAll(async () => {
    await setOperatorPassword(CURRENT);
  });

  it('refuses an unauthenticated change even with the correct current password', async () => {
    cookieValue = undefined;
    const survivor = issueSessionValue();

    const response = await post(
      { currentPassword: CURRENT, newPassword: REPLACEMENT },
      '10.1.0.1',
    );

    expect(response.status).toBe(401);
    // The refusal must not reveal that the current password was right, and must
    // not have had any effect on the way out.
    await expect(verifyOperatorPassword(CURRENT)).resolves.toBe(true);
    expect(verifySessionValue(survivor)).toBe(true);
  });

  it('refuses a wrong current password and revokes nothing (REQ-AUTH-010)', async () => {
    cookieValue = issueSessionValue();
    const otherDevice = issueSessionValue();

    const response = await post(
      { currentPassword: 'not-the-current-password', newPassword: REPLACEMENT },
      '10.1.0.2',
    );

    expect(response.status).toBe(401);
    await expect(verifyOperatorPassword(CURRENT)).resolves.toBe(true);
    expect(verifySessionValue(cookieValue)).toBe(true);
    expect(verifySessionValue(otherDevice)).toBe(true);
  });

  it('refuses a new password below the shared minimum length', async () => {
    cookieValue = issueSessionValue();

    const response = await post({ currentPassword: CURRENT, newPassword: 'short' }, '10.1.0.3');

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/8 characters/);
    await expect(verifyOperatorPassword(CURRENT)).resolves.toBe(true);
  });

  it('replaces the password, kills the ghost session, and keeps the caller signed in', async () => {
    cookieValue = issueSessionValue();
    const otherDevice = issueSessionValue();
    expect(verifySessionValue(otherDevice)).toBe(true);

    const response = await post(
      { currentPassword: CURRENT, newPassword: REPLACEMENT },
      '10.1.0.4',
    );

    expect(response.status).toBe(204);

    await expect(verifyOperatorPassword(REPLACEMENT)).resolves.toBe(true);
    await expect(verifyOperatorPassword(CURRENT)).resolves.toBe(false);

    // CWE-613. The other device held a valid cookie a moment ago.
    expect(verifySessionValue(otherDevice)).toBe(false);
    // …and so did this one, which is why a fresh cookie had to come back.
    expect(verifySessionValue(cookieValue)).toBe(false);

    const fresh = issuedCookie(response);
    expect(fresh).toBeDefined();
    expect(verifySessionValue(fresh!)).toBe(true);
  });

  it('throttles on its own namespace, leaving the login window alone (ADR-6)', async () => {
    const source = '10.1.0.5';
    cookieValue = issueSessionValue();

    for (let i = 0; i < 5; i += 1) {
      const refused = await post({ currentPassword: 'wrong', newPassword: REPLACEMENT }, source);
      expect(refused.status).toBe(401);
    }

    const throttled = await post({ currentPassword: 'wrong', newPassword: REPLACEMENT }, source);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('Retry-After'))).toBeGreaterThan(0);

    // The bare address — what login throttles on — is untouched by any of that.
    expect(checkRateLimit(source).allowed).toBe(true);
  });

  it('cannot clear a login throttle by succeeding (ADR-6)', async () => {
    const source = '10.1.0.6';
    cookieValue = issueSessionValue();

    // Five failed *logins* from this address: the window a rotation must not
    // be able to wipe.
    for (let i = 0; i < 5; i += 1) recordAttempt(source, false);
    expect(checkRateLimit(source).allowed).toBe(false);

    const response = await post(
      { currentPassword: REPLACEMENT, newPassword: CURRENT },
      source,
    );
    expect(response.status).toBe(204);

    expect(checkRateLimit(source).allowed).toBe(false);
  });

  it('keeps both passwords out of the logs at the most verbose level', async () => {
    process.env.HELPARR_LOG_LEVEL = 'debug';
    resetConfigCache();
    resetBootstrapProbe();

    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((v) => { lines.push(String(v)); });
    const err = vi.spyOn(console, 'error').mockImplementation((v) => { lines.push(String(v)); });

    try {
      cookieValue = issueSessionValue();
      // One success and one refusal — the two paths that log at all.
      await post({ currentPassword: 'wrong-on-purpose', newPassword: REPLACEMENT }, '10.1.0.7');
      await post({ currentPassword: CURRENT, newPassword: REPLACEMENT }, '10.1.0.7');
    } finally {
      log.mockRestore();
      err.mockRestore();
      process.env.HELPARR_LOG_LEVEL = 'error';
      resetConfigCache();
      resetBootstrapProbe();
    }

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(CURRENT);
      expect(line).not.toContain(REPLACEMENT);
      expect(line).not.toContain('wrong-on-purpose');
    }
  });
});

describe('bootstrap inertness and deliberate reset (REQ-AUTH-008)', () => {
  const BOOTSTRAP = 'the-provisioned-bootstrap-password';

  function reconfigure(env: { initial?: string; reset?: string }): void {
    if (env.initial === undefined) delete process.env.HELPARR_INITIAL_PASSWORD;
    else process.env.HELPARR_INITIAL_PASSWORD = env.initial;

    if (env.reset === undefined) delete process.env.HELPARR_PASSWORD_RESET;
    else process.env.HELPARR_PASSWORD_RESET = env.reset;

    resetConfigCache();
    resetBootstrapProbe();
  }

  afterEach(() => {
    reconfigure({});
  });

  afterAll(() => {
    closeDb();
    cleanupTestDir();
  });

  it('bootstraps only when no password exists', async () => {
    getDb().prepare('DELETE FROM operator').run();
    expect(hasOperatorPassword()).toBe(false);

    reconfigure({ initial: BOOTSTRAP });
    await ensureBootstrapPassword();

    expect(hasOperatorPassword()).toBe(true);
    await expect(verifyOperatorPassword(BOOTSTRAP)).resolves.toBe(true);
  });

  it('reports the credential as provisional until it is replaced (REQ-AUTH-011)', async () => {
    reconfigure({ initial: BOOTSTRAP });
    await expect(isBootstrapCredential()).resolves.toBe(true);

    await setOperatorPassword(REPLACEMENT);
    // No reconfigure: the variable is still set, exactly as it would be in a
    // compose file. The answer has to change anyway.
    await expect(isBootstrapCredential()).resolves.toBe(false);
  });

  it('stays inert across a restart while the bootstrap value is still supplied', async () => {
    reconfigure({ initial: BOOTSTRAP });

    await ensureBootstrapPassword();

    await expect(verifyOperatorPassword(REPLACEMENT)).resolves.toBe(true);
    await expect(verifyOperatorPassword(BOOTSTRAP)).resolves.toBe(false);
  });

  it('honours the deliberate reset exactly once per time it is requested', async () => {
    reconfigure({ initial: BOOTSTRAP, reset: '1' });

    await ensureBootstrapPassword();
    await expect(verifyOperatorPassword(BOOTSTRAP)).resolves.toBe(true);

    // The operator recovers, changes the password, and leaves the flag in the
    // compose file — the failure mode the consumed marker exists to prevent.
    await setOperatorPassword(REPLACEMENT);

    // Two more restarts with the flag still set. Neither may undo the change:
    // one standing flag is one request, and it has already been honoured.
    await ensureBootstrapPassword();
    await ensureBootstrapPassword();

    await expect(verifyOperatorPassword(REPLACEMENT)).resolves.toBe(true);
    await expect(verifyOperatorPassword(BOOTSTRAP)).resolves.toBe(false);
  });

  it('re-arms recovery when the flag is removed, not when the password is written', async () => {
    // Continues from the state above: the marker is set and REPLACEMENT is in
    // force. Removing the flag is the operator saying the request is over.
    reconfigure({ initial: BOOTSTRAP });
    await ensureBootstrapPassword();
    await expect(verifyOperatorPassword(REPLACEMENT)).resolves.toBe(true);

    // …which means a *second* deliberate request works, without the operator
    // having to clear anything by hand.
    reconfigure({ initial: BOOTSTRAP, reset: 'true' });
    await ensureBootstrapPassword();

    await expect(verifyOperatorPassword(BOOTSTRAP)).resolves.toBe(true);
    await expect(verifyOperatorPassword(REPLACEMENT)).resolves.toBe(false);
  });

  it('refuses a reset value that is neither true nor false', async () => {
    reconfigure({ initial: BOOTSTRAP, reset: 'maybe' });
    // Refused at config-parse time, by name — not silently treated as truthy,
    // which for this particular variable would overwrite a password.
    await expect(ensureBootstrapPassword()).rejects.toThrow(/HELPARR_PASSWORD_RESET/);
  });
});
