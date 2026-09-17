'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';

import { isDialogOpen } from './ui';

/**
 * The shared keyboard layer for every list screen (REQ-QUEUE-012,
 * REQ-SEARCH-010 / FR13).
 *
 * Bound to the window rather than to the grid, because `/` has to work from
 * anywhere on the screen and `j`/`k` have to work before the operator has ever
 * clicked a row. That is exactly what makes the typing guard load-bearing.
 *
 * Queue and Search differ in exactly one respect — Queue multi-selects, Search
 * does not — so selection is optional rather than duplicated. A second copy of
 * this hook would be a second place for the typing guard to drift.
 */

/**
 * The bug this pattern always ships with: typing "jk" into the filter box moves
 * the cursor instead of inserting the characters. Checked against the live
 * `activeElement` on every event rather than tracked as state, because a focus
 * change that happens without a React render — `autofocus`, a browser
 * autofill, a click on a native control — would leave tracked state stale in
 * precisely the case that matters.
 */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT'
    || el.isContentEditable;
}

export interface ListKeyboardOptions {
  count: number;
  /** Omitted on screens without multi-select — Search is one (no bulk bar). */
  onToggleSelect?: (index: number) => void;
  onOpen: (index: number) => void;
  /** Returns true if it consumed the Escape — the inspector closing takes
   *  precedence over clearing the selection, so one press does one thing. */
  onEscape: () => boolean;
  onClearSelection?: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Suppressed while a modal owns the keyboard. */
  enabled?: boolean;
}

export function useListKeyboard({
  count,
  onToggleSelect,
  onOpen,
  onEscape,
  onClearSelection,
  searchRef,
  enabled = true,
}: ListKeyboardOptions) {
  const [cursor, setCursor] = useState(0);

  // Clamp when the list shrinks underneath the cursor — a refresh that drops
  // rows must not leave the cursor pointing past the end.
  const clamped = count === 0 ? 0 : Math.min(cursor, count - 1);
  if (clamped !== cursor) setCursor(clamped);

  // The cursor is never read directly by the handler — every key that needs it
  // reads it inside a `setCursor` updater. That is what keeps holding `j` down
  // from detaching and reattaching a window listener on every repeat: the
  // listener only re-registers when `count` or one of the callbacks changes.
  const move = useCallback((delta: number | 'first' | 'last') => {
    setCursor((current) => {
      if (count === 0) return 0;
      if (delta === 'first') return 0;
      if (delta === 'last') return count - 1;
      return Math.max(0, Math.min(count - 1, current + delta));
    });
  }, [count]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!enabled) return;
      // A dialog owns the keyboard until it closes (REQ-A11Y-002). Each screen
      // also passes its own `enabled`, but that is per-screen bookkeeping and
      // the rule is not: asserting it here is what makes the shortcut
      // reference's last line true on every screen at once, including ones
      // added later.
      if (isDialogOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Escape is the one key that still fires while typing — it is how the
      // operator gets back out of the search field.
      if (event.key === 'Escape') {
        if (isTyping()) {
          (document.activeElement as HTMLElement | null)?.blur();
          return;
        }
        event.preventDefault();
        if (onEscape()) return;
        onClearSelection?.();
        return;
      }

      if (isTyping()) return;

      switch (event.key) {
        case '/':
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case 'j':
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          return;
        case 'Home':
          event.preventDefault();
          move('first');
          return;
        case 'End':
          event.preventDefault();
          move('last');
          return;
        case 'PageDown':
          event.preventDefault();
          move(10);
          return;
        case 'PageUp':
          event.preventDefault();
          move(-10);
          return;
        case ' ':
          // Not preventDefault-ed when the screen has no selection: Space must
          // stay available to scroll the results, which is what it does on a
          // long list with nothing to select.
          if (count === 0 || !onToggleSelect) return;
          event.preventDefault();
          setCursor((i) => { onToggleSelect(i); return i; });
          return;
        case 'Enter':
          if (count === 0) return;
          event.preventDefault();
          setCursor((i) => { onOpen(i); return i; });
          return;
        default:
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, enabled, move, onClearSelection, onEscape, onOpen, onToggleSelect, searchRef]);

  return { cursor: clamped, setCursor };
}

/** Selection, keyed by row id so it survives a refetch (REQ-QUEUE-015). */
export function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  /**
   * Ids that vanished upstream are dropped silently. Keeping them would make the
   * bulk bar count rows the operator can no longer see, and the removal would
   * then act on records that are already gone.
   */
  const reconcile = useCallback((present: ReadonlySet<string>) => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => present.has(id)));
      return next.size === current.size ? current : next;
    });
  }, []);

  return { selected, toggle, clear, reconcile };
}
