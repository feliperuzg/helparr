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
  {
    version: 2,
    name: 'operation-log',
    up: (db) => {
      db.exec(`
        CREATE TABLE operation (
          id             TEXT PRIMARY KEY,
          at             TEXT NOT NULL,                 -- ISO 8601 UTC
          kind           TEXT NOT NULL,                 -- 'grab' today; 'attach', 'rename' later
          summary        TEXT NOT NULL,                 -- operator-readable, names the resolved target

          -- Denormalised on purpose. Deleting an instance in Settings must not
          -- rewrite what helparr did while it existed, so there is no foreign
          -- key here: ON DELETE CASCADE would let a Settings deletion silently
          -- erase history, which is exactly what NFR3 forbids.
          instance_id    TEXT,
          instance_label TEXT NOT NULL,
          instance_kind  TEXT NOT NULL,

          entity_title   TEXT NOT NULL,                 -- the release name as the indexer published it
          entity_ref     TEXT,                          -- what the *arr resolved, or NULL
          indexer        TEXT,                          -- originating indexer, by name

          -- NEVER the URL itself (REQ-OPS-004, ADR-7). The URL embeds
          -- Prowlarr's own API key, which is the credential to the whole
          -- application. There is no column to write it to.
          url_sha256     TEXT,
          url_host       TEXT,

          -- Two values, not three. REQ-OPS-001 requires a rejected grab to be
          -- recorded with outcome "failed" verbatim; the rejected flag splits "your
          -- quality profile said no" from "radarr returned 502" for the
          -- viewer's filter without contradicting the spec.
          outcome        TEXT NOT NULL CHECK (outcome IN ('succeeded','failed')),
          rejected       INTEGER NOT NULL DEFAULT 0,
          detail         TEXT                           -- JSON: rejection reasons, or the transport error
        );

        -- No updated_at and no status column: a row is written once, from the
        -- response, and never revisited (ADR-6).
        CREATE INDEX idx_operation_at      ON operation (at DESC);
        CREATE INDEX idx_operation_outcome ON operation (outcome, at DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'rename-plan',
    up: (db) => {
      db.exec(`
        -- One row per "generate preview". This is the ONLY thing an apply may
        -- read to decide what to touch (NFR1): the apply request carries a plan
        -- id and a count and nothing else, so there is no field a caller could
        -- use to widen the scope past what is stored here.
        CREATE TABLE rename_plan (
          id            TEXT PRIMARY KEY,
          phase         TEXT NOT NULL
                          CHECK (phase IN ('building','ready','applying','done','expired','refused')),

          -- The exact [{instanceId, kind, upstreamId, label}] the operator
          -- picked, verbatim, so a regenerate reproduces the same scope and so
          -- the "no changes" list can be computed as scope-minus-rows rather
          -- than stored twice.
          scope_json    TEXT NOT NULL,
          title_json    TEXT NOT NULL,                 -- per-title build outcome

          total_titles  INTEGER NOT NULL DEFAULT 0,
          total_files   INTEGER NOT NULL DEFAULT 0,    -- every row, exclusions included

          built_at      TEXT,                          -- ISO 8601 UTC, null while building
          -- built_at + 300s, computed once. There is no column to extend it
          -- with, because FR11 has no "extend" (REQ-RENAME-014).
          expires_at    TEXT,
          applied_at    TEXT,                          -- first moment an outcome may be non-pending

          -- Kept for audit only. The gate is checked server-side against the
          -- stored rows before this is written; nothing reads it afterwards.
          typed_confirmation TEXT,

          refusal_json  TEXT,                          -- {kind, reason, drifted[]} or null
          created_at    TEXT NOT NULL
        );

        CREATE INDEX idx_rename_plan_expires_at ON rename_plan (expires_at);

        CREATE TABLE rename_plan_row (
          id             TEXT PRIMARY KEY,
          plan_id        TEXT NOT NULL REFERENCES rename_plan (id) ON DELETE CASCADE,

          -- Denormalised for the same reason operation's columns are: deleting
          -- an instance in Settings must not rewrite a plan built while it
          -- existed. Nullable id, never-null label.
          instance_id    TEXT,
          instance_label TEXT NOT NULL,
          instance_kind  TEXT NOT NULL CHECK (instance_kind IN ('sonarr','radarr')),

          title_kind        TEXT NOT NULL CHECK (title_kind IN ('series','movie')),
          title_upstream_id INTEGER NOT NULL,
          title_label       TEXT NOT NULL,

          -- file_id + existing_path together are the captured precondition
          -- (OQ-3). apply.ts re-derives both and refuses the whole plan on any
          -- mismatch. There is deliberately no force/ignore-drift column: the
          -- schema has nowhere to record a bypass (REQ-RENAME-013).
          file_id        INTEGER NOT NULL,
          existing_path  TEXT NOT NULL,
          proposed_path  TEXT NOT NULL,

          -- JSON array of codes helparr DERIVED from the diff (ADR-9). Neither
          -- Sonarr nor Radarr returns any warning field — the spike established
          -- that — so nothing here may ever be attributed to the instance.
          warnings_json  TEXT NOT NULL DEFAULT '[]',

          excluded       INTEGER NOT NULL DEFAULT 0,

          -- 'pending' until applied_at is set. Never written optimistically:
          -- an outcome means the file was verified, not that a command was
          -- accepted (REQ-RENAME-015).
          outcome        TEXT NOT NULL DEFAULT 'pending'
                           CHECK (outcome IN ('pending','succeeded','failed','skipped')),
          outcome_detail TEXT
        );

        CREATE INDEX idx_rename_plan_row_plan_id ON rename_plan_row (plan_id);

        -- operation.detail is a flat string[] — enough for a grab's handful of
        -- rejection reasons, not for "reconstruct which files moved from what
        -- to what" at plan scale (REQ-OPS-001). Paths are copied in rather than
        -- joined, so the log survives the plan being purged.
        CREATE TABLE rename_file_outcome (
          id            TEXT PRIMARY KEY,
          operation_id  TEXT NOT NULL REFERENCES operation (id) ON DELETE CASCADE,
          plan_row_id   TEXT NOT NULL,                 -- soft reference, deliberately
          existing_path TEXT NOT NULL,
          proposed_path TEXT NOT NULL,
          outcome       TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
          detail        TEXT
        );

        CREATE INDEX idx_rename_file_outcome_operation_id
          ON rename_file_outcome (operation_id);
      `);
    },
  },
  {
    version: 4,
    name: 'saved-search',
    up: (db) => {
      db.exec(`
        -- A saved search stores a question, not an answer (ADR-6 / OQ-6).
        --
        -- There is deliberately no instance_id and no foreign key to anything:
        -- a saved search is portable, and tying it to the Prowlarr instance
        -- that happened to be registered when it was saved would make
        -- "re-register Prowlarr" delete the operator's whole library of
        -- searches. What it stores is the criteria shape the search route
        -- already validates, so re-running is the ordinary search path with a
        -- resolved scope rather than a second implementation of it.
        CREATE TABLE saved_search (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          query        TEXT NOT NULL,

          -- JSON [{indexerId, name}] — a *reference* per indexer, never a bare
          -- id. The id is how it resolves on the happy path; the name is the
          -- only thing left to say out loud when the id is gone, and
          -- REQ-SEARCH-014 requires the missing indexer to be named. Empty
          -- array means "every indexer", which is the one scope that cannot
          -- go stale.
          scope_json   TEXT NOT NULL DEFAULT '[]',

          -- Prowlarr's own category ids. Not references: they are a fixed
          -- vocabulary, not roster entries, so there is nothing to resolve.
          categories_json TEXT NOT NULL DEFAULT '[]',
          min_seeders  INTEGER NOT NULL DEFAULT 0,

          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          -- Audit only. Nothing reads it to decide anything: a saved search is
          -- never re-run on a schedule, because every run spends indexer quota
          -- (REQ-SEARCH-009).
          last_run_at  TEXT
        );

        -- Case-insensitively unique, because the delete confirmation has to
        -- name the search being deleted (REQ-SEARCH-015) and two rows called
        -- "weekly sweep" make that sentence a guess.
        CREATE UNIQUE INDEX idx_saved_search_name
          ON saved_search (name COLLATE NOCASE);
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
