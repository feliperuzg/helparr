'use client';

import { useState } from 'react';

import { useResolvedTarget } from '@/components/search/useSearch';
import { Callout, Modal } from '@/components/ui';
import { ApiError, type GrabInput } from '@/lib/api';
import { formatBytes } from '@/lib/queue';
import type { InstanceHealthDto, ParsedTarget, ReleaseRead } from '@/lib/types';

/**
 * The grab confirmation (FR7, FR8; REQ-OPS-006, -007; ADR-3; T18).
 *
 * The one screen in helparr that precedes a write to an *arr, and it carries
 * four properties the rest of the change depends on:
 *
 * 1. **Nothing is sent by opening it.** The dialog issues a read-only `parse`
 *    to learn what the destination makes of the title. That read is the only
 *    upstream traffic until the operator presses the confirming button.
 * 2. **The confirmation names what the destination resolved**, not what the
 *    operator clicked (REQ-OPS-007). Sonarr and Radarr parse the same release
 *    title into different things, and one of them into nothing at all.
 * 3. **"Resolved to nothing" is the case that matters.** A release the
 *    destination cannot place is accepted and then never imported — it
 *    downloads and sits there. So that state is a warning with an explanation,
 *    and its button is labelled with the risk rather than with the wish.
 * 4. **No success renders here** (FR8, REQ-OPS-006). The dialog closes on a
 *    response and the outcome arrives as a toast, because a dialog that
 *    congratulates itself before the instance has answered is claiming
 *    something it does not know.
 */

export interface GrabDialogProps {
  release: ReleaseRead;
  /** Sonarr and Radarr only — nothing else accepts a release. */
  destinations: InstanceHealthDto[];
  onCancel: () => void;
  /** The screen owns the mutation, so it can toast the outcome and close. */
  onConfirm: (input: GrabInput) => void;
  /** A grab is in flight. Cancel and Escape go inert — neither can recall it. */
  busy: boolean;
}

