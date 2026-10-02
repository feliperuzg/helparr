/**
 * Client-safe types for force import (ADR-3, ADR-4, ADR-7, ADR-8).
 *
 * This is the contract every later task — build, resolve, apply, verify, the
 * API routes, the screen — codes against, same role `types.ts`'s rename
 * section plays for `rename_plan`. Kept in its own file rather than added to
 * `src/lib/types.ts` so this task and T3's `QueueRecord.cause` work can
 * proceed without touching the same file (ADR-14).
 *
 * No server imports here: this module is read by client components directly.
 */

export const IMPORT_PLAN_PHASES = ['ready', 'applying', 'done', 'refused', 'expired'] as const;
export type ImportPlanPhase = (typeof IMPORT_PLAN_PHASES)[number];

/**
 * What a candidate resolves to. `label` is carried on both variants so the
 * grid and the operation log can show "what this file was imported to"
 * without re-joining series/episode or movie lookups that may no longer
 * resolve by the time the row is read back (ADR-4).
 */
export type ImportMapping =
  | {
      kind: 'series';
      seriesId: number;
      seriesTitle: string | null;
      seasonNumber: number;
      episodeIds: number[];
      label: string;
    }
  | { kind: 'movie'; movieId: number; label: string };

/** Who produced the current `mapping` on a row (ADR-4, REQ-OPS-001 extension). */
export type MappingSource = 'instance' | 'operator';

/**
 * Three buckets, not two (ADR-7, REQ-QUEUE-022/FR10). `unverified` is a
 * distinct, honest outcome — neither history nor a candidate re-read
 * confirmed either way — never collapsed into `failed` or `succeeded`.
 */
export type ImportOutcomeKind = 'succeeded' | 'failed' | 'unverified';

export interface ImportRowOutcome {
  outcome: ImportOutcomeKind;
  /** `history`'s `importedPath` on `succeeded`; null otherwise. */
  destination: string | null;
  /** Upstream rejection text on `failed`; helparr's own explanation on `unverified`. */
  error: string | null;
}

/** The destination item's current quality, read when a row would replace it (ADR-8). */
export interface ImportReplacement {
  quality: string | null;
  fileId: number | null;
}

/** One candidate `manualimport` reported, as the review grid and the drift check see it. */
export interface ImportPlanRow {
  /** The instance's own candidate order (FR6), preserved for stable rendering. */
  ordinal: number;
  /** Precondition half 1 of 2 (FR9, REQ-QUEUE-022), captured at build time. */
  path: string;
  relativePath: string | null;
  /** Precondition half 2 of 2. */
  size: number;
  quality: { name: string | null; model: unknown };
  languages: { id: number; name: string }[];
  releaseGroup: string | null;
  indexerFlags: number;
  releaseType: string | null;
  customFormats: { id: number; name: string }[];
  customFormatScore: number | null;
  /** Null means the instance could not resolve a target — the row cannot be included (ADR-4). */
  mapping: ImportMapping | null;
  mappingSource: MappingSource;
  /** The candidate's own rejection reasons, verbatim (FR6). */
  rejections: string[];
  /** Set when the mapped item already has a file — drives `included`'s default (ADR-8). */
  replacesExisting: ImportReplacement | null;
  included: boolean;
  /** Null until the plan reaches `applying`; never written optimistically (ADR-7). */
  outcome: ImportRowOutcome | null;
}

/** Why a build or a confirm refused the whole plan (ADR-5, ADR-8's "replaces" is not here — that's per-row). */
export type ImportRefusalReason =
  | 'drift'
  | 'expired'
  | 'count-mismatch'
  | 'not-ready'
  | 'empty'
  | 'write-disabled'
  | 'record-gone';

export interface ImportRefusal {
  reason: ImportRefusalReason;
  /** What changed, in words — the only detail the refusal screen offers (ADR-5). */
  changes: string[];
}

export interface ImportPlan {
  id: string;
  instanceId: string;
  instanceKind: 'sonarr' | 'radarr';
  instanceLabel: string;
  /** The queue record's infohash — what `manualimport?downloadId=` was read with. */
  downloadId: string;
  /** The *arr record id this plan was opened from, for the inspector's "view import" link. */
  queueRecordId: number;
  title: string;
  phase: ImportPlanPhase;
  refusal: ImportRefusal | null;
  /** ISO 8601. Start of the 5-minute validity window. */
  createdAt: string;
  /** ISO 8601, `createdAt + 300s`. Computed once, never extended (ADR-3, matching `RENAME_PLAN_TTL_MS`). */
  expiresAt: string;
  rows: ImportPlanRow[];
}

/** FR11's analogue for force import. Five minutes, computed once, never extended. */
export const IMPORT_PLAN_TTL_MS = 5 * 60 * 1000;

/** What the typed-count gate is checked against — included rows, not every candidate (FR7). */
export function includedCount(plan: Pick<ImportPlan, 'rows'>): number {
  return plan.rows.filter((row) => row.included).length;
}

/* ── Bulk edit (ADR-6, REQ-QUEUE-025) ────────────────────────────────────── */

/** The bulk-PATCH request body's second arm — every named ordinal to one state. */
export interface ImportBulkEdit {
  ordinals: number[];
  included: boolean;
}

/** Why one ordinal in a bulk edit was left untouched. Only reason today: no mapping to include it with. */
export interface ImportBulkSkip {
  ordinal: number;
  reason: 'no-target';
}

/** What a bulk edit answers with, alongside the whole refreshed plan. */
export interface ImportBulkResult {
  changed: number;
  skipped: ImportBulkSkip[];
}

/** Ordinals of every row flagged as replacing an existing file — "Include all replacements"'s source set. */
export function replacementOrdinals(rows: readonly Pick<ImportPlanRow, 'ordinal' | 'replacesExisting'>[]): number[] {
  return rows.filter((row) => row.replacesExisting !== null).map((row) => row.ordinal);
}

/** Every row's ordinal, in order — "Include all" / "Exclude all"'s source set. */
export function allOrdinals(rows: readonly Pick<ImportPlanRow, 'ordinal'>[]): number[] {
  return rows.map((row) => row.ordinal);
}
