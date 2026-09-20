import 'server-only';

import argon2 from 'argon2';

import { MIN_INITIAL_PASSWORD_LENGTH, getConfig } from '@/server/config';
import { getDb } from '@/server/db';
import { logger } from '@/server/logging/redact';

/**
 * Operator password storage (ADR-3, REQ-AUTH-002).
 *
 * argon2id, with the hash in a singleton `operator` row rather than in an
 * environment variable so the operator can change it without a restart. The
 * bootstrap password is supplied at first start via the environment; first
 * login stores its hash.
 */

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP's recommended argon2id floor.
  timeCost: 2,
  parallelism: 1,
} as const;

interface OperatorRow {
  password_hash: string;
}

/** Memoized answer to `isBootstrapCredential()` — see its doc comment. */
let bootstrapProbe: Promise<boolean> | null = null;

export function hasOperatorPassword(): boolean {
  const row = getDb().prepare('SELECT password_hash FROM operator WHERE id = 1').get();
  return row !== undefined;
}

/**
 * The floor is `MIN_INITIAL_PASSWORD_LENGTH` rather than a literal so bootstrap
 * and rotation cannot drift apart. It used to be an 8 here and an 8 in
 * `@/server/config`, which satisfied "rotation enforces the same minimum as
 * provisioning" by coincidence rather than by construction.
 */
export async function setOperatorPassword(plaintext: string): Promise<void> {
  if (plaintext.length < MIN_INITIAL_PASSWORD_LENGTH) {
    throw new Error(
      `The operator password must be at least ${MIN_INITIAL_PASSWORD_LENGTH} characters.`,
    );
  }
  const hash = await argon2.hash(plaintext, ARGON_OPTIONS);
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO operator (id, password_hash, created_at, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash,
                                   updated_at    = excluded.updated_at
  `).run(hash, now, now);
  bootstrapProbe = null;
  logger.info('operator password set');
}

/**
 * Is the stored password still the one `HELPARR_INITIAL_PASSWORD` supplied?
 * (REQ-AUTH-011, ADR-3.)
 *
 * Answered by verifying against the retained config value rather than by a
 * stored flag, so there is no second source of truth that can disagree with the
 * hash. The promise is memoized because `AppShell` polls `/api/health` every 60
 * seconds, and an argon2 verify at 19 MiB on that path would be a self-inflicted
 * load; `setOperatorPassword` clears it, which is the only thing that can change
 * the answer within a process.
 *
 * An operator who removed the variable after first run reads as "not
 * provisional" even if they never rotated. That is the right answer: the
 * plaintext exposure the notice warns about is already gone.
 */
export function isBootstrapCredential(): Promise<boolean> {
  bootstrapProbe ??= (async () => {
    const initial = getConfig().initialPassword;
    if (!initial) return false;
    return verifyOperatorPassword(initial);
  })().catch((error) => {
    bootstrapProbe = null;
    logger.error('bootstrap credential probe failed', error);
    return false;
  });
  return bootstrapProbe;
}

/** Test seam: drops the memoized provenance answer. */
export function resetBootstrapProbe(): void {
  bootstrapProbe = null;
}

/**
 * Bootstrap from `HELPARR_INITIAL_PASSWORD` on first run. Idempotent: once a
 * hash exists the environment variable is ignored, so leaving it set in a
 * compose file cannot silently reset a password the operator later changed.
 *
 * The length check lives in `@/server/config`, so a too-short bootstrap password
 * is reported at startup by name rather than discovered here — at the moment
 * someone is trying to log in for the first time, which is the worst moment to
 * learn that the password they were handed was never stored.
 */
export async function ensureBootstrapPassword(): Promise<void> {
  const { initialPassword, passwordReset } = getConfig();

  if (!hasOperatorPassword()) {
    if (!initialPassword) return;
    await setOperatorPassword(initialPassword);
    logger.info('bootstrapped operator password from HELPARR_INITIAL_PASSWORD');
    return;
  }

  if (!passwordReset) {
    // Absence of the flag is what re-arms recovery. Deliberately not "any
    // password write re-arms it": that would let a flag left in a compose file
    // undo the operator's *next* rotation on the restart after it, which is the
    // exact failure mode the marker exists to prevent. Removing the flag is a
    // thing the operator does on purpose, so it is the honest signal that the
    // previous request is over.
    disarmReset();
    return;
  }
  await applyDeliberateReset(initialPassword);
}

function disarmReset(): void {
  getDb()
    .prepare('UPDATE operator SET reset_consumed_at = NULL WHERE id = 1 AND reset_consumed_at IS NOT NULL')
    .run();
}

/**
 * The one deliberate exception to bootstrap inertness (REQ-AUTH-008, ADR-4).
 *
 * A separately named flag — not the provisioning value on its own — lets that
 * value win one more time. This cedes no real security: anyone who can set
 * environment variables on the container already owns the host. The usual
 * alternative, documenting a direct database edit, is not available here
 * because the database is encrypted, so that path would need a `sqlite3` built
 * with the cipher extension *and* the operator's `HELPARR_ENCRYPTION_KEY`.
 *
 * Sessions issued before the reset are already dead: the session signing
 * material is process-local (`session.ts`), so the restart that applies the
 * reset has invalidated every cookie on its own.
 *
 * "At most once per time it is requested" is counted per *request*, not per
 * restart — a flag left set is one standing request, and it fires once. The
 * marker that records that is cleared by removing the flag, not by writing a
 * new password; see `disarmReset`.
 */
async function applyDeliberateReset(initialPassword: string | null): Promise<void> {
  if (!initialPassword) {
    logger.warn(
      'HELPARR_PASSWORD_RESET is set but HELPARR_INITIAL_PASSWORD is not; '
      + 'there is no value to reset the password to',
    );
    return;
  }

  const row = getDb()
    .prepare('SELECT reset_consumed_at FROM operator WHERE id = 1')
    .get() as { reset_consumed_at: string | null } | undefined;

  if (row?.reset_consumed_at) {
    // Not an error, but not nothing either: the flag is a loaded gun left on
    // the table. Say so every time until it is put away.
    logger.warn(
      'HELPARR_PASSWORD_RESET is still set and was already applied at '
      + `${row.reset_consumed_at}; remove it so a future restart cannot undo a password change`,
    );
    return;
  }

  await setOperatorPassword(initialPassword);
  getDb()
    .prepare('UPDATE operator SET reset_consumed_at = ? WHERE id = 1')
    .run(new Date().toISOString());
  logger.info(
    'operator password reset to HELPARR_INITIAL_PASSWORD because HELPARR_PASSWORD_RESET was set; '
    + 'remove the flag and change the password',
  );
}

export async function verifyOperatorPassword(plaintext: string): Promise<boolean> {
  const row = getDb()
    .prepare('SELECT password_hash FROM operator WHERE id = 1')
    .get() as OperatorRow | undefined;

  if (!row) return false;

  try {
    return await argon2.verify(row.password_hash, plaintext);
  } catch (error) {
    // A malformed hash must not read as a successful verification.
    logger.error('password verification failed', error);
    return false;
  }
}
