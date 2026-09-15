import 'server-only';

import type { Database } from 'better-sqlite3-multiple-ciphers';

/**
 * Schema migrations (REQ-DEPLOY-010, T4).
 *
 * Migrations ship before there is data to migrate. Retrofitting a migration
 * mechanism onto databases operators already hold is materially harder than
 * carrying one from v1, so the runner exists from the first release even
 * though it has exactly one migration to run.
 *
 * Each migration is applied inside a transaction and recorded in
 * `schema_migration`, so re-running against an up-to-date database is a no-op.
 */

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE instance (
          id             TEXT PRIMARY KEY,
          kind           TEXT NOT NULL CHECK (kind IN ('sonarr','radarr','prowlarr','download-client')),
          label          TEXT NOT NULL,
          base_url       TEXT NOT NULL,
          -- Serialized discriminated union (ADR-5), protected by the
          -- page-level encryption applied to the whole database.
          credential     TEXT NOT NULL,
          enabled        INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          last_status    TEXT NOT NULL DEFAULT 'untested',
          last_version   TEXT,
          last_checked_at TEXT
        );

        CREATE UNIQUE INDEX idx_instance_kind_label ON instance (kind, label);

        CREATE TABLE health_sample (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id  TEXT NOT NULL REFERENCES instance (id) ON DELETE CASCADE,
          observed_at  TEXT NOT NULL,
          status       TEXT NOT NULL,
          latency_ms   INTEGER,
          reason       TEXT
        );

        CREATE INDEX idx_health_sample_instance_time
          ON health_sample (instance_id, observed_at DESC);

        -- Singleton row. The hash lives here rather than in the environment so
        -- the operator can change the password without a restart (ADR-3).
        CREATE TABLE operator (
          id            INTEGER PRIMARY KEY CHECK (id = 1),
          password_hash TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE login_attempt (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          source      TEXT NOT NULL,
          attempted_at TEXT NOT NULL,
          succeeded   INTEGER NOT NULL
        );

        CREATE INDEX idx_login_attempt_source_time
          ON login_attempt (source, attempted_at DESC);
      `);
    },
  },
];

export function runMigrations(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    db.prepare('SELECT version FROM schema_migration').all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)',
  );

  let ran = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
    ran += 1;
  }
  return ran;
}
