'use client';

import { useState } from 'react';

import { useAttachPreview } from '@/components/gaps/useGaps';
import { Callout, Modal } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { isAttachableLink } from '@/lib/attach';
import type { Gap } from '@/lib/types';

/**
 * The attach confirmation (FR6..FR8; REQ-GAPS-010, -011, -013, -017; T15).
 *
 * The one dialog in helparr that hands an *arr a link the operator found
 * themselves, and every state it has exists because of one fact:
 * `POST /api/v3/release/push` maps a download to a library item **by parsing a
 * title**. helparr offers a name; the instance decides what it means.
 *
 * Which gives four rules:
 *
 * 1. **Shape is decided locally.** "Not a magnet or a .torrent" is answered
 *    without a request — the same predicate the route refuses on, imported from
 *    one place so the two cannot disagree (REQ-GAPS-010).
 * 2. **The pre-flight is read-only.** Opening this dialog costs one `GET /parse`
 *    against the instance and nothing else. Nothing is pushed until the
 *    confirming button is pressed.
 * 3. **A mismatch names both.** When the instance reads the synthesized title as
 *    a *different* item, the operator's selection and the instance's answer are
 *    printed side by side and the button changes verb (REQ-GAPS-017). They are
 *    not stopped — they cannot miss it.
 * 4. **No success renders here.** The dialog closes on the response; the
 *    outcome arrives as a toast, verbatim on a refusal (REQ-GAPS-013).
 */

export interface AttachDialogProps {
  gap: Gap;
  onCancel: () => void;
  /** The screen owns the mutation so it can toast the outcome and close. */
  onConfirm: (link: string) => void;
  /** A push is in flight. Cancel and Escape go inert — neither can recall it. */
  busy: boolean;
}

export default function AttachDialog({ gap, onCancel, onConfirm, busy }: AttachDialogProps) {
  const [link, setLink] = useState('');

  const touched = link.trim().length > 0;
  const wellFormed = touched && isAttachableLink(link);

  // Keyed on the gap, not on the link: the title helparr pushes is synthesized
  // from the item, so the parse answer does not change as the operator types.
  // It is also why this can run before a link exists — it describes the
  // destination, not the download.
  const preview = useAttachPreview(gap.id);

  const mismatched = preview.data !== undefined && !preview.data.matchesGap;
  const unresolved = preview.data !== undefined && !preview.data.target.resolved;
  const risky = mismatched || unresolved;

  return (
    <Modal
      title={`Attach a release to ${gap.itemCode}`}
      labelledBy="attach-title"
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={risky ? 'btn btn-outline' : 'btn btn-primary'}
            onClick={() => { if (wellFormed) onConfirm(link.trim()); }}
            // Gated on the link alone. A failed pre-flight is a designed state,
            // not a blocker — the operator may well know better than the parser.
            disabled={busy || !wellFormed}
          >
            {attachLabel({ busy, risky, wellFormed, instanceLabel: gap.instanceLabel })}
          </button>
        </>
      )}
    >
      {/* One label, visible and associated — the field's name is worth showing,
          so there is nothing here for an `sr-only` duplicate to add. */}
      <label
        className="subtle"
        htmlFor="attach-link"
        style={{ display: 'block', fontSize: 'var(--text-xs)', marginBottom: 'var(--space-2)' }}
      >
        Magnet link or .torrent URL
      </label>
      <textarea
        id="attach-link"
        className="input attach-link mono"
        rows={3}
        value={link}
        onChange={(e) => setLink(e.target.value)}
        disabled={busy}
        placeholder="magnet:?xt=urn:btih:…"
        spellCheck={false}
        // Announced as soon as it turns invalid, not on submit — there is no
        // submit to reach while the button is disabled.
        aria-invalid={touched && !wellFormed}
        aria-describedby="attach-link-note"
      />
      <p
        id="attach-link-note"
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
            helparr cannot say where this would be filed, so the attach is offered unconfirmed.
          </Callout>
        ) : preview.data === undefined ? null : mismatched ? (
          // The branch the pre-flight exists for. Both readings are printed,
          // and the one that wins is the instance's (REQ-GAPS-017).
          <Callout tone="warn">
            <p style={{ fontWeight: 600 }}>
              {gap.instanceLabel} reads this as a different {gap.kind}
            </p>
            <dl className="kv" style={{ marginTop: 'var(--space-3)' }}>
              <dt className="kv__k">You selected</dt>
              <dd className="kv__v">{gap.groupTitle} — {gap.itemCode}</dd>
              <dt className="kv__k">{gap.instanceLabel} resolved</dt>
              <dd className="kv__v">{preview.data.target.label ?? 'an untitled entry'}</dd>
            </dl>
            <p style={{ marginTop: 'var(--space-3)' }}>
              Attaching anyway will file it as{' '}
              {preview.data.target.label ?? 'whatever it resolved'}.
            </p>
          </Callout>
        ) : unresolved ? (
          <Callout tone="warn">
            <p>{gap.instanceLabel} could not resolve a destination from this name.</p>
            <p style={{ marginTop: 'var(--space-2)' }}>
              Attaching will hand the download over without a confirmed target — it will download
              and then sit there unimported.
            </p>
          </Callout>
        ) : (
          <>
            <p className="subtle" style={{ fontSize: 'var(--text-xs)' }}>Will import as</p>
            <div className="grab-target card">
              <p style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>
                {preview.data.target.label ?? 'an untitled entry'}
              </p>
              <p className="subtle" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>{gap.title}</p>
              {preview.data.path ? (
                <p className="subtle mono" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>
                  {preview.data.path}
                </p>
              ) : null}
            </div>
            {/* The standing risk, not a branch: even a correct parse maps the
                download by name. If the file is actually something else, it is
                filed as this. */}
            <Callout tone="warn">
              The download is mapped to this {gap.kind} regardless of what the release name says.
              If the file is actually a different one, {gap.instanceLabel} will import it under the
              wrong number.
            </Callout>
          </>
        )}
      </div>

      {/* The name being offered, shown plainly. It is the whole mechanism, and
          hiding it would make every branch above unexplainable. */}
      {preview.data ? (
        <p className="subtle mono truncate" style={{ fontSize: 'var(--text-xs)' }}>
          sending as {preview.data.title}
        </p>
      ) : null}

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
