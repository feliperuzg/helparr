/**
 * The one definition of "is this link attachable", shared by the dialog and the
 * route (REQ-GAPS-010).
 *
 * It lives in `lib/` rather than in `server/gaps/attach.ts` because both sides
 * need it and they must not drift: the dialog disables its button on this
 * predicate, the route refuses on it, and a client rule that is stricter than
 * the server's silently hides links that would have worked — while a looser one
 * turns a local, instant explanation into a round trip and a refusal.
 */

/** Only these two. A `.nzb` is not refused here, it is simply not offered. */
const MAGNET_PREFIX = 'magnet:?';
const TORRENT_SUFFIX = '.torrent';

export function isAttachableLink(link: string): boolean {
  const trimmed = link.trim();
  if (trimmed.startsWith(MAGNET_PREFIX)) return true;
  try {
    return new URL(trimmed).pathname.toLowerCase().endsWith(TORRENT_SUFFIX);
  } catch {
    return false;
  }
}
