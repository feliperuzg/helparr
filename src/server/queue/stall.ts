import 'server-only';

import type { StallVerdict, TorrentState } from '@/lib/types';

/**
 * Stall classification from download-client evidence alone (REQ-QUEUE-005, T8).
 *
 * Deliberately independent of `trackedDownloadStatus`. The premise of this whole
 * screen is that a torrent stuck fetching metadata reports `ok` upstream — the
 * *arr has handed the release to the client and has nothing further to say about
 * it. Consulting the *arr verdict here would reproduce the bug the screen exists
 * to expose.
 */

const NOT_STALLED: StallVerdict = { stalled: false, evidence: '' };

export function classifyStall(torrent: TorrentState | null): StallVerdict {
  // No torrent is not evidence of health. It is the absence of evidence either
  // way, and claiming "stalled" here would flag every usenet download in the
  // queue.
  if (!torrent) return NOT_STALLED;

  if (torrent.fetchingMetadata) {
    return {
      stalled: true,
      evidence: `fetching metadata, ${torrent.numSeeds} ${torrent.numSeeds === 1 ? 'peer' : 'peers'}`,
    };
  }

  // All three conditions, not any one of them: a torrent at 0 B/s with seeders
  // present is between pieces, and a completed torrent sits at 0 B/s forever.
  if (torrent.progress < 1 && torrent.dlspeed === 0 && torrent.numSeeds === 0) {
    return { stalled: true, evidence: '0 peers, no progress' };
  }

  return NOT_STALLED;
}
