import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from 'better-sqlite3-multiple-ciphers';

import { cleanupTestDir } from './helpers/env';
import { ConfigError, getConfig, resetConfigCache, assertBasePathMatches } from '@/server/config';
import {
  MissingEncryptionKeyError,
  getEncryptionKey,
  resetEncryptionKeyCache,
} from '@/server/crypto';
import { closeDb } from '@/server/db';
import { MIGRATIONS, runMigrations } from '@/server/db/migrations';

/**
 * T5 / REQ-DEPLOY-008, REQ-DEPLOY-010, NFR2, NFR6; ADR-1, ADR-3.
 *
 * Everything asserted here is about the moment *before* helparr serves a
 * request, which is the moment it previously did not have. The failures this
 * covers are the ones that used to be invisible until an operator tripped over
 * them: a typo'd variable that was read and discarded, a key that was never
 * supplied, a base path compiled into one artifact and configured for another.
 *
 * The bar for each test is not "it errors" — it is "it errors in a way that
 * tells the operator which variable to change", so every assertion names the
 * variable, and the two that carry secrets assert the value is *absent*.
 */

const MANAGED = [
  'HELPARR_DB_PATH',
  'HELPARR_ENCRYPTION_KEY',
  'HELPARR_ENCRYPTION_KEY_FILE',
  'HELPARR_LOG_LEVEL',
  'HELPARR_QUEUE_REFRESH_SECONDS',
  'HELPARR_BASE_PATH',
  'HELPARR_COMPILED_BASE_PATH',
  'HELPARR_INITIAL_PASSWORD',
  'NEXT_RUNTIME',
] as const;

const scratch = mkdtempSync(join(tmpdir(), 'helparr-startup-'));

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED) snapshot[key] = process.env[key];
});

afterEach(() => {
  for (const key of MANAGED) {
    const previous = snapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  // Both caches are process-lifetime in production. Dropping them here is what
  // makes the environment the test set actually the environment under test.
  resetConfigCache();
  resetEncryptionKeyCache();
  closeDb();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  cleanupTestDir();
});

function problemsOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError, but the call succeeded');
}

describe('configuration parsing', () => {
  it('reports every problem at once rather than one per restart', () => {
    process.env.HELPARR_LOG_LEVEL = 'verbose';
    process.env.HELPARR_QUEUE_REFRESH_SECONDS = 'often';
    process.env.HELPARR_BASE_PATH = 'helparr';
    resetConfigCache();

    const problems = problemsOf(getConfig);

    // Three independent mistakes, three lines. Fixing one misconfiguration per
    // restart is how a five-minute install becomes a half-hour one.
    expect(problems).toHaveLength(3);
    expect(problems.some((p) => p.includes('HELPARR_LOG_LEVEL') && p.includes('verbose'))).toBe(true);
    expect(problems.some((p) => p.includes('HELPARR_QUEUE_REFRESH_SECONDS') && p.includes('often'))).toBe(true);
    expect(problems.some((p) => p.includes('HELPARR_BASE_PATH') && p.includes('"/"'))).toBe(true);
  });

  it('refuses a refresh interval below the floor instead of silently using the default', () => {
    process.env.HELPARR_QUEUE_REFRESH_SECONDS = '1';
    resetConfigCache();

    const problems = problemsOf(getConfig);

    // The old behaviour accepted this and polled at 30s. An operator who asks
    // for one second and gets thirty has been ignored without being told.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('HELPARR_QUEUE_REFRESH_SECONDS');
    expect(problems[0]).toContain('minimum is 5');
  });

  it('treats a root base path and no base path as the same configuration', () => {
    process.env.HELPARR_BASE_PATH = '/';
    resetConfigCache();
    expect(getConfig().basePath).toBe('');

    delete process.env.HELPARR_BASE_PATH;
    resetConfigCache();
    expect(getConfig().basePath).toBe('');
  });

  it('rejects a base path with a trailing slash, naming the value', () => {
    process.env.HELPARR_BASE_PATH = '/helparr/';
    resetConfigCache();

    const problems = problemsOf(getConfig);
    expect(problems[0]).toContain('/helparr/');
    expect(problems[0]).toContain('must not end');
  });

  it('never echoes the initial password into the error that rejects it', () => {
    process.env.HELPARR_INITIAL_PASSWORD = 'hunter2';
    resetConfigCache();

    const problems = problemsOf(getConfig);

    expect(problems[0]).toContain('HELPARR_INITIAL_PASSWORD');
    expect(problems[0]).toContain('7 characters');
    // The length is the actionable part; the value is not, and an operator who
    // pastes a startup error into a forum post should not be pasting a password.
    expect(problems.join('\n')).not.toContain('hunter2');
  });

  it('accepts a complete configuration', () => {
    process.env.HELPARR_BASE_PATH = '/helparr';
    process.env.HELPARR_LOG_LEVEL = 'DEBUG';
    process.env.HELPARR_QUEUE_REFRESH_SECONDS = '45';
    process.env.HELPARR_INITIAL_PASSWORD = 'a-long-enough-password';
    resetConfigCache();

    const config = getConfig();
    expect(config.basePath).toBe('/helparr');
    expect(config.logLevel).toBe('debug');
    expect(config.queueRefreshSeconds).toBe(45);
    expect(config.encryptionKeySource).toBe('env');
  });
});

