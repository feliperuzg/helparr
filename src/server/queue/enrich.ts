import 'server-only';

import type { QueueRecord, TorrentState } from '@/lib/types';
import { classifyStall } from './stall';

/**
 * Joins *arr queue records to download-client torrents (ADR-3, T7).
 *
 * Sonarr and Radarr write the infohash into `downloadId` uppercase;
 * qBittorrent reports `hash` lowercase. The compare is therefore
 * case-insensitive, and that is the one assumption in this change flagged for
 * verification against a live pair (T26). If it turns out wrong the failure mode
 * is already the safe one: no match, no enrichment.
 *
 * There is no title-matching fallback, and that is a decision rather than an
 * omission. The releases that end up stuck are exactly the ones whose titles the
 * *arr parser already disagreed about, so a title-matched enrichment would fail
 * hardest on the rows the screen exists for — and it would fail by attaching the
 * *wrong* torrent, which reads as data rather than as a gap.
 */
export function enrichRecords(
  records: QueueRecord[],
  torrents: TorrentState[],
): QueueRecord[] {
  const byHash = new Map<string, TorrentState>();
  for (const torrent of torrents) byHash.set(torrent.hash.toLowerCase(), torrent);

  return records.map((record) => {
    const torrent = record.downloadId
      ? byHash.get(record.downloadId.toLowerCase()) ?? null
      : null;
    return { ...record, torrent, stall: classifyStall(torrent) };
  });
}
