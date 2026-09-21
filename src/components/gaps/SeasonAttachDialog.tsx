'use client';

import { useState } from 'react';

import type { SeasonTally } from '@/components/gaps/GapsGrid';
import { useSeasonAttachPreview } from '@/components/gaps/useGaps';
import { Callout, Modal } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { isAttachableLink } from '@/lib/attach';
import type { Gap } from '@/lib/types';

/**
 * The season-attach confirmation (FR4..FR8; REQ-GAPS-012, -017..-021; T10).
 *
 * `AttachDialog`'s sibling, and deliberately so: same pre-flight contract, same
 * "gated on the link alone" rule, same closes-on-response. Two things are new,
 * and both come from the scope being ten files instead of one.
 *
 * 1. **A season has to be chosen before anything is asked.** The chooser is a
 *    radio group with nothing checked, not a `<select>` — a `<select>` answers
 *    the question from its first render, which would make "no upstream request
 *    before the operator chooses" (REQ-GAPS-018) a matter of suppressing a
 *    default rather than a fact about the markup.
 * 2. **Two disclosures ride on top of the ordinary ones, and they are overlays
 *    rather than alternatives.** A season can be partially filed *and* parse as
 *    a multi-season range; showing one instead of the other would drop a fact
 *    the operator is about to act on.
 *
 * What is unchanged is the part that matters most: nothing here blocks. A
 * partially-filed season (ADR-2) and a multi-season pack (ADR-3) are stated with
 * their consequence and the button stays live.
 */

export interface SeasonAttachDialogProps {
  /**
   * Any gap from the series group. The season attach is addressed by gap id and
   * a season number — this one names the series, the instance, and the id.
   */
  gap: Gap;
  /** The seasons this series is missing something from, ascending. */
  seasons: SeasonTally[];
  onCancel: () => void;
  /** The screen owns the mutation so it can toast the outcome and close. */
  onConfirm: (season: number, link: string) => void;
  /** A push is in flight. Cancel and Escape go inert — neither can recall it. */
  busy: boolean;
}

