import 'server-only';

import { createHash } from 'node:crypto';

import { registerSecret } from '@/server/logging/redact';

/**
 * Encryption key ingestion (ADR-2, REQ-INST-006 / NFR6).
 *
 * helparr reads exactly one variable, `HELPARR_ENCRYPTION_KEY`. Whether it
 * arrives via a systemd EnvironmentFile, a Docker secret, or a manual export
 * is an operator concern documented in `packaging-and-hardening` — none of
 * that leaks into this module.
 *
 * The key is resolved lazily, not at import time. Importing this module during
 * `next build` must not require the key to be present (AC13).
 */

const ENV_VAR = 'HELPARR_ENCRYPTION_KEY';
const MIN_KEY_LENGTH = 16;

export class MissingEncryptionKeyError extends Error {
  constructor(detail: string) {
    super(
      `${ENV_VAR} is not usable: ${detail}. helparr stores instance credentials `
      + 'encrypted at rest and refuses to start without a key — a missing key '
      + 'would otherwise mean silently writing credentials in the clear.',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

let cached: string | null = null;

/**
 * Returns the raw key material. Throws `MissingEncryptionKeyError` when the
 * variable is absent or too short to be meaningful.
 */
export function getEncryptionKey(): string {
  if (cached !== null) return cached;

  const raw = process.env[ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    throw new MissingEncryptionKeyError('the variable is unset or empty');
  }
  const key = raw.trim();
  if (key.length < MIN_KEY_LENGTH) {
    throw new MissingEncryptionKeyError(
      `the value is ${key.length} characters; at least ${MIN_KEY_LENGTH} are required`,
    );
  }

  // The key itself must never surface in a log line, including inside an
  // upstream error that happens to echo the environment back.
  registerSecret(key);
  cached = key;
  return key;
}

/**
 * The value handed to SQLite's `PRAGMA key`. Hashed rather than passed raw so
 * that a key containing a quote or a backslash cannot break out of the pragma
 * statement, and so the stored keying material is fixed-width.
 */
export function getDatabaseKey(): string {
  return createHash('sha256').update(getEncryptionKey(), 'utf8').digest('hex');
}

/**
 * Fail-closed startup check (NFR6 / AC9). Called from the database bootstrap
 * and from the health route so a misconfigured deployment reports one clear
 * cause instead of a cascade of decrypt failures.
 */
export function assertEncryptionKeyPresent(): void {
  getEncryptionKey();
}

/** Test seam — the key is cached for the process lifetime in production. */
export function resetEncryptionKeyCache(): void {
  cached = null;
}
