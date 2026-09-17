import type {
  IndexerRead,
  ResolvedSearchRef,
  SavedScopeResolution,
  SavedSearchRead,
  SavedSearchRef,
} from './types';

/**
 * Resolving a saved scope against a roster (ADR-6, REQ-SEARCH-014).
 *
 * Pure, and in `lib/` rather than `server/`, because both sides need the same
 * answer at different moments. The server resolves at run time, against the
 * roster it reads for the fan-out — that is the authoritative one. The browser
 * resolves on *selection*, against the roster it already holds, so the operator
 * is told an indexer is missing before they spend a query finding out.
 *
 * Two resolutions of the same scope can legitimately differ: the roster moves.
 * They are not allowed to differ because the rule does, which is why there is
 * one rule here and no second copy of it.
 */

/** Saved-search names, so the toolbar and the store agree on what fits. */
export const SAVED_SEARCH_NAME_MAX = 64;
export const SAVED_SEARCH_LIMIT = 100;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Matches one saved reference against the live roster.
 *
 * By id first: Prowlarr keeps the id across a rename, so this is the case that
 * makes "renaming an indexer must not kill a saved search" true.
 *
 * By name second: removing an indexer and adding it back gives it a new id, and
 * refusing to follow that would be the same permanent death by a slower route.
 * A name match is only consulted when no id matched, so a roster where some
 * other indexer has since taken the saved name cannot steal the reference from
 * the one that still holds the id.
 */
function match(ref: SavedSearchRef, roster: IndexerRead[]): ResolvedSearchRef | null {
  const byId = roster.find((indexer) => indexer.id === ref.indexerId);
  if (byId) {
    return { ...ref, currentName: byId.name, rematchedByName: false };
  }

  const byName = roster.find((indexer) => sameName(indexer.name, ref.name));
  if (byName) {
    // The id travels forward as the roster's, not the saved one's — this is the
    // resolution the search will actually be scoped to.
    return {
      indexerId: byName.id,
      name: ref.name,
      currentName: byName.name,
      rematchedByName: true,
    };
  }

  return null;
}

export function resolveSavedScope(
  saved: Pick<SavedSearchRead, 'query' | 'indexers' | 'categories' | 'minSeeders'>,
  roster: IndexerRead[],
): SavedScopeResolution {
  const resolved: ResolvedSearchRef[] = [];
  const unresolved: SavedSearchRef[] = [];

  for (const ref of saved.indexers) {
    const hit = match(ref, roster);
    if (hit) resolved.push(hit); else unresolved.push(ref);
  }

  // An empty saved scope means "every indexer" and stays that way. It is the
  // only scope with nothing to resolve, so it is also the only one that can
  // send an empty `indexerIds` downstream — which the search route reads as
  // "all" (ADR-1).
  const wasUnscoped = saved.indexers.length === 0;
  const runnable = wasUnscoped || resolved.length > 0;

  return {
    rosterAvailable: true,
    criteria: {
      query: saved.query,
      indexerIds: wasUnscoped ? [] : resolved.map((ref) => ref.indexerId),
      categories: saved.categories,
      minSeeders: saved.minSeeders,
    },
    resolved,
    unresolved,
    runnable,
  };
}

/**
 * The resolution when the roster could not be read.
 *
 * Deliberately claims nothing: `unresolved` is empty because an unreachable
 * Prowlarr is not evidence that any indexer is gone, and saying otherwise would
 * put a name on screen that is very likely still fine. `runnable` is false
 * because there is nothing to run against either way.
 */
export function unresolvableScope(
  saved: Pick<SavedSearchRead, 'query' | 'indexers' | 'categories' | 'minSeeders'>,
): SavedScopeResolution {
  return {
    rosterAvailable: false,
    criteria: {
      query: saved.query,
      indexerIds: saved.indexers.map((ref) => ref.indexerId),
      categories: saved.categories,
      minSeeders: saved.minSeeders,
    },
    resolved: [],
    unresolved: [],
    runnable: false,
  };
}

/**
 * One sentence naming what is missing, or null when nothing is.
 *
 * Shared so the toolbar's pre-run note and any server-side log line say the
 * same thing. It names every missing indexer rather than counting them: "1
 * indexer is no longer in Prowlarr" tells the operator to go and find out
 * which, which is the work this sentence exists to save.
 */
export function describeUnresolved(resolution: SavedScopeResolution): string | null {
  if (!resolution.rosterAvailable || resolution.unresolved.length === 0) return null;

  const one = resolution.unresolved.length === 1;
  const names = resolution.unresolved.map((ref) => ref.name).join(', ');

  return resolution.runnable
    ? `${names} ${one ? 'is' : 'are'} no longer in Prowlarr. `
      + `This search will run without ${one ? 'it' : 'them'}.`
    : `${names} ${one ? 'is' : 'are'} no longer in Prowlarr, `
      + 'and this search was scoped to nothing else.';
}
