import 'server-only';

import type { HistoryEvent, InferredReason } from '@/lib/types';

/**
 * "Why is this still missing?" — composed by helparr, labelled as such (ADR-6).
 *
 * Neither Sonarr nor Radarr answers this question. What they return is a list
 * of things that happened, and the useful reading of that list — "it was
 * grabbed four days ago and never imported" — is an *inference*. So it carries
 * `source: 'inferred'` all the way to the client, which renders it in a
 * callout reading "helparr's reading — not reported by sonarr".
 *
 * The rule inherited from `indexer-search-grab` holds here: upstream text is
 * shown verbatim, and helparr's own text is never dressed up as upstream text.
 * The tag travels with the data so a styling accident cannot blur the two.
 */

/**
 * Event types both *arr APIs agree on, most-recent-wins.
 *
 * `downloadFolderImported` is in the list even though an imported item should
 * not be missing at all: when it *is* both, that contradiction is the single
 * most useful thing to put in front of the operator.
 */
const GRABBED = 'grabbed';
const FAILED = 'downloadFailed';
const IMPORTED = 'downloadFolderImported';
const IGNORED = 'downloadIgnored';
const DELETED = 'episodeFileDeleted';
const MOVIE_DELETED = 'movieFileDeleted';

function daysSince(at: string, now: number): number | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/** "today" / "yesterday" / "4 days ago" — the resolution the reason needs. */
function ago(at: string, now: number): string {
  const days = daysSince(at, now);
  if (days === null) return 'at an unknown time';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function inferred(text: string): InferredReason {
  return { text, source: 'inferred' };
}

/**
 * The inference, from the item's own history.
 *
 * Returns null rather than guessing: an empty history genuinely means "nothing
 * has been tried", and a sentence invented to fill the space would be helparr
 * asserting something it does not know. The inspector shows nothing at all in
 * that case, which is the honest rendering.
 */
export function inferReason(events: HistoryEvent[], now = Date.now()): InferredReason | null {
  if (events.length === 0) return null;

  // Newest first, regardless of what the upstream sorted by — Radarr's
  // per-movie route and Sonarr's paged collection do not agree on direction.
  const ordered = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = ordered[0];

  switch (latest.eventType) {
    case GRABBED: {
      const days = daysSince(latest.at, now);
      // A grab that landed would have been followed by an import event. This
      // one is the most recent thing that happened *and* the item is still
      // missing, so the download did not complete.
      return inferred(
        days !== null && days >= 1
          ? `Grabbed ${ago(latest.at, now)} and never imported — the download may have stalled or failed silently.`
          : 'Grabbed today and not yet imported — the download is probably still running.',
      );
    }

    case FAILED:
      return inferred(
        `The last download failed ${ago(latest.at, now)}. `
          + 'Nothing has been grabbed since, so it is waiting on the next search.',
      );

    case IGNORED:
      return inferred(
        `The last release was ignored ${ago(latest.at, now)} — it was probably blocklisted or rejected on quality.`,
      );

    case IMPORTED:
      // The contradiction case. Worth saying out loud: the operator is looking
      // at an item the instance reports as both imported and missing, which
      // usually means the file was moved or deleted outside the *arr.
      return inferred(
        `An import completed ${ago(latest.at, now)}, yet the item is still reported missing — `
          + 'the file may have been moved or deleted outside this instance.',
      );

    case DELETED:
    case MOVIE_DELETED:
      return inferred(
        `The file was deleted ${ago(latest.at, now)} and nothing has replaced it since.`,
      );

    default:
      // A verbatim event type rather than a paraphrase: an unrecognised type is
      // precisely where a paraphrase would be a guess about upstream semantics.
      return inferred(
        `The most recent event was "${latest.eventType}" ${ago(latest.at, now)}.`,
      );
  }
}
