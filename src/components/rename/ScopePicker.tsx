'use client';

import { useMemo, useRef, useState } from 'react';

import Icon from '@/components/Icon';
import {
  Callout, ChipGroup, EmptyState, FilterChip, SearchField,
} from '@/components/ui';
import { useRenameTitles } from '@/components/rename/useRenameTitles';
import type { RenameTitleOption } from '@/lib/types';

/**
 * The scope picker (T10, FR1).
 *
 * FR1 asks for "one or more titles, across instances", which the prototype's
 * single `<select>` cannot express — a rename plan is routinely built from a
 * handful of series on one Sonarr plus a film on a Radarr, and a control that
 * holds one value forces four round trips through a five-minute expiry window
 * to do it. So: a filterable, multi-select list keyed by instance *and* title,
 * with the count that will be previewed stated on the button itself.
 *
 * Nothing here contacts an instance. Picking a scope is free; the build that
 * follows is not, which is why the count is visible before it is pressed.
 */

/** A long library is filtered, not scrolled. Rendering 4,000 checkbox rows to
 *  find one series is slow for the browser and useless for the operator. */
const RENDER_CAP = 300;

type Source = 'all' | 'sonarr' | 'radarr';

export interface ScopePickerProps {
  /** Selected title ids, owned by the screen so Regenerate can reuse them. */
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onReplace: (ids: string[]) => void;
  onGenerate: (titles: RenameTitleOption[]) => void;
  /** True while the create-plan call is in flight. */
  busy: boolean;
  /** Set when the previous attempt to start a build failed. */
  error?: string | null;
}

export default function ScopePicker({
  selected, onToggle, onReplace, onGenerate, busy, error = null,
}: ScopePickerProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<Source>('all');

  const read = useRenameTitles();
  const titles = useMemo(() => read.data?.titles ?? [], [read.data]);

  const counts = useMemo(() => ({
    all: titles.length,
    sonarr: titles.filter((title) => title.instanceKind === 'sonarr').length,
    radarr: titles.filter((title) => title.instanceKind === 'radarr').length,
  }), [titles]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return titles.filter((title) => (
      (source === 'all' || title.instanceKind === source)
      && (needle === ''
        || title.label.toLowerCase().includes(needle)
        || title.instanceLabel.toLowerCase().includes(needle))
    ));
  }, [titles, source, query]);

  const shown = visible.slice(0, RENDER_CAP);
  const chosen = useMemo(
    () => titles.filter((title) => selected.has(title.id)),
    [titles, selected],
  );

  const allShownSelected = shown.length > 0 && shown.every((title) => selected.has(title.id));

  function toggleShown() {
    const ids = new Set(selected);
    if (allShownSelected) shown.forEach((title) => ids.delete(title.id));
    else shown.forEach((title) => ids.add(title.id));
    onReplace([...ids]);
  }

  if (read.isPending) {
    return (
      <section className="section">
        <div className="card scope" aria-busy="true">
          <p className="scope__loading">
            <span className="spinner" aria-hidden="true" />
            Reading what each instance holds…
          </p>
        </div>
      </section>
    );
  }

  if (read.isError) {
    return (
      <section className="section">
        <Callout tone="error">
          {read.error instanceof Error ? read.error.message : 'Could not list your titles.'}
          {' '}Nothing was renamed.
        </Callout>
      </section>
    );
  }

  return (
    <>
      <div className="toolbar">
        <SearchField
          inputRef={searchRef}
          value={query}
          onChange={setQuery}
          label="Filter titles"
          placeholder="Filter by title or instance…"
        />
      </div>

      <div className="toolbar">
        <ChipGroup label="Source">
          {(['all', 'sonarr', 'radarr'] as const).map((option) => (
            <FilterChip
              key={option}
              label={option === 'all' ? 'All' : option === 'sonarr' ? 'Sonarr' : 'Radarr'}
              selected={source === option}
              count={counts[option]}
              onToggle={() => setSource(option)}
            />
          ))}
        </ChipGroup>
        <span className="toolbar__spacer" />
        <span className="subtle" style={{ fontSize: 'var(--text-xs)' }} role="status">
          {visible.length} of {titles.length} shown
        </span>
      </div>

      <div className="content__scroll">
        {read.data && read.data.errors.length > 0 ? (
          <section className="section">
            <Callout tone="warn">
              This list is incomplete — {read.data.errors.length}{' '}
              instance{read.data.errors.length === 1 ? '' : 's'} could not be read:
              <ul className="msg-list">
                {read.data.errors.map((instance) => (
                  <li key={instance.instanceId}>{instance.instanceLabel} — {instance.reason}</li>
                ))}
              </ul>
            </Callout>
          </section>
        ) : null}

        <section className="section">
          {titles.length === 0 ? (
            <EmptyState title="No titles to rename">
              No instance reported a series or a film. Add an instance under Settings, or
              check that the ones you have are reachable.
            </EmptyState>
          ) : visible.length === 0 ? (
            <EmptyState title="Nothing matches that filter">
              No title mentions &ldquo;{query.trim()}&rdquo;. Clear the filter to see everything.
            </EmptyState>
          ) : (
            <div className="card scope">
              <div className="scope__head">
                <label className="scope__all">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={allShownSelected}
                    onChange={toggleShown}
                  />
                  {allShownSelected ? 'Clear the listed titles' : 'Select every listed title'}
                </label>
                {visible.length > RENDER_CAP ? (
                  <span className="scope__cap">
                    Showing the first {RENDER_CAP} of {visible.length} — narrow the filter to
                    reach the rest.
                  </span>
                ) : null}
              </div>

              <ul className="scope__list">
                {shown.map((title) => (
                  <li key={title.id}>
                    <label className="scope__item">
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={selected.has(title.id)}
                        onChange={() => onToggle(title.id)}
                      />
                      <Icon
                        name={title.kind === 'series' ? 'tv' : 'film'}
                        size={12}
                        className="scope__kind"
                      />
                      <span className="scope__label">{title.label}</span>
                      <span className="scope__files mono">
                        {title.fileCount} file{title.fileCount === 1 ? '' : 's'}
                      </span>
                      <span className="scope__instance">{title.instanceLabel}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="section">
          {error ? <Callout tone="error">{error} Nothing was renamed.</Callout> : null}
          <div className="scope__foot">
            <p className="scope__note">
              Building a preview asks each instance to rescan the title and then to say what
              it <em>would</em> rename. It writes nothing — no file moves until you approve the
              plan on the next screen.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              // Disabled, never hidden: a control that vanishes teaches nothing
              // about why it is unavailable (components.md).
              disabled={chosen.length === 0 || busy}
              onClick={() => onGenerate(chosen)}
            >
              <Icon name="eye" size={13} />
              {busy
                ? 'Starting…'
                : `Generate preview (${chosen.length} title${chosen.length === 1 ? '' : 's'})`}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
