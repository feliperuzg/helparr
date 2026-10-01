import 'server-only';

import type { ImportMapping, ImportPlanRow, ImportReplacement } from '@/lib/importPlan';
import {
  type ArrImportCandidate,
  type ClientResult,
  type ImportClient,
} from '@/server/clients/types';

/**
 * The one resolution preview and the drift check share (REQ-RENAME-012's
 * analogue, load-bearing property 2 in plan.md). `buildImportPlan` (T7) calls
 * this to produce what the operator reads; `startImport`'s drift check (T8)
 * calls it again, against the same `downloadId`, to see whether what the
 * operator read is still true. If those two reads were computed by different
 * code they could disagree in a way no test would catch.
 *
 * It performs no writes: one `/manualimport?downloadId=` read and arithmetic
 * on what comes back. `mappingSource` on every row here is `'instance'` —
 * nothing produced by a fresh instance read has ever been touched by an
 * operator, by construction.
 */

export type ResolvedImportRow = Omit<ImportPlanRow, 'outcome' | 'included'>;

/* ── Mapping and replacement, derived from the candidate alone ───────────── */

/**
 * `S01E03` for one episode, `S01E03–E04` for a multi-episode file. No extra
 * request: everything here comes from the candidate's own nested `episodes`
 * (NFR2 — no read that scales with rows).
 */
function episodeRangeLabel(seasonNumber: number, episodeNumbers: number[]): string {
  const season = String(seasonNumber).padStart(2, '0');
  const sorted = [...episodeNumbers].sort((a, b) => a - b);
  if (sorted.length === 0) return `S${season}`;
  if (sorted.length === 1) return `S${season}E${String(sorted[0]).padStart(2, '0')}`;
  const first = String(sorted[0]).padStart(2, '0');
  const last = String(sorted[sorted.length - 1]).padStart(2, '0');
  return `S${season}E${first}–E${last}`;
}

function seriesLabel(seriesTitle: string | null, seasonNumber: number, episodeNumbers: number[]): string {
  const range = episodeRangeLabel(seasonNumber, episodeNumbers);
  return seriesTitle ? `${seriesTitle} — ${range}` : range;
}

function movieLabel(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

/** Null means the instance could not resolve a target for this file (ADR-4). */
function resolveMapping(candidate: ArrImportCandidate): ImportMapping | null {
  if (candidate.seriesId !== null && candidate.episodes.length > 0) {
    const seasonNumber = candidate.seasonNumber ?? candidate.episodes[0].seasonNumber;
    const episodeNumbers = candidate.episodes.map((episode) => episode.episodeNumber);
    return {
      kind: 'series',
      seriesId: candidate.seriesId,
      seriesTitle: candidate.seriesTitle,
      seasonNumber,
      episodeIds: candidate.episodes.map((episode) => episode.id),
      label: seriesLabel(candidate.seriesTitle, seasonNumber, episodeNumbers),
    };
  }
  if (candidate.movieId !== null && candidate.movie) {
    return {
      kind: 'movie',
      movieId: candidate.movieId,
      label: movieLabel(candidate.movie.title, candidate.movie.year),
    };
  }
  return null;
}

/**
 * Flags a row whose mapped target already has a file (ADR-8). The existing
 * file's id is read straight off the candidate's nested episode/movie — no
 * `existingFile(id)` call here, because that call costs a request per row and
 * the drift re-read at apply time needs only the fact of a replacement, not
 * its quality. `buildImportPlan` names the quality afterwards, one read per
 * replaced file (ADR-8).
 */
function resolveReplacement(candidate: ArrImportCandidate): ImportReplacement | null {
  if (candidate.seriesId !== null && candidate.episodes.length > 0) {
    const existing = candidate.episodes.find((episode) => episode.hasFile);
    if (!existing) return null;
    return { quality: null, fileId: existing.episodeFileId };
  }
  if (candidate.movieId !== null && candidate.movie?.hasFile) {
    return { quality: null, fileId: candidate.movie.movieFileId };
  }
  return null;
}

function toResolvedRow(candidate: ArrImportCandidate, ordinal: number): ResolvedImportRow {
  return {
    ordinal,
    path: candidate.path,
    relativePath: candidate.relativePath,
    size: candidate.size,
    quality: { name: candidate.quality?.quality.name ?? null, model: candidate.quality },
    languages: candidate.languages,
    releaseGroup: candidate.releaseGroup,
    indexerFlags: candidate.indexerFlags,
    releaseType: candidate.releaseType,
    customFormats: candidate.customFormats,
    customFormatScore: candidate.customFormatScore,
    mapping: resolveMapping(candidate),
    mappingSource: 'instance',
    rejections: candidate.rejections,
    replacesExisting: resolveReplacement(candidate),
  };
}

/**
 * Reads the instance's own `manualimport` candidates for one download and
 * normalizes each into the row shape the review grid, the store and the
 * drift check all share. Ordered by path rather than by whatever order the
 * instance returned, so a rebuild or a drift re-read renders the same rows
 * in the same places (FR6's steadiness, not REQ-QUEUE-021's own ordering
 * guarantee — the instance's candidate order is not documented as stable).
 */
export async function resolveImportRows(
  client: ImportClient,
  downloadId: string,
  signal?: AbortSignal,
): Promise<ClientResult<ResolvedImportRow[]>> {
  const candidates = await client.manualImportCandidates(downloadId, signal);
  if (!candidates.ok) return { ok: false, error: candidates.error };

  const sorted = [...candidates.value].sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, value: sorted.map((candidate, index) => toResolvedRow(candidate, index)) };
}

