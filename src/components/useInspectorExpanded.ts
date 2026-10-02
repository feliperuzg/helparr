'use client';

/**
 * The inspector's expanded/default width, remembered per browser (ADR-7 of
 * queue-triage-ergonomics, REQ-QUEUE-011).
 *
 * One preference for every inspector, not one per screen: the panel is a
 * single shared shell, and an operator who widened it on Queue expects Gaps to
 * open the same way. Follows the setup-nudge precedent in `FirstRun.tsx` —
 * `localStorage` read through `useSyncExternalStore`, with a custom window
 * event so every mounted reader in this tab hears a change, and `storage` so
 * other tabs do too.
 */

import { useCallback, useSyncExternalStore } from 'react';

export const INSPECTOR_EXPANDED_KEY = 'helparr.inspector-expanded';
export const INSPECTOR_EXPANDED_EVENT = 'helparr:inspector-expanded';

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    // `key === null` is a `localStorage.clear()` from another tab.
    if (e.key === INSPECTOR_EXPANDED_KEY || e.key === null) onChange();
  };
  window.addEventListener(INSPECTOR_EXPANDED_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(INSPECTOR_EXPANDED_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/* Private mode and storage-disabled browsers throw on access. When they do,
   the preference lives here for the rest of the page view instead — the toggle
   still works, it just does not survive a reload. Starts at the default width,
   which is the safe answer: nothing is hidden by it. */
let memory = false;

function read(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_EXPANDED_KEY) === '1';
  } catch {
    return memory;
  }
}

function write(expanded: boolean) {
  memory = expanded;
  try {
    if (expanded) window.localStorage.setItem(INSPECTOR_EXPANDED_KEY, '1');
    else window.localStorage.removeItem(INSPECTOR_EXPANDED_KEY);
  } catch {
    // Kept in `memory` above; the event below is what re-renders readers, and
    // it does not depend on storage succeeding.
  }
  window.dispatchEvent(new Event(INSPECTOR_EXPANDED_EVENT));
}

/* At ≤860px the inspector is a full-screen sheet (globals.css) and there is
   nothing to expand into. The preference is kept but reads as collapsed there,
   so `e` and the Escape "collapse first" step cannot act on a width the
   operator cannot see — one Escape closes the sheet, as it always has. */
const SHEET_QUERY = '(max-width: 860px)';

function subscribeSheet(onChange: () => void) {
  const query = window.matchMedia(SHEET_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isSheet(): boolean {
  return window.matchMedia(SHEET_QUERY).matches;
}

export interface InspectorExpanded {
  /** Whether the inspector should render at its expanded width. Always false
   *  where the inspector is a full-screen sheet. */
  expanded: boolean;
  /** Set the preference explicitly — Escape's "collapse first" uses `false`. */
  setExpanded: (expanded: boolean) => void;
  /** Flip the preference — the head button and the `e` key. */
  toggle: () => void;
}

export function useInspectorExpanded(): InspectorExpanded {
  const expanded = useSyncExternalStore(
    subscribe,
    read,
    // No storage on the server. Default width is the honest first paint: an
    // inspector that widens after hydration is a nudge, one that was rendered
    // wide on a guess and then narrows is a jump.
    () => false,
  );
  const sheet = useSyncExternalStore(subscribeSheet, isSheet, () => false);

  const setExpanded = useCallback((next: boolean) => write(next), []);
  // Reads storage at call time rather than closing over `expanded`, so the
  // callback stays stable and two quick presses cannot both act on a stale
  // value.
  const toggle = useCallback(() => {
    if (!isSheet()) write(!read());
  }, []);

  return { expanded: expanded && !sheet, setExpanded, toggle };
}
