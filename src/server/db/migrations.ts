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
  {
    version: 5,
    name: 'operator-reset-marker',
    up: (db) => {
      db.exec(`
        -- Records that the deliberate recovery flag has already been honoured
        -- (REQ-AUTH-008, ADR-5).
        --
        -- "At most once per time it is requested" cannot be enforced by reading
        -- the environment alone, because the environment does not change between
        -- restarts: a HELPARR_PASSWORD_RESET left in a compose file would
        -- re-reset the password on every boot, which is exactly the failure mode
        -- the inertness rule exists to prevent, wearing an opt-in costume.
        --
        -- Cleared by the flag's ABSENCE, not by a password write. Clearing it on
        -- every write would mean a flag left in place undoes the operator's next
        -- rotation on the restart after it — the same foot-gun one level down.
        -- Removing the variable is something the operator does deliberately, so
        -- it is the honest signal that the standing request is over; requesting a
        -- second recovery later then works without any manual cleanup.
        ALTER TABLE operator ADD COLUMN reset_consumed_at TEXT;
      `);
    },
  },
  {
    version: 6,
    name: 'import-plan',
    up: (db) => {
      db.exec(`
        -- One row per "review candidates" open (ADR-3). Plays the same role
        -- rename_plan plays for rename: apply.ts loads a plan by id, and this
        -- table is the sole source of truth for which files a confirmed apply
        -- may touch. No scope_json / title_json equivalent: a force-import
        -- plan always covers exactly one download, never a multi-title scope.
        CREATE TABLE import_plan (
          id               TEXT PRIMARY KEY,

          -- Soft reference, same reasoning as rename_plan_row's instance_id:
          -- deleting the instance in Settings must not rewrite a plan built
          -- while it existed.
          instance_id      TEXT,
          instance_kind    TEXT NOT NULL CHECK (instance_kind IN ('sonarr','radarr')),
          instance_label   TEXT NOT NULL,

          -- The queue record's infohash — what manualimport?downloadId= was
          -- read with, and what the drift re-read (ADR-5) re-reads with.
          download_id      TEXT NOT NULL,
          -- Traces the plan back to the *arr queue row it was opened from,
          -- for the inspector's "view import" link.
          queue_record_id  INTEGER NOT NULL,
          title            TEXT NOT NULL,

          phase            TEXT NOT NULL
                              CHECK (phase IN ('ready','applying','done','refused','expired')),

          -- {reason, changes[]} or null (ADR-5, ADR-8's precedent: no
          -- force/override column, matching rename's "nowhere to record a
          -- bypass").
          refusal_json     TEXT,

          created_at       TEXT NOT NULL,                 -- ISO 8601 UTC
          -- created_at + 300s, computed once. No column to extend it with,
          -- mirroring rename_plan.expires_at (FR11's analogue, ADR-3).
          expires_at       TEXT NOT NULL
        );

        CREATE INDEX idx_import_plan_expires_at ON import_plan (expires_at);

        -- One row per candidate manualimport reported. path + size together
        -- are the captured precondition (FR9, REQ-QUEUE-022): apply.ts
        -- re-reads the candidate set for the same download_id immediately
        -- before writing and refuses the whole plan on any drift. No
        -- "force anyway" column — same absence rename_plan_row has.
        CREATE TABLE import_plan_row (
          plan_id          TEXT NOT NULL REFERENCES import_plan (id) ON DELETE CASCADE,
          -- The instance's own candidate order, preserved for stable
          -- rendering (FR6) and as half of the natural key.
          ordinal          INTEGER NOT NULL,

          path             TEXT NOT NULL,
          relative_path    TEXT,
          size             INTEGER NOT NULL,

          -- Shown verbatim per candidate (FR6).
          quality_json         TEXT NOT NULL,
          languages_json       TEXT NOT NULL DEFAULT '[]',
          release_group        TEXT,
          indexer_flags        INTEGER NOT NULL DEFAULT 0,
          release_type         TEXT,
          custom_formats_json  TEXT NOT NULL DEFAULT '[]',
          -- Named by source elsewhere (ADR-12); this column is the instance's
          -- own reported total, nullable because not every candidate carries one.
          custom_format_score  INTEGER,

          -- What the file will be imported to. Starts as the instance's own
          -- resolution; null means the instance could not map it, which is
          -- what keeps the row un-includable until the operator maps it
          -- (ADR-4).
          mapping_json     TEXT,
          mapping_source   TEXT NOT NULL DEFAULT 'instance'
                              CHECK (mapping_source IN ('instance','operator')),

          -- The candidate's own rejection reasons, verbatim (FR6) — same
          -- "reasons are the product" convention as rename/grab.
          rejections_json  TEXT NOT NULL DEFAULT '[]',
          -- Set when the destination item already has a file (ADR-8). Drives
          -- included's default; the operator is shown *why* a row starts
          -- opted out, not just that it does.
          replaces_existing_json TEXT,

          -- Inverted in sense from rename_plan_row.excluded: force import
          -- *includes* rather than excludes (ADR-8, state-import-plan.md).
          -- Operator-togglable while phase = 'ready'.
          included         INTEGER NOT NULL DEFAULT 0,

          -- Null until the plan reaches 'applying'; never written
          -- optimistically — an outcome means history (or a re-read) actually
          -- confirmed it (ADR-7). The columns live here, not only in the
          -- operation log, so the review screen can show per-file outcomes
          -- progressively while 'applying' is still in flight.
          outcome              TEXT CHECK (outcome IN ('succeeded','failed','unverified')),
          outcome_destination  TEXT,
          outcome_error        TEXT,

          PRIMARY KEY (plan_id, ordinal)
        );

        -- operation.detail stays a flat string[], same as every other kind;
        -- it is not enough to reconstruct which file went where, which is
        -- what this table exists for (REQ-OPS-001's force-import extension,
        -- mirroring rename_file_outcome exactly). Append-only: a row is
        -- written once, from the read-back, and never revisited.
        CREATE TABLE import_file_outcome (
          id               TEXT PRIMARY KEY,
          operation_id     TEXT NOT NULL REFERENCES operation (id) ON DELETE CASCADE,

          -- The file's prior (source) path, copied at write time rather than
          -- referenced from the plan — same reason rename_file_outcome
          -- copies its paths: this must survive the plan being purged.
          path             TEXT NOT NULL,
          -- {kind, seriesId/movieId, episodeIds?, label, importedPath} —
          -- the item this file was mapped to, plus where it actually landed.
          destination_json TEXT NOT NULL,
          mapping_source   TEXT NOT NULL CHECK (mapping_source IN ('instance','operator')),

          outcome          TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','unverified')),
          error            TEXT
        );

        CREATE INDEX idx_import_file_outcome_operation_id
          ON import_file_outcome (operation_id);
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
