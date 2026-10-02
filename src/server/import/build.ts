import 'server-only';

import type { ImportBulkSkip, ImportMapping, ImportPlan, ImportPlanRow } from '@/lib/importPlan';
import {
  type ArrEpisodeRef,
  type InstanceClient,
  isDecisionsClient,
  isImportClient,
} from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';
import {
  createImportPlan,
  getImportPlan,
  updateImportRow,
  updateImportRows,
  type ImportRowUpdateError,
  type ImportRowsUpdateError,
} from './store';
import { resolveImportRows, type ResolvedImportRow } from './resolve';

/**
 * Opens a force-import plan from an instance's own `manualimport` candidates
 * (ADR-3), and the two row edits a plan in `ready` allows: toggling inclusion
 * and overriding a mapping (ADR-4).
 */

export interface BuildImportPlanInput {
  instanceId: string;
  queueRecordId: number;
  downloadId: string;
  title: string;
}

export type BuildImportPlanError =
  | { kind: 'instance-unavailable'; reason: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'upstream'; reason: string };

export type BuildImportPlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; error: BuildImportPlanError };

/**
 * A row starts included only when the instance resolved a target for it and
 * importing it would not overwrite an existing file (ADR-8). Rejections
 * never factor in here — force import exists precisely for files the
 * instance rejected, so a rejected-but-mapped, non-replacing row still
 * starts included; its rejections are shown, not treated as a reason to
 * exclude.
 */
function defaultIncluded(row: Pick<ImportPlanRow, 'mapping' | 'replacesExisting'>): boolean {
  return row.mapping !== null && row.replacesExisting === null;
}

/**
 * Reads the candidates and persists them as a new plan in `ready`. No
 * `building` phase: `manualimport` is one synchronous read, so there is
 * nothing to poll (state-import-plan.md).
 */
export async function buildImportPlan(
  input: BuildImportPlanInput,
  signal?: AbortSignal,
): Promise<BuildImportPlanResult> {
  const resolved = clientFor(input.instanceId);
  if (!resolved) {
    return {
      ok: false,
      error: { kind: 'instance-unavailable', reason: 'That instance is no longer configured or is disabled.' },
    };
  }
  if (!isImportClient(resolved.client) || (resolved.kind !== 'sonarr' && resolved.kind !== 'radarr')) {
    return { ok: false, error: { kind: 'unsupported', reason: `${resolved.label} cannot import files.` } };
  }
  const instanceKind = resolved.kind;

  const resolvedRows = await resolveImportRows(resolved.client, input.downloadId, signal);
  if (!resolvedRows.ok) {
    return { ok: false, error: { kind: 'upstream', reason: resolvedRows.error.reason } };
  }

  const named = await nameReplacedQualities(resolved.client, resolvedRows.value, signal);
  const rows: Array<Omit<ImportPlanRow, 'outcome'>> = named.map((row) => ({
    ...row,
    included: defaultIncluded(row),
  }));

  const plan = createImportPlan({
    instanceId: resolved.id,
    instanceKind,
    instanceLabel: resolved.label,
    downloadId: input.downloadId,
    queueRecordId: input.queueRecordId,
    title: input.title,
    rows,
  });

  return { ok: true, plan };
}

/**
 * The candidate list carries the fact of a replacement but not the quality of
 * the file it would replace, so each such file is read by id (ADR-8) — once
 * per distinct file, and only for rows that replace something. A failed read
 * leaves the quality null: the row is still flagged and still starts
 * excluded, it just cannot name what it would overwrite.
 */
async function nameReplacedQualities(
  client: InstanceClient,
  rows: ResolvedImportRow[],
  signal?: AbortSignal,
): Promise<ResolvedImportRow[]> {
  if (!isDecisionsClient(client)) return rows;
  const ids = [...new Set(rows.flatMap((row) => (
    row.replacesExisting?.quality === null && row.replacesExisting.fileId !== null
      ? [row.replacesExisting.fileId]
      : []
  )))];
  if (ids.length === 0) return rows;

  const names = new Map<number, string>();
  await Promise.all(ids.map(async (id) => {
    const file = await client.existingFile(id, signal);
    const name = file.ok ? file.value?.quality?.quality.name ?? null : null;
    if (name !== null) names.set(id, name);
  }));

  return rows.map((row) => {
    const fileId = row.replacesExisting?.fileId ?? null;
    const name = fileId !== null ? names.get(fileId) : undefined;
    return name === undefined || !row.replacesExisting
      ? row
      : { ...row, replacesExisting: { ...row.replacesExisting, quality: name } };
  });
}

/* ── Row edits (ADR-4) ─────────────────────────────────────────────────────── */

export type EditImportRowError = ImportRowUpdateError | 'invalid-mapping' | 'radarr-mapping-fixed';
export type EditImportRowResult = { ok: true } | { ok: false; error: EditImportRowError };