describe('encryption key ingestion', () => {
  it('names both sources when neither provides a value', () => {
    delete process.env.HELPARR_ENCRYPTION_KEY;
    delete process.env.HELPARR_ENCRYPTION_KEY_FILE;
    resetConfigCache();
    resetEncryptionKeyCache();

    expect(() => getEncryptionKey()).toThrow(MissingEncryptionKeyError);
    expect(() => getEncryptionKey()).toThrow(/HELPARR_ENCRYPTION_KEY_FILE/);
  });

  it('reads the key through the _FILE indirection, stripping the trailing newline', () => {
    const keyPath = join(scratch, 'secret-key');
    // How `echo secret > key`, a Docker secret and systemd LoadCredential all
    // write a file: with exactly one trailing newline.
    writeFileSync(keyPath, 'file-supplied-key-0123456789\n', 'utf8');

    delete process.env.HELPARR_ENCRYPTION_KEY;
    process.env.HELPARR_ENCRYPTION_KEY_FILE = keyPath;
    resetConfigCache();
    resetEncryptionKeyCache();

    expect(getConfig().encryptionKeySource).toBe('file');
    expect(getEncryptionKey()).toBe('file-supplied-key-0123456789');
  });

  it('refuses both sources at once rather than picking a winner', () => {
    process.env.HELPARR_ENCRYPTION_KEY = 'direct-key-0123456789';
    process.env.HELPARR_ENCRYPTION_KEY_FILE = join(scratch, 'secret-key');
    resetConfigCache();

    const problems = problemsOf(getConfig);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('HELPARR_ENCRYPTION_KEY');
    expect(problems[0]).toContain('HELPARR_ENCRYPTION_KEY_FILE');
    // Neither secret appears in the message that reports the collision.
    expect(problems[0]).not.toContain('direct-key-0123456789');
  });

  it('names the unreadable path, because the path is the only thing that can be fixed', () => {
    const missing = join(scratch, 'not-mounted', 'key');
    delete process.env.HELPARR_ENCRYPTION_KEY;
    process.env.HELPARR_ENCRYPTION_KEY_FILE = missing;
    resetConfigCache();
    resetEncryptionKeyCache();

    expect(() => getEncryptionKey()).toThrow(MissingEncryptionKeyError);
    expect(() => getEncryptionKey()).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('rejects a key too short to be worth encrypting with', () => {
    process.env.HELPARR_ENCRYPTION_KEY = 'short';
    delete process.env.HELPARR_ENCRYPTION_KEY_FILE;
    resetConfigCache();
    resetEncryptionKeyCache();

    expect(() => getEncryptionKey()).toThrow(/at least 16 are required/);
  });
});

describe('base path consistency', () => {
  it('passes when the configured path matches the compiled one', () => {
    process.env.HELPARR_COMPILED_BASE_PATH = '/helparr';
    process.env.HELPARR_BASE_PATH = '/helparr';
    resetConfigCache();

    expect(() => assertBasePathMatches()).not.toThrow();
  });

  it('refuses to run when the artifact was compiled for a different path', () => {
    process.env.HELPARR_COMPILED_BASE_PATH = '/helparr';
    delete process.env.HELPARR_BASE_PATH;
    resetConfigCache();

    const problems = problemsOf(assertBasePathMatches);

    // Both values, because the mismatch is only diagnosable as a pair — and the
    // way out (unset, or rebuild) has to be stated, since "set the variable"
    // is the thing the operator already did.
    expect(problems[0]).toContain('/helparr');
    expect(problems[0]).toContain('(root)');
    expect(problems[0]).toContain('rebuild');
  });

  it('refuses the reverse mismatch too', () => {
    process.env.HELPARR_COMPILED_BASE_PATH = '';
    process.env.HELPARR_BASE_PATH = '/media/helparr';
    resetConfigCache();

    const problems = problemsOf(assertBasePathMatches);
    expect(problems[0]).toContain('/media/helparr');
  });
});

describe('the startup hook', () => {
  it('exits non-zero with an actionable message when the key is missing', async () => {
    delete process.env.HELPARR_ENCRYPTION_KEY;
    delete process.env.HELPARR_ENCRYPTION_KEY_FILE;
    process.env.NEXT_RUNTIME = 'nodejs';
    resetConfigCache();
    resetEncryptionKeyCache();

    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });

    const { register } = await import('@/instrumentation');
    await register();

    expect(exit).toHaveBeenCalledWith(1);
    const output = errors.join('\n');
    expect(output).toContain('helparr failed to start');
    expect(output).toContain('HELPARR_ENCRYPTION_KEY');
    // Plain prose, not a JSON log line: `docker logs` on a container that died
    // in its first second is the only place this will ever be read.
    expect(output).not.toContain('"level"');
  });

  it('opens the database before serving, so an upgraded image migrates first', async () => {
    const dbPath = join(scratch, 'startup', 'helparr.db');
    process.env.HELPARR_DB_PATH = dbPath;
    process.env.HELPARR_ENCRYPTION_KEY = 'startup-key-0123456789ab';
    delete process.env.HELPARR_ENCRYPTION_KEY_FILE;
    delete process.env.HELPARR_BASE_PATH;
    process.env.HELPARR_COMPILED_BASE_PATH = '';
    process.env.HELPARR_LOG_LEVEL = 'info';
    process.env.NEXT_RUNTIME = 'nodejs';
    resetConfigCache();
    resetEncryptionKeyCache();
    closeDb();

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const { register } = await import('@/instrumentation');
    await register();

    expect(exit).not.toHaveBeenCalled();
    expect(existsSync(dbPath)).toBe(true);

    const ready = lines.find((line) => line.includes('helparr ready'));
    expect(ready).toBeDefined();
    const parsed = JSON.parse(ready as string) as { ctx: Record<string, unknown> };
    expect(parsed.ctx.basePath).toBe('(root)');
    expect(parsed.ctx.encryptionKeySource).toBe('env');
    // The source, never the material.
    expect(ready).not.toContain('startup-key-0123456789ab');
  });

  it('does nothing on a non-node runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    delete process.env.HELPARR_ENCRYPTION_KEY;
    delete process.env.HELPARR_ENCRYPTION_KEY_FILE;
    resetConfigCache();
    resetEncryptionKeyCache();

    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { register } = await import('@/instrumentation');
    await register();

    // The edge bundle has no filesystem and no native binding; a key check
    // there would fail on a configuration that is perfectly correct.
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('schema migrations', () => {
  const nodeRequire = createRequire(import.meta.url);
  const DatabaseCtor = nodeRequire('better-sqlite3-multiple-ciphers') as new (
    filename: string,
  ) => Database;

  let index = 0;
  function freshDb(): Database {
    index += 1;
    return new DatabaseCtor(join(scratch, `migrate-${index}.db`));
  }

  it('applies every migration to an empty database and is a no-op the second time', () => {
    const db = freshDb();
    try {
      expect(runMigrations(db)).toBe(MIGRATIONS.length);
      // NFR6 is about restart, not first run: the second call is the one that
      // happens every time an operator restarts an unchanged container.
      expect(runMigrations(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('applies only what is outstanding when the database is on an older schema', () => {
    const db = freshDb();
    try {
      // A v1 database, built the way v1 built it — not by running the current
      // runner and deleting rows, which would prove nothing about the ordering.
      db.exec(`
        CREATE TABLE schema_migration (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      MIGRATIONS[0].up(db);
      db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)')
        .run(MIGRATIONS[0].version, MIGRATIONS[0].name, new Date().toISOString());

      expect(runMigrations(db)).toBe(MIGRATIONS.length - 1);

      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(tables).toContain('instance');
      expect(tables).toContain('operation');
      expect(tables).toContain('rename_plan');

      const versions = (db.prepare('SELECT version FROM schema_migration ORDER BY version').all() as Array<{ version: number }>)
        .map((row) => row.version);
      expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    } finally {
      db.close();
    }
  });
});
