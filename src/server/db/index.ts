import 'server-only';

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type { Database } from 'better-sqlite3-multiple-ciphers';

import { getDatabaseKey } from '@/server/crypto';
import { logger } from '@/server/logging/redact';
import { runMigrations } from './migrations';

/**
 * Encrypted SQLite handle (ADR-1, REQ-INST-006 / NFR4).
 *
 * The handle is created on first use, never at module scope. `next build`
 * imports route modules to collect their metadata; a module-scope `new
 * Database(...)` would open — and with `PRAGMA key`, demand the encryption key
 * for — the database during the build. AC13 asserts that does not happen, so a
 * regression here fails CI rather than surfacing as a broken Docker image.
 */

const DEFAULT_PATH = './data/helparr.db';

let handle: Database | null = null;

export function getDatabasePath(): string {
  return resolve(process.env.HELPARR_DB_PATH ?? DEFAULT_PATH);
}

export function getDb(): Database {
  if (handle) return handle;

  const path = getDatabasePath();
  mkdirSync(dirname(path), { recursive: true });

  // Loaded lazily so that merely importing a module that re-exports `getDb`
  // does not pull in the native binding. `createRequire` is used rather than a
  // dynamic `import()` so `getDb()` stays synchronous — every call site is a
  // synchronous query path.
  const nodeRequire = createRequire(import.meta.url);
  const DatabaseCtor = nodeRequire('better-sqlite3-multiple-ciphers') as new (
    filename: string,
  ) => Database;

  const db = new DatabaseCtor(path);

  // Must be the first statement executed. Any read before the key is applied
  // fails with "file is not a database" rather than returning plaintext.
  db.pragma(`key = '${getDatabaseKey()}'`);

  // Forces a read of page 1 so a wrong key fails here, loudly and immediately,
  // instead of at the first query in an unrelated request handler (AC8).
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (error) {
    db.close();
    throw new Error(
      `Unable to open ${path} with the configured HELPARR_ENCRYPTION_KEY. `
      + 'Either the key is wrong for this database, or the file was created '
      + 'with a different key.',
      { cause: error },
    );
  }

  // WAL keeps the poller's writes from blocking reads. The -wal and -shm
  // sidecars live beside the database, so the whole directory must be on the
  // mounted volume — not just the .db file (packaging-and-hardening).
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const ran = runMigrations(db);
  if (ran > 0) logger.info('applied schema migrations', { count: ran, path });

  handle = db;
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** True when the handle has been opened — used by AC13's build-time assertion. */
export function isDbOpen(): boolean {
  return handle !== null;
}
