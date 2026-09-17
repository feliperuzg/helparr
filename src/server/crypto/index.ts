import 'server-only';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { getConfig } from '@/server/config';
import { registerSecret } from '@/server/logging/redact';

/**
 * Encryption key ingestion (ADR-2, REQ-INST-006 / NFR6; `_FILE` per
 * `packaging-and-hardening` ADR-3).
 *
 * helparr still reads exactly one key, `HELPARR_ENCRYPTION_KEY` —
 * `instance-connections` ADR-2 settled that and this is not a second variable
 * competing with it. `HELPARR_ENCRYPTION_KEY_FILE` is an *indirection* to the
 * same value, consulted only when the direct variable is unset: it is the
 * convention Docker secrets produce and the one systemd `LoadCredential` maps
 * onto, so an operator can hand helparr a key without it ever appearing in a
 * compose file, an image layer, or `docker inspect`.
 *
 * Both set at once is refused upstream in `@/server/config` rather than
 * resolved by precedence, because a silent winner between two secrets is how
 * you encrypt against a key you did not think you were using.
 *
 * stdin was considered and rejected: it breaks unattended restart, which is the
 * entire point of a container healthcheck and a systemd unit.
 *
 * Whichever path delivered it, the value is validated identically and
 * registered as a redaction secret before it can reach a log line.
 *
 * The key is resolved lazily, not at import time. Importing this module during
 * `next build` must not require the key to be present (AC13).
 */

const ENV_VAR = 'HELPARR_ENCRYPTION_KEY';
const FILE_VAR = 'HELPARR_ENCRYPTION_KEY_FILE';
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
 * Reads the key material from whichever source the configuration names. A file
 * whose last line ends in a newline is the normal case — `echo secret > key` and
 * every secret manager that writes a file do it — so exactly one trailing
 * newline is stripped rather than the value being trimmed wholesale, which
 * would silently accept a key with leading or trailing spaces as a different
 * key than the one on disk.
 */
function readKeyMaterial(): string | undefined {
  const { encryptionKeySource, encryptionKeyFilePath } = getConfig();

  if (encryptionKeySource === 'env') return process.env[ENV_VAR];
  if (encryptionKeySource !== 'file' || encryptionKeyFilePath === null) return undefined;

  try {
    return readFileSync(encryptionKeyFilePath, 'utf8').replace(/\r?\n$/, '');
  } catch (error) {
    // The path is named because it is the only way to fix this, and a path an
    // operator chose is configuration rather than a secret. The file's contents
    // are not read into the message under any circumstance.
    throw new MissingEncryptionKeyError(
      `${FILE_VAR} points at ${encryptionKeyFilePath}, which could not be read `
      + `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Returns the raw key material. Throws `MissingEncryptionKeyError` when neither
 * source provides a value, or when the value is too short to be meaningful.
 */
export function getEncryptionKey(): string {
  if (cached !== null) return cached;

  const raw = readKeyMaterial();
  if (raw === undefined || raw.trim() === '') {
    throw new MissingEncryptionKeyError(
      `neither ${ENV_VAR} nor ${FILE_VAR} provides a value`,
    );
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
 * Fail-closed startup check (NFR6 / AC9, REQ-DEPLOY-008). Called from
 * `instrumentation.ts` before the server accepts its first request, so a
 * misconfigured deployment reports one clear cause and exits instead of
 * answering requests until something happens to touch the database.
 *
 * This function existed before it had a caller — its docblock named a database
 * bootstrap and a health route that never called it. `packaging-and-hardening`
 * added the startup hook that makes the check reachable.
 */
export function assertEncryptionKeyPresent(): void {
  getEncryptionKey();
}

/** Test seam — the key is cached for the process lifetime in production. */
export function resetEncryptionKeyCache(): void {
  cached = null;
}
