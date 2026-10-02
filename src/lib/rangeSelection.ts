/**
 * Range selection over a displayed list (REQ-QUEUE-024, ADR-5 of
 * queue-triage-ergonomics).
 *
 * Pure, so the node test lane can pin the semantics without a DOM. Every screen
 * that offers shift+click or Shift+J/K computes its range here, over the ids it
 * is actually rendering — never over the unfiltered set, which is how a range
 * sweeps in records the operator cannot see.
 */

/**
 * The inclusive slice of `displayed` between `anchor` and `target`, in display
 * order, whichever way round they are.
 *
 * Null when there is no anchor or either end is not displayed. The anchor is an
 * id rather than an index so it survives a re-sort or a refetch; a filter that
 * hides it leaves no well-defined range, and the caller degrades the gesture to
 * a plain toggle of the target instead of guessing one.
 */
export function rangeBetween(
  displayed: readonly string[],
  anchor: string | null,
  target: string,
): string[] | null {
  if (anchor === null) return null;
  const from = displayed.indexOf(anchor);
  const to = displayed.indexOf(target);
  if (from < 0 || to < 0) return null;
  return from <= to ? displayed.slice(from, to + 1) : displayed.slice(to, from + 1);
}

export interface RangePlan {
  /** The ids to change, in display order. */
  ids: string[];
  /** The state every one of them takes — the anchor row's (OQ-5). */
  state: boolean;
  /** The anchor after the gesture. */
  anchor: string;
}

/**
 * shift+click and Shift+Space: anchor → target takes the anchor's state.
 *
 * `stateOf` abstracts what "selected" means on the screen — membership of a
 * selection set on Queue and Gaps, `!excluded` on the rename plan, `included`
 * on force import — so the rule is written once. Null means there is no range
 * to take, and the screen toggles the target alone and makes it the anchor.
 */
export function planRange(
  displayed: readonly string[],
  anchor: string | null,
  target: string,
  stateOf: (id: string) => boolean,
): RangePlan | null {
  const ids = rangeBetween(displayed, anchor, target);
  if (ids === null || anchor === null) return null;
  return { ids, state: stateOf(anchor), anchor };
}

/**
 * Shift+J/K: the cursor moved `from` → `to`, and both take the anchor's state.
 *
 * Without a displayed anchor the starting row becomes the anchor and is
 * selected first, so the first Shift+J from a fresh list selects two rows
 * rather than doing nothing.
 */
export function planExtend(
  displayed: readonly string[],
  anchor: string | null,
  from: string,
  to: string,
  stateOf: (id: string) => boolean,
): RangePlan | null {
  const ids = rangeBetween(displayed, from, to);
  if (ids === null) return null;
  if (anchor !== null && displayed.includes(anchor)) {
    return { ids, state: stateOf(anchor), anchor };
  }
  return { ids, state: true, anchor: from };
}

/**
 * `selected` with every id in `ids` set to `state`. Rows outside `ids` are
 * untouched (OQ-5) — a range never deselects what it does not cover.
 */
export function applyRange(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  state: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (state) next.add(id);
    else next.delete(id);
  }
  return next;
}
