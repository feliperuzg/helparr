import { afterAll, describe, expect, it } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { hasOperatorPassword, setOperatorPassword, verifyOperatorPassword } from '@/server/auth/password';
import { checkRateLimit, rateLimitSource, recordAttempt } from '@/server/auth/rateLimit';
import { issueSessionValue, revokeAllSessions, verifySessionValue } from '@/server/auth/session';
import { closeDb, getDb } from '@/server/db';

const PASSWORD = 'a-long-enough-operator-password';

describe('operator password', () => {
  afterAll(() => {
    closeDb();
    cleanupTestDir();
  });

  it('stores an argon2id hash, never the plaintext', async () => {
    expect(hasOperatorPassword()).toBe(false);
    await setOperatorPassword(PASSWORD);
    expect(hasOperatorPassword()).toBe(true);

    const row = getDb()
      .prepare('SELECT password_hash FROM operator WHERE id = 1')
      .get() as { password_hash: string };

    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
  });

  it('accepts the right password and rejects everything else', async () => {
    await expect(verifyOperatorPassword(PASSWORD)).resolves.toBe(true);
    await expect(verifyOperatorPassword(`${PASSWORD}x`)).resolves.toBe(false);
    await expect(verifyOperatorPassword('')).resolves.toBe(false);
  });

  it('refuses a password too short to be worth hashing', async () => {
    await expect(setOperatorPassword('short')).rejects.toThrow();
  });
});

describe('login rate limiting', () => {
  it('throttles after five failures from one source and reports a retry window', () => {
    const source = '10.0.0.42';
    for (let i = 0; i < 5; i += 1) {
      expect(checkRateLimit(source).allowed).toBe(true);
      recordAttempt(source, false);
    }

    const verdict = checkRateLimit(source);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('scopes the throttle to the source that failed', () => {
    expect(checkRateLimit('10.0.0.43').allowed).toBe(true);
  });

  it('clears the window on a successful login', () => {
    recordAttempt('10.0.0.42', true);
    expect(checkRateLimit('10.0.0.42').allowed).toBe(true);
  });

  it('prefers x-forwarded-for, then x-real-ip', () => {
    expect(rateLimitSource(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(rateLimitSource(new Headers({ 'x-real-ip': '203.0.113.10' }))).toBe('203.0.113.10');
    expect(rateLimitSource(new Headers())).toBe('unknown');
  });
});

describe('session cookie', () => {
  it('accepts a value it issued and rejects a tampered one', () => {
    const value = issueSessionValue();
    expect(verifySessionValue(value)).toBe(true);

    expect(verifySessionValue(undefined)).toBe(false);
    expect(verifySessionValue('')).toBe(false);
    expect(verifySessionValue('not-a-session')).toBe(false);
    // Same payload, forged signature.
    expect(verifySessionValue(`${value.slice(0, value.lastIndexOf('.'))}.deadbeef`)).toBe(false);
    // Same signature, altered payload.
    expect(verifySessionValue(value.replace(/^\d+/, '9999999999999'))).toBe(false);
  });

  it('refuses a cookie replayed after logout (REQ-AUTH-006)', () => {
    const value = issueSessionValue();
    expect(verifySessionValue(value)).toBe(true);

    revokeAllSessions();

    // The whole point: possession of the old cookie is no longer sufficient.
    expect(verifySessionValue(value)).toBe(false);
    expect(verifySessionValue(issueSessionValue())).toBe(true);
  });
});