export default function SeasonAttachDialog({
  gap,
  seasons,
  onCancel,
  onConfirm,
  busy,
}: SeasonAttachDialogProps) {
  // One season with gaps is not an ambiguous question, so it is not asked —
  // preselected, and still named in the confirmation (REQ-GAPS-012).
  const [season, setSeason] = useState<number | null>(
    seasons.length === 1 ? seasons[0].season : null,
  );
  const [link, setLink] = useState('');

  const touched = link.trim().length > 0;
  const wellFormed = touched && isAttachableLink(link);

  // Keyed on gap *and* season, and disabled until both exist. Re-choosing the
  // season asks again rather than reusing the previous season's answer.
  const preview = useSeasonAttachPreview(gap.id, season);

  const data = preview.data;
  const mismatched = data !== undefined && !data.matchesSeason && data.target.resolved;
  const unresolved = data !== undefined && !data.target.resolved;
  const risky = mismatched || unresolved || preview.isError;

  // Absent, never zero (ADR-4, state 8). A failed `GET /series/{id}` leaves both
  // counts null, and a null rendered as `0 of 0` would read as "nothing is filed
  // here" — the opposite of a warning.
  const filed = data?.seasonFileCount ?? null;
  const total = data?.seasonEpisodeCount ?? null;
  const partial = filed !== null && total !== null && filed > 0;
  const multiSeason = data?.target.isMultiSeason === true;

  const scope = season === null
    ? gap.groupTitle
    : `${gap.groupTitle} — season ${season}`;

  return (
    <Modal
      title={`Attach a season pack to ${gap.groupTitle}`}
      labelledBy="season-attach-title"
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={risky ? 'btn btn-outline' : 'btn btn-primary'}
            onClick={() => { if (season !== null && wellFormed) onConfirm(season, link.trim()); }}
            // Gated on the link — and on a season existing to attach to, which
            // is not the pre-flight having an opinion. A failed or unflattering
            // pre-flight never disables this (REQ-GAPS-017).
            disabled={busy || !wellFormed || season === null}
          >
            {attachLabel({ busy, risky, wellFormed, instanceLabel: gap.instanceLabel })}
          </button>
        </>
      )}
    >
      {season === null ? (
        <fieldset className="season-pick">
          <legend>Which season?</legend>
          {seasons.map((tally) => (
            <label key={tally.season} className="season-pick__option">
              <input
                type="radio"
                name="season"
                value={tally.season}
                checked={false}
                onChange={() => setSeason(tally.season)}
                disabled={busy}
              />
              <span>{seasonName(tally.season)}</span>
              {/* helparr's own row count, and it says so. The authoritative
                  "N of M" arrives with the pre-flight, from Sonarr. */}
              <span className="subtle">{tally.missing} missing</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <p className="season-pick__chosen">
            <span>{seasonName(season)}</span>
            {seasons.length > 1 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => { setSeason(null); }}
                disabled={busy}
              >
                change ▸
              </button>
            ) : null}
          </p>

          {/* One label, visible and associated — the field's name is worth
              showing, so there is nothing here for an `sr-only` duplicate. */}
          <label
            className="subtle"
            htmlFor="season-attach-link"
            style={{ display: 'block', fontSize: 'var(--text-xs)', marginBottom: 'var(--space-2)' }}
          >
            Magnet link or .torrent URL
          </label>
          <textarea
            id="season-attach-link"
            className="input attach-link mono"
            rows={3}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={busy}
            placeholder="magnet:?xt=urn:btih:…"
            spellCheck={false}
            aria-invalid={touched && !wellFormed}
            aria-describedby="season-attach-link-note"
          />
          <p
            id="season-attach-link-note"
            className="subtle"
            style={{ fontSize: 'var(--text-xs)', marginTop: 'var(--space-2)' }}
          >
            Paste the link exactly as copied from the indexer.
          </p>

          {touched && !wellFormed ? (
            <Callout tone="warn">
              Expected a <span className="mono">magnet:</span> URI or a URL ending in{' '}
              <span className="mono">.torrent</span>.
            </Callout>
          ) : null}

          <div className="grab-resolve">
            {preview.isPending ? (
              <p className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
                Asking {gap.instanceLabel} what it makes of the name helparr would send…
              </p>
            ) : preview.isError ? (
              <Callout tone="warn">
                {gap.instanceLabel} did not answer the pre-flight
                {preview.error instanceof ApiError ? ` — ${preview.error.message}` : '.'}
                {' '}
                helparr cannot say where this would be filed, so the attach is offered
                unconfirmed.
              </Callout>
            ) : data === undefined ? null : (
              <>
                {mismatched ? (
                  // The branch the pre-flight exists for, with the season named
                  // on both sides (REQ-GAPS-017).
                  <Callout tone="warn">
                    <p style={{ fontWeight: 600 }}>
                      {gap.instanceLabel} reads this as a different series or season
                    </p>
                    <dl className="kv" style={{ marginTop: 'var(--space-3)' }}>
                      <dt className="kv__k">You selected</dt>
                      <dd className="kv__v">{scope}</dd>
                      <dt className="kv__k">{gap.instanceLabel} resolved</dt>
                      <dd className="kv__v">{resolvedScope(data.target)}</dd>
                    </dl>
                    <p style={{ marginTop: 'var(--space-3)' }}>
                      Attaching anyway will file it as {resolvedScope(data.target)}.
                    </p>
                  </Callout>
                ) : unresolved ? (
                  <Callout tone="warn">
                    <p>{gap.instanceLabel} could not resolve a destination from this name.</p>
                    <p style={{ marginTop: 'var(--space-2)' }}>
                      Attaching will hand the download over without a confirmed target — it
                      will download and then sit there unimported.
                    </p>
                  </Callout>
                ) : (
                  <>
                    <p className="subtle" style={{ fontSize: 'var(--text-xs)' }}>Will import as</p>
                    <div className="grab-target card">
                      <p style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>{scope}</p>
                      {/* The instance's own count of what the name resolved to.
                          helparr never restates the episode set (FR4). */}
                      {data.target.episodeCount > 0 ? (
                        <p className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>
                          {gap.instanceLabel} resolved {data.target.episodeCount}{' '}
                          {data.target.episodeCount === 1 ? 'episode' : 'episodes'}
                        </p>
                      ) : null}
                      {data.path ? (
                        <p className="subtle mono" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>
                          {data.path}
                        </p>
                      ) : null}
                    </div>
                  </>
                )}

                {/* Overlays, not alternatives: a partially-filed season can also
                    parse as a range, and dropping either fact would be dropping
                    one the operator is about to act on. */}
                {partial ? (
                  <Callout tone="warn">
                    <p>
                      {filed} of {total} episodes in this season already have a file.
                    </p>
                    <p style={{ marginTop: 'var(--space-2)' }}>
                      {gap.instanceLabel} will reject those as not an upgrade, and the
                      download can sit in the queue until you clear it by hand.
                    </p>
                  </Callout>
                ) : null}

                {multiSeason ? (
                  <Callout tone="warn">
                    <p>
                      {gap.instanceLabel} reads this name as spanning more than one season
                      {data.target.seasonNumber !== null
                        ? `, and resolved only season ${data.target.seasonNumber}`
                        : ''}
                      .
                    </p>
                    <p style={{ marginTop: 'var(--space-2)' }}>
                      The other seasons will download and never be imported. helparr cannot
                      map them — the same torrent cannot be attached twice.
                    </p>
                  </Callout>
                ) : null}

                {/* The standing risk, not a branch: even a correct parse maps the
                    download by name. If the pack is actually a different season,
                    it is filed as this one. */}
                {!mismatched && !unresolved ? (
                  <Callout tone="warn">
                    The download is mapped to this season regardless of what the release
                    name says. If the pack is actually a different season,{' '}
                    {gap.instanceLabel} will import it under the wrong numbers.
                  </Callout>
                ) : null}
              </>
            )}
          </div>

          {/* The name being offered, shown plainly. It is the whole mechanism —
              a season token and no episode token — and hiding it would make
              every branch above unexplainable (REQ-GAPS-019). */}
          {data ? (
            <p className="subtle mono truncate" style={{ fontSize: 'var(--text-xs)' }}>
              sending as {data.title}
            </p>
          ) : null}
        </>
      )}

      {busy ? (
        <p className="subtle" aria-busy="true" role="status" style={{ fontSize: 'var(--text-sm)' }}>
          Sending to {gap.instanceLabel}…
        </p>
      ) : (
        <Callout tone="info">helparr has sent nothing yet.</Callout>
      )}
    </Modal>
  );
}

/** Season 0 is specials in Sonarr's own numbering, and is named as such. */
export function seasonName(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`;
}

/**
 * What the instance said it resolved, named at season scope. The parse label is
 * an episode-code join, so the season is appended rather than read out of it.
 */
function resolvedScope(target: { label: string | null; seasonNumber: number | null }): string {
  const label = target.label ?? 'an untitled entry';
  return target.seasonNumber === null
    ? label
    : `${label} (${seasonName(target.seasonNumber).toLowerCase()})`;
}

/** The button says what pressing it does, including when that is the risky thing. */
function attachLabel({
  busy,
  risky,
  wellFormed,
  instanceLabel,
}: {
  busy: boolean;
  risky: boolean;
  wellFormed: boolean;
  instanceLabel: string;
}): string {
  if (busy) return 'Attaching…';
  if (!wellFormed) return 'Attach';
  if (risky) return 'Attach anyway';
  return `Attach to ${instanceLabel}`;
}
