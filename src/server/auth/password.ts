import 'server-only';

import argon2 from 'argon2';

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

export function hasOperatorPassword(): boolean {
  const row = getDb().prepare('SELECT password_hash FROM operator WHERE id = 1').get();
  return row !== undefined;
}

export async function setOperatorPassword(plaintext: string): Promise<void> {
  if (plaintext.length < 8) {
    throw new Error('The operator password must be at least 8 characters.');
  }
  const hash = await argon2.hash(plaintext, ARGON_OPTIONS);
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO operator (id, password_hash, created_at, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash,
                                   updated_at    = excluded.updated_at
  `).run(hash, now, now);
  logger.info('operator password set');
}

/**
 * Bootstrap from `HELPARR_INITIAL_PASSWORD` on first run. Idempotent: once a
 * hash exists the environment variable is ignored, so leaving it set in a
 * compose file cannot silently reset a password the operator later changed.
 */
export async function ensureBootstrapPassword(): Promise<void> {
  if (hasOperatorPassword()) return;
  const initial = process.env.HELPARR_INITIAL_PASSWORD;
  if (!initial) return;
  await setOperatorPassword(initial);
  logger.info('bootstrapped operator password from HELPARR_INITIAL_PASSWORD');
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
