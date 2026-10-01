/**
 * Client-safe types for the unmapped-folders read (ADR-9, REQ-GAPS-022..026).
 *
 * Kept in its own file rather than added to `src/lib/types.ts` so this task
 * and the other `stuck-item-triage` tracks (cause, decisions) never touch the
 * same file (ADR-14).
 *
 * No server imports here: this module is read by client components directly.
 */

/**
 * `'listed'` — the instance reported at least one unmapped folder.
 * `'none'` — the instance reported the key, and it was empty: a confirmed
 * zero, not an absence of evidence.
 * `'unknown'` — the response omitted `unmappedFolders` entirely, most often
 * because the instance's own 5s scan budget ran out before this root folder.
 * Never collapsed into `'none'` (REQ-GAPS-023, ADR-9) — that collapse is the
 * exact failure this whole screen exists to prevent.
 */
export type UnmappedState = 'listed' | 'none' | 'unknown';

/** One unmapped folder, attributed to the instance and root folder it came from. */
export interface UnmappedFolderRow {
  instanceId: string;
  instanceLabel: string;
  instanceKind: 'sonarr' | 'radarr';
  rootPath: string;
  name: string;
  path: string;
  /**
   * A cross-link only (ADR-9, REQ-GAPS-025) — on the same terms as the gaps
   * screen's "⌕ Indexers" link: it opens helparr's own `/search` screen
   * pre-populated from the folder name. It is never a write, and it is never
   * a link into the instance's own add-new UI — helparr does not add the
   * title itself.
   */
  searchUrl: string | null;
}

/** One root folder, grouped the way the screen renders it. */
export interface UnmappedRoot {
  rootPath: string;
  accessible: boolean;
  /** Bytes, as the instance reports them; null when it does not. */
  freeSpace: number | null;
  state: UnmappedState;
  /** `null` exactly when `state` is `'unknown'` — count is never guessed. */
  count: number | null;
  folders: UnmappedFolderRow[];
}

/** One instance's contribution to the read, including its own failure. */
export interface UnmappedInstance {
  instanceId: string;
  label: string;
  kind: 'sonarr' | 'radarr';
  /**
   * `'unsupported'` is reserved for an instance that cannot answer this read
   * for a reason that is not a transport failure. In practice every
   * participant here is filtered to Sonarr/Radarr by capability before this
   * type is populated, so today only `'ok'` and `'unreachable'` occur.
   */
  status: 'ok' | 'unreachable' | 'unsupported';
  error: string | null;
  roots: UnmappedRoot[];
}

export interface UnmappedRead {
  instances: UnmappedInstance[];
  readAt: string;
}