export default function GrabDialog({
  release,
  destinations,
  onCancel,
  onConfirm,
  busy,
}: GrabDialogProps) {
  const [target, setTarget] = useState<string>(() => destinations[0]?.instanceId ?? '');

  // The roster can change under a long-lived dialog (an instance is disabled in
  // Settings). Falling back keeps the dialog from naming a destination that is
  // no longer there — and from grabbing into it.
  const chosen = destinations.find((d) => d.instanceId === target) ?? destinations[0] ?? null;

  const resolved = useResolvedTarget(chosen?.instanceId ?? null, release.title);

  // Prowlarr returned a result with no usable link. The grab route refuses it
  // anyway; saying so here costs the operator one click instead of one failed
  // operation in the log.
  const linkless = release.downloadUrl === '';

  const parsed: ParsedTarget | undefined = resolved.data;
  const unresolved = parsed !== undefined && !parsed.resolved;
  const blocked = chosen === null || linkless;

  const confirm = () => {
    if (!chosen || linkless) return;
    onConfirm({
      instanceId: chosen.instanceId,
      title: release.title,
      downloadUrl: release.downloadUrl,
      protocol: release.protocol,
      publishDate: release.publishDate,
      indexer: release.indexer,
      // What the confirmation named, verbatim — the log and the toast repeat
      // this string, so it has to be the destination's answer and not ours.
      entityRef: parsed?.resolved ? parsed.label : null,
    });
  };

  return (
    <Modal
      title="Grab release"
      labelledBy="grab-title"
      // Stable enough: `Modal` restores focus on cleanup, and a dismiss that
      // fires mid-flight would hide the outcome the operator is waiting for.
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={unresolved ? 'btn btn-outline' : 'btn btn-primary'}
            onClick={confirm}
            disabled={busy || blocked || resolved.isPending}
          >
            {grabLabel({
              busy,
              pending: resolved.isPending,
              unresolved,
              instanceLabel: chosen?.label ?? null,
            })}
          </button>
        </>
      )}
    >
      <p className="mono truncate" style={{ fontSize: 12 }}>{release.title}</p>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        {[
          release.indexer,
          release.protocol,
          formatBytes(release.size),
          release.seeders === null ? null : `${release.seeders} seeders`,
        ].filter(Boolean).join(' · ')}
      </p>

      {destinations.length === 0 ? (
        <Callout tone="warn">
          No Sonarr or Radarr instance is configured, so there is nothing to grab into. Add one in
          Settings.
        </Callout>
      ) : (
        <fieldset className="dest-row">
          <legend className="dest-row__legend">Destination</legend>
          <div className="dest-row__chips">
            {destinations.map((destination) => {
              const selected = destination.instanceId === chosen?.instanceId;
              return (
                <label
                  key={destination.instanceId}
                  className={`filter-chip dest-chip${selected ? ' is-on' : ''}`}
                >
                  {/* A native radio, skinned. The destinations are mutually
                      exclusive, so arrow-key semantics and the announced group
                      are the platform's to provide, not ours to reimplement. */}
                  <input
                    type="radio"
                    className="sr-only"
                    name="grab-destination"
                    value={destination.instanceId}
                    checked={selected}
                    disabled={busy}
                    onChange={() => setTarget(destination.instanceId)}
                  />
                  <span className="filter-chip__glyph" aria-hidden="true">{selected ? '●' : '○'}</span>
                  <span className="filter-chip__label">{destination.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {chosen === null ? null : (
        <div className="grab-resolve">
          {resolved.isPending ? (
            <p className="subtle" style={{ fontSize: 12 }}>
              Resolving what {chosen.label} will attach this to…
            </p>
          ) : resolved.isError ? (
            <Callout tone="warn">
              {chosen.label} did not answer the question of what this release belongs to
              {resolved.error instanceof ApiError ? ` — ${resolved.error.message}` : '.'}
              {' '}
              helparr cannot say what would happen to it, so the grab is offered unconfirmed.
            </Callout>
          ) : parsed?.resolved ? (
            <>
              <p className="subtle" style={{ fontSize: 11 }}>{chosen.label} will attach this to</p>
              {/* Deliberately the destination's words, not the operator's
                  selection — REQ-OPS-007. */}
              <div className="grab-target card">
                <p style={{ fontWeight: 600, fontSize: 13 }}>{parsed.label ?? 'an untitled entry'}</p>
                <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
                  {[
                    parsed.quality ? `quality ${parsed.quality}` : null,
                    parsed.releaseGroup ? `group ${parsed.releaseGroup}` : null,
                  ].filter(Boolean).join(' · ') || 'no quality or group parsed'}
                </p>
              </div>
            </>
          ) : (
            <Callout tone="warn">
              <p>{chosen.label} could not match this release to anything it tracks.</p>
              <p style={{ marginTop: 'var(--space-2)' }}>
                A release {chosen.label} cannot place is accepted and then never imported — it
                downloads and sits there. Add the title to {chosen.label} first, or pick a
                different destination.
              </p>
            </Callout>
          )}
        </div>
      )}

      {linkless ? (
        <Callout tone="error">
          This result carried no download link, so there is nothing to send. That is the indexer&apos;s
          response, not a helparr failure.
        </Callout>
      ) : busy ? (
        // The only progress statement in the dialog, and it says what is
        // happening rather than what it hopes will happen.
        <p className="subtle" aria-busy="true" role="status" style={{ fontSize: 12 }}>
          Sending to {chosen?.label ?? 'the instance'}…
        </p>
      ) : (
        <Callout tone="info">helparr has sent nothing yet.</Callout>
      )}
    </Modal>
  );
}

/** The button says what pressing it does, including when that is the risky thing. */
function grabLabel({
  busy,
  pending,
  unresolved,
  instanceLabel,
}: {
  busy: boolean;
  pending: boolean;
  unresolved: boolean;
  instanceLabel: string | null;
}): string {
  if (busy) return 'Sending…';
  if (pending) return 'Grab';
  if (unresolved) return 'Grab anyway';
  return instanceLabel ? `Grab into ${instanceLabel}` : 'Grab';
}
