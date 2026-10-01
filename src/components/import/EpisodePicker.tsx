'use client';

import { useCallback, useMemo, useState } from 'react';

import { useImportEpisodeChoices } from '@/components/import/useImport';
import { baseName } from '@/components/import/CandidateGrid';
import { Callout, Modal } from '@/components/ui';
import { ApiError, type ImportEpisodeChoice } from '@/lib/api';
import type { ImportMapping, ImportPlanRow } from '@/lib/importPlan';

/**
 * "Change…" — the Sonarr episode picker (T17; FR7, ADR-4).
 *
 * The series is fixed: a force-import plan covers one download, which is one
 * series pack, and the server refuses an override that leaves it. The operator
 * picks a season, then one or more episodes — multi-select, because a
 * multi-episode file maps to more than one.
 *
 * The episode list is read when this dialog mounts and not before (NFR2), so
 * the screen mounts it only while it is open. Nothing here is applied
 * optimistically: "Apply" sends the mapping, and the grid changes when the
 * server's copy of the plan comes back.
 *
 * Radarr never reaches this component — one record maps to exactly one movie
 * and there is nothing to remap against.
 */

export interface PickerSeries {
  seriesId: number;
  seriesTitle: string | null;
}

export interface EpisodePickerProps {
  planId: string;
  row: ImportPlanRow;
  /** The plan's series, read off whichever row already carries a series mapping. */
  series: PickerSeries | null;
  /** Fallback label when the instance gave the series no title. */
  planTitle: string;
  instanceLabel: string;
  /** The mapping edit is in flight. */
  busy: boolean;
  /** The last edit's failure, in words. */
  error: string | null;
  onCancel: () => void;
  onApply: (mapping: ImportMapping) => void;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The same shape `resolve.ts` writes for the instance's own mappings —
 * "Series — S01E02", "Series — S01E02–E03" — so an operator mapping reads like
 * the instance mapping it replaced. Non-contiguous picks are listed, not
 * ranged, because a range would name episodes that were not chosen.
 */
export function mappingLabel(
  seriesTitle: string | null,
  seasonNumber: number,
  episodeNumbers: number[],
): string {
  const sorted = [...episodeNumbers].sort((a, b) => a - b);
  let range: string;
  if (sorted.length === 0) {
    range = `S${pad(seasonNumber)}`;
  } else if (sorted.length === 1) {
    range = `S${pad(seasonNumber)}E${pad(sorted[0])}`;
  } else {
    const contiguous = sorted.every((value, at) => at === 0 || value === sorted[at - 1] + 1);
    range = contiguous
      ? `S${pad(seasonNumber)}E${pad(sorted[0])}–E${pad(sorted[sorted.length - 1])}`
      : `S${pad(seasonNumber)}${sorted.map((value) => `E${pad(value)}`).join(', ')}`;
  }
  return seriesTitle ? `${seriesTitle} — ${range}` : range;
}

export default function EpisodePicker({
  planId, row, series, planTitle, instanceLabel, busy, error, onCancel, onApply,
}: EpisodePickerProps) {
  const choices = useImportEpisodeChoices(planId, series !== null);
  const episodes = useMemo(() => choices.data ?? [], [choices.data]);

  const current = row.mapping?.kind === 'series' ? row.mapping : null;

  const seasons = useMemo(() => {
    const set = new Set(episodes.map((episode) => episode.seasonNumber));
    return [...set].sort((a, b) => a - b);
  }, [episodes]);

  // Starts on the row's current season when it has one, otherwise the first
  // non-special season the instance lists.
  const [season, setSeason] = useState<number | null>(current?.seasonNumber ?? null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(
    () => new Set(current?.episodeIds ?? []),
  );

  const effectiveSeason = season ?? seasons.find((value) => value > 0) ?? seasons[0] ?? null;

  const inSeason = useMemo(
    () => episodes
      .filter((episode) => episode.seasonNumber === effectiveSeason)
      .sort((a, b) => a.episodeNumber - b.episodeNumber),
    [episodes, effectiveSeason],
  );

  // A pick only counts inside the season on screen — switching season starts
  // the episode choice over rather than mapping across two seasons at once.
  const chosen: ImportEpisodeChoice[] = inSeason.filter((episode) => picked.has(episode.id));
  const replacing = chosen.filter((episode) => episode.hasFile);

  const toggle = useCallback((id: number) => {
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const close = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);

  const apply = useCallback(() => {
    if (!series || effectiveSeason === null || chosen.length === 0) return;
    const title = series.seriesTitle;
    onApply({
      kind: 'series',
      seriesId: series.seriesId,
      seriesTitle: title,
      seasonNumber: effectiveSeason,
      episodeIds: chosen.map((episode) => episode.id),
      label: mappingLabel(title, effectiveSeason, chosen.map((episode) => episode.episodeNumber)),
    });
  }, [series, effectiveSeason, chosen, onApply]);

  const name = baseName(row.path);

  return (
    <Modal
      title="Map this file to…"
      labelledBy="import-picker-title"
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={apply}
            disabled={busy || series === null || chosen.length === 0}
          >
            {busy ? 'Saving…' : 'Apply'}
          </button>
        </>
      )}
    >
      <p className="modal__lead">
        <span className="mono" style={{ overflowWrap: 'anywhere' }}>{name}</span>
        <br />
        <span className="subtle">
          {row.mapping
            ? `${instanceLabel} resolved it to ${row.mapping.label}.`
            : `${instanceLabel} could not resolve a target for it.`}
          {' '}Your choice is recorded as yours, not the instance&rsquo;s. Nothing is imported
          until you confirm the whole plan.
        </span>
      </p>

      <dl className="kv" style={{ marginBottom: 'var(--space-4)' }}>
        <dt className="kv__k">Series</dt>
        <dd className="kv__v">
          {series?.seriesTitle ?? planTitle} <span className="subtle">(fixed)</span>
        </dd>
      </dl>

      {series === null ? (
        <Callout tone="warn">
          No row in this plan carries a series {instanceLabel} resolved, so there is no series
          to map this file into. Rebuild the preview once {instanceLabel} recognises the download.
        </Callout>
      ) : choices.isPending ? (
        <p className="scope__loading" style={{ padding: 'var(--space-3) 0' }}>
          <span className="spinner" aria-hidden="true" />
          Reading episodes from {instanceLabel}…
        </p>
      ) : choices.isError ? (
        <Callout tone="error">
          {choices.error instanceof ApiError ? choices.error.message : 'The episode list could not be read.'}
          {' '}Close this and try again; the mapping is unchanged.
        </Callout>
      ) : seasons.length === 0 ? (
        <Callout tone="warn">{instanceLabel} lists no episodes for this series.</Callout>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 'var(--space-4)' }}>
            <label className="field__label" htmlFor="import-picker-season">Season</label>
            <select
              id="import-picker-season"
              className="input"
              value={effectiveSeason ?? ''}
              onChange={(event) => setSeason(Number(event.target.value))}
              disabled={busy}
            >
              {seasons.map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? 'Specials' : `Season ${value}`}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="season-pick" disabled={busy}>
            <legend>Episodes — a multi-episode file maps to more than one</legend>
            {inSeason.map((episode) => (
              <label key={episode.id} className="season-pick__option">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={picked.has(episode.id)}
                  onChange={() => toggle(episode.id)}
                />
                <span>
                  <span className="mono">E{pad(episode.episodeNumber)}</span>{' '}
                  {episode.title ?? <span className="subtle">untitled</span>}
                </span>
                {episode.hasFile ? (
                  <span className="subtle">has a file</span>
                ) : null}
              </label>
            ))}
          </fieldset>

          {replacing.length > 0 ? (
            <Callout tone="warn">
              {replacing.length === 1 ? 'That episode already has' : `${replacing.length} of those episodes already have`}
              {' '}a file. Importing onto {replacing.length === 1 ? 'it' : 'them'} replaces what is
              there, and {instanceLabel} will call it an upgrade whatever the quality.
            </Callout>
          ) : null}
        </>
      )}

      {error ? (
        <Callout tone="error">{error}</Callout>
      ) : null}
    </Modal>
  );
}