function seriesMappingOf(mapping: ImportMapping | null): Extract<ImportMapping, { kind: 'series' }> | null {
  return mapping?.kind === 'series' ? mapping : null;
}

/** Whatever series any row in this plan has already resolved to — see `editImportRow`. */
function planSeriesId(plan: ImportPlan): number | null {
  for (const row of plan.rows) {
    const mapping = seriesMappingOf(row.mapping);
    if (mapping) return mapping.seriesId;
  }
  return null;
}

/**
 * Includes or re-maps one row. A mapping override is validated before it
 * ever reaches the store:
 *
 * - Radarr's movie is fixed in this change (ADR-4) — there is no second movie
 *   to offer, so an override is refused outright rather than silently
 *   accepted and ignored.
 * - On Sonarr the override must stay inside the series this download belongs
 *   to (ADR-4's "the picker offers seasons and episodes of the candidate's
 *   series"). A force-import plan covers one `downloadId`, which is one
 *   series pack, so that series is read off whatever row in the plan already
 *   has a series mapping — there being none at all means there is no series
 *   context to validate against.
 * - The chosen episode ids must belong to that series' own episode list, read
 *   fresh via `seriesEpisodes` rather than trusted from the request body.
 */
export async function editImportRow(
  planId: string,
  ordinal: number,
  patch: { included?: boolean; mapping?: ImportMapping },
  signal?: AbortSignal,
): Promise<EditImportRowResult> {
  if (patch.mapping === undefined) {
    const result = updateImportRow(planId, ordinal, patch);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  const plan = getImportPlan(planId);
  if (!plan) return { ok: false, error: 'row-not-found' };

  if (plan.instanceKind === 'radarr') {
    return { ok: false, error: 'radarr-mapping-fixed' };
  }
  if (patch.mapping.kind !== 'series') {
    return { ok: false, error: 'invalid-mapping' };
  }

  const seriesId = planSeriesId(plan);
  if (seriesId === null || seriesId !== patch.mapping.seriesId) {
    return { ok: false, error: 'invalid-mapping' };
  }

  const resolved = clientFor(plan.instanceId);
  if (!resolved || !isImportClient(resolved.client)) {
    return { ok: false, error: 'invalid-mapping' };
  }

  const episodes = await resolved.client.seriesEpisodes(seriesId, signal);
  if (!episodes.ok) return { ok: false, error: 'invalid-mapping' };

  const validIds = new Set(episodes.value.map((episode) => episode.id));
  if (patch.mapping.episodeIds.length === 0 || !patch.mapping.episodeIds.every((id) => validIds.has(id))) {
    return { ok: false, error: 'invalid-mapping' };
  }

  const result = updateImportRow(planId, ordinal, patch);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export type EditImportRowsError = ImportRowsUpdateError;
export type EditImportRowsResult =
  | { ok: true; changed: number; skipped: ImportBulkSkip[] }
  | { ok: false; error: EditImportRowsError };

/**
 * "Include all" / "Exclude all" / "Include all replacements" and range
 * inclusion (ADR-6, REQ-QUEUE-025). Unlike `editImportRow`, there is no
 * mapping to validate — a bulk edit only ever sets `included`, so this is a
 * thin pass to `updateImportRows`'s single transaction, kept as its own
 * function so the route dispatches on request shape rather than reaching
 * into `store.ts` directly.
 */
export function editImportRows(
  planId: string,
  ordinals: number[],
  included: boolean,
): EditImportRowsResult {
  return updateImportRows(planId, ordinals, included);
}

export type EpisodeChoicesResult =
  | { ok: true; episodes: ArrEpisodeRef[] }
  | { ok: false; reason: string };

/**
 * The series episode picker's source (ADR-4, wireframes/screen-force-import
 * .md's "Change…"). Read on demand when the picker opens — never pre-fetched
 * for every row (NFR2) — and scoped to whatever series the plan's own
 * mappings already name.
 */
export async function episodeChoices(planId: string, signal?: AbortSignal): Promise<EpisodeChoicesResult> {
  const plan = getImportPlan(planId);
  if (!plan) return { ok: false, reason: 'That plan no longer exists.' };

  const seriesId = planSeriesId(plan);
  if (seriesId === null) return { ok: false, reason: 'No series could be resolved for this plan.' };

  const resolved = clientFor(plan.instanceId);
  if (!resolved || !isImportClient(resolved.client)) {
    return { ok: false, reason: `${plan.instanceLabel} is no longer reachable.` };
  }

  const episodes = await resolved.client.seriesEpisodes(seriesId, signal);
  if (!episodes.ok) return { ok: false, reason: episodes.error.reason };

  return { ok: true, episodes: episodes.value };
}