/* ── Drift (ADR-5) ─────────────────────────────────────────────────────────── */

function mappingsEqual(a: ImportMapping | null, b: ImportMapping | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'movie' && b.kind === 'movie') return a.movieId === b.movieId;
  if (a.kind === 'series' && b.kind === 'series') {
    if (a.seriesId !== b.seriesId || a.seasonNumber !== b.seasonNumber) return false;
    if (a.episodeIds.length !== b.episodeIds.length) return false;
    const sortedA = [...a.episodeIds].sort((x, y) => x - y);
    const sortedB = [...b.episodeIds].sort((x, y) => x - y);
    return sortedA.every((id, index) => id === sortedB[index]);
  }
  return false;
}

/**
 * Human-readable change lines between a stored plan's rows and a fresh
 * `resolveImportRows` read — empty means no drift (ADR-5). Pure: it takes
 * whatever two row sets the caller hands it and says what changed between
 * them by path, which is the one identity both a stored row and a freshly
 * resolved row carry.
 *
 * Scope is the caller's choice. `startImport` (T8) is expected to pass the
 * plan's own rows — not just the included ones — against the fresh read, so
 * that a candidate appearing or disappearing anywhere in the set is caught,
 * exactly as ADR-5's "a candidate gone or added" names a whole-set property,
 * not one scoped to what the operator happened to tick.
 *
 * A row's mapping is only compared when `mappingSource !== 'operator'`: an
 * operator who deliberately remapped a candidate is expected to disagree with
 * whatever the instance would resolve on a re-read, and that disagreement is
 * not drift — it is the point of ADR-4's override.
 */
export function diffImportRows(planRows: ImportPlanRow[], freshRows: ResolvedImportRow[]): string[] {
  const changes: string[] = [];
  const freshByPath = new Map(freshRows.map((row) => [row.path, row]));
  const planPaths = new Set(planRows.map((row) => row.path));

  for (const row of planRows) {
    const fresh = freshByPath.get(row.path);
    if (!fresh) {
      changes.push(`${row.path} — no longer in the instance's candidate set`);
      continue;
    }
    if (fresh.size !== row.size) {
      changes.push(`${row.path} — size changed (${row.size} → ${fresh.size} bytes)`);
    }
    if (row.mappingSource !== 'operator' && !mappingsEqual(row.mapping, fresh.mapping)) {
      changes.push(`${row.path} — the instance's resolved target changed`);
    }
  }

  for (const fresh of freshRows) {
    if (!planPaths.has(fresh.path)) {
      changes.push(`${fresh.path} — a new candidate appeared in the instance's set`);
    }
  }

  return changes;
}
