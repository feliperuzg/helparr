import 'server-only';

import { isAttachableLink } from '@/lib/attach';
import type { AttachPreview, Gap, GrabOutcome } from '@/lib/types';
import { grab, resolveTarget, type Attempt } from '@/server/search/grab';
import { findGap } from './aggregate';
import { invalidateLibrary } from './seriesCache';

/**
 * Manual attach — a pasted link, filed against a gap the operator picked
 * (FR6..FR8, REQ-GAPS-010..013, ADR-1 and ADR-7).
 *
 * This module owns exactly two things: the **title** it pushes, and the cache
 * invalidation afterwards. Everything else — redaction, the breaker, the single
 * operation row written from the response, the no-retry rule — is `grab()`,
 * because attach and search-grab hit the same endpoint and differ only in where
 * the descriptor came from.
 *
 * The title is the part the search flow never has to invent, and it is the
 * whole difficulty: `POST /api/v3/release/push` maps a download to a library
 * item **by parsing the name**. helparr does not get to say "this is S04E02";
 * it gets to offer a name, and the instance decides. So every attach is
 * preceded by a read-only parse whose answer is what the confirmation shows —
 * and when that answer is not the gap the operator selected, both are named.
 */

/**
 * Release names are dot-separated and carry no punctuation, because that is
 * the shape both parsers were written against. A title left as prose parses
 * far less reliably — and a failed parse costs the operator the mismatch
 * warning, which is the one protection this flow has.
 */
function sanitize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '.')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * The name helparr offers the instance.
 *
 * `WEBDL-1080p` is a deliberate, stated default rather than a guess at what is
 * inside the torrent: the quality token has to be *something* for the parser to
 * produce a complete match, and helparr cannot know the real one. It shows up
 * in the confirmation, so the operator sees exactly what is being offered.
 */
export function synthesizeTitle(gap: Gap): string {
  const stem = gap.kind === 'episode'
    ? `${sanitize(gap.groupTitle)}.${gap.itemCode}`
    : `${sanitize(gap.title)}.${gap.itemCode}`;
  return `${stem}.WEBDL-1080p`;
}

function missingGap(gapId: string): Attempt<never> {
  return {
    ok: false,
    refusal: {
      kind: 'no-instance',
      reason: `That gap (${gapId}) is no longer in the library read — refresh the screen and try again.`,
    },
  };
}

/**
 * Did the instance resolve the item the operator actually selected?
 *
 * Sonarr's `ParsedTarget` carries the series id and a label like
 * `Reacher — S04E02`; the episode ids are not exposed, so the item code is
 * matched against that label. A false *negative* here is harmless — it shows a
 * warning that names both readings — while a false positive would hide the one
 * thing this pre-flight exists to surface.
 */
function matchesGap(gap: Gap, target: { resolved: boolean; seriesId: number | null; movieId: number | null; label: string | null }): boolean {
  if (!target.resolved) return false;
  if (gap.kind === 'movie') return target.movieId === gap.upstreamId;
  if (target.seriesId === null || target.seriesId !== gap.seriesId) return false;
  return target.label?.includes(gap.itemCode) === true;
}

/**
 * Phase 1 — read-only. Nothing here can write: it is a synthesized name and a
 * `GET /parse`, and `resolveTarget` degrades a parse failure into the
 * unresolved branch rather than an error.
 */
export async function previewAttach(
  gapId: string,
  signal?: AbortSignal,
): Promise<Attempt<AttachPreview>> {
  const gap = await findGap(gapId, signal);
  if (!gap) return missingGap(gapId);

  const title = synthesizeTitle(gap);
  const resolved = await resolveTarget(gap.instanceId, title, signal);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    value: {
      title,
      target: resolved.value,
      matchesGap: matchesGap(gap, resolved.value),
      // Where the instance says it keeps this item. Shown so the operator can
      // sanity-check the destination before the file moves, not after.
      path: gap.targetPath,
    },
  };
}

/**
 * Phase 2 — the write, and the only one on this screen.
 *
 * The title is re-synthesized from the gap rather than taken from the request:
 * the browser gets to say *which* gap, never *what to call it*.
 */
export async function attach(
  input: { gapId: string; link: string },
  signal?: AbortSignal,
): Promise<Attempt<GrabOutcome>> {
  const gap = await findGap(input.gapId, signal);
  if (!gap) return missingGap(input.gapId);

  const link = input.link.trim();
  if (!isAttachableLink(link)) {
    return {
      ok: false,
      refusal: {
        kind: 'no-url',
        reason: 'That is not a magnet link or a .torrent URL, so there is nothing to send.',
      },
    };
  }

  const title = synthesizeTitle(gap);

  // Best-effort, and re-read rather than carried from the preview: the dialog
  // may have been open a while, and what goes in the log should be what the
  // instance said at the moment of the write. A failure here is not a failure
  // to attach — it becomes a null `entityRef`, the unresolved branch.
  const resolved = await resolveTarget(gap.instanceId, title, signal);
  const entityRef = resolved.ok && resolved.value.resolved ? resolved.value.label : null;

  const outcome = await grab({
    instanceId: gap.instanceId,
    title,
    downloadUrl: link,
    // Both accepted forms are BitTorrent. Usenet has no pasteable equivalent
    // that `/release/push` would accept, so none is offered (REQ-GAPS-010).
    protocol: 'torrent',
    publishDate: new Date().toISOString(),
    // There isn't one. An attach did not come from an indexer, and writing a
    // plausible-looking name into that column would be inventing provenance.
    indexer: null,
    entityRef,
    operationKind: 'attach',
  }, signal);

  // Unconditional, including on a rejection: helparr cannot tell from here
  // whether the instance changed anything on its way to saying no, and a cache
  // miss costs one library read while a stale cache costs correctness.
  invalidateLibrary(gap.instanceId);

  return outcome;
}
