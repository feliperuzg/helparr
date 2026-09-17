import 'server-only';

import { randomUUID } from 'node:crypto';

import { SAVED_SEARCH_LIMIT, SAVED_SEARCH_NAME_MAX } from '@/lib/savedSearch';
import type { SavedSearchRead, SavedSearchRef } from '@/lib/types';
import { getDb } from '@/server/db';

/**
 * Persistence for saved searches (FR11, FR12; REQ-SEARCH-011, -013, -015).
 *
 * The same prepared-statement-per-call shape as the other stores: statements
 * are built against `getDb()` inside each function rather than at module scope,
 * because the handle is opened lazily and replaced wholesale when the process
 * reopens the database — a statement captured at import time would outlive the
 * connection it was prepared on.
 *
 * Nothing here touches Prowlarr. Listing saved searches has to work while the
 * indexer manager is unreachable (REQ-SEARCH-013 asks for the definition after
 * a restart, and a restart is exactly when nothing upstream is answering yet),
 * so resolution lives one layer up in `query.ts` and this module is a pure
 * read-write of what the operator typed.
 */

interface SavedSearchRecord {
  id: string;
  name: string;
  query: string;
  scope_json: string;
  categories_json: string;
  min_seeders: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

/** Rejected reasons that are the operator's to fix, not a 500. */
export class SavedSearchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SavedSearchError';
    this.status = status;
  }
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // A row whose JSON no longer parses is a row helparr wrote and can no
    // longer read. Dropping the scope degrades it to "every indexer", which is
    // wrong; dropping the whole search would lose the query the operator
    // typed. Empty-but-listed keeps the name and query visible, and the
    // resolution layer then reports it as scoped to nothing.
    return [];
  }
}

function toRead(record: SavedSearchRecord): SavedSearchRead {
  return {
    id: record.id,
    name: record.name,
    query: record.query,
    indexers: parseArray<SavedSearchRef>(record.scope_json).filter(isRef),
    categories: parseArray<number>(record.categories_json)
      .filter((id) => Number.isInteger(id) && id > 0),
    minSeeders: record.min_seeders,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    lastRunAt: record.last_run_at,
  };
}

function isRef(value: unknown): value is SavedSearchRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return Number.isInteger(ref.indexerId) && typeof ref.name === 'string';
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

/**
 * Every saved search, newest name-sorted rather than newest-first.
 *
 * The list is a menu the operator reads by name, and a menu that reorders
 * itself every time something is saved is a menu they have to re-read. `COLLATE
 * NOCASE` so "Weekly" and "weekly" sort together, matching the uniqueness rule.
 */
export function listSavedSearches(): SavedSearchRead[] {
  const rows = getDb()
    .prepare('SELECT * FROM saved_search ORDER BY name COLLATE NOCASE')
    .all() as SavedSearchRecord[];
  return rows.map(toRead);
}

export function getSavedSearch(id: string): SavedSearchRead | null {
  const row = getDb()
    .prepare('SELECT * FROM saved_search WHERE id = ?')
    .get(id) as SavedSearchRecord | undefined;
  return row ? toRead(row) : null;
}

/* ── Writes ───────────────────────────────────────────────────────────────── */

export interface SavedSearchInput {
  name: string;
  query: string;
  indexers: SavedSearchRef[];
  categories: number[];
  minSeeders: number;
}

function normaliseName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new SavedSearchError('A saved search needs a name.', 400);
  if (name.length > SAVED_SEARCH_NAME_MAX) {
    throw new SavedSearchError(`A name can be at most ${SAVED_SEARCH_NAME_MAX} characters.`, 400);
  }
  return name;
}

/**
 * SQLite reports the case-insensitive unique index as a constraint failure with
 * no structure to it. Translating it here means the route can answer "that name
 * is taken" instead of a 500, and means the check is not a racy SELECT-then-
 * INSERT that two tabs could both pass.
 */
function isNameCollision(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function createSavedSearch(input: SavedSearchInput): SavedSearchRead {
  const name = normaliseName(input.name);
  const db = getDb();

  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM saved_search')
    .get() as { count: number };
  if (count >= SAVED_SEARCH_LIMIT) {
    // Not a storage limit — the rows are tiny. It is a limit on a list the
    // operator has to scan by eye, and on the amount of it helparr will render
    // above the results.
    throw new SavedSearchError(
      `helparr keeps at most ${SAVED_SEARCH_LIMIT} saved searches. Delete one first.`,
      409,
    );
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  try {
    db.prepare(`
      INSERT INTO saved_search (
        id, name, query, scope_json, categories_json, min_seeders, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      input.query,
      JSON.stringify(input.indexers),
      JSON.stringify(input.categories),
      input.minSeeders,
      now,
      now,
    );
  } catch (error) {
    if (isNameCollision(error)) {
      throw new SavedSearchError(`A saved search called "${name}" already exists.`, 409);
    }
    throw error;
  }

  return getSavedSearch(id) as SavedSearchRead;
}

/**
 * Rename only (REQ-SEARCH-015).
 *
 * The definition is deliberately not editable. A saved search whose query can
 * be rewritten under its own name is one the operator can no longer trust to be
 * what they saved — and re-saving under the same name is one extra keystroke
 * away, with the old one visible while they decide.
 */
export function renameSavedSearch(id: string, rawName: string): SavedSearchRead {
  const name = normaliseName(rawName);

  try {
    const result = getDb()
      .prepare('UPDATE saved_search SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, new Date().toISOString(), id);
    if (result.changes === 0) throw new SavedSearchError('That saved search is gone.', 404);
  } catch (error) {
    if (isNameCollision(error)) {
      throw new SavedSearchError(`A saved search called "${name}" already exists.`, 409);
    }
    throw error;
  }

  return getSavedSearch(id) as SavedSearchRead;
}

/** True when a row was removed. False means it was already gone, not an error. */
export function deleteSavedSearch(id: string): boolean {
  return getDb().prepare('DELETE FROM saved_search WHERE id = ?').run(id).changes > 0;
}

/**
 * Records that a run happened. Audit only — nothing schedules off this, because
 * every run spends indexer quota (REQ-SEARCH-009).
 */
export function markSavedSearchRun(id: string): void {
  getDb()
    .prepare('UPDATE saved_search SET last_run_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}
