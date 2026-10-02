'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { applyRange, planExtend, planRange } from '@/lib/rangeSelection';

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
  /** Shift+J/K, Shift+ArrowDown/Up: the cursor moved `from` → `to` and the
   *  selection extends to the row reached (REQ-QUEUE-012). Without it the
   *  shifted keys move the cursor like their plain forms. */
  onExtend?: (from: number, to: number) => void;
  /** Shift+Space: select from the anchor to the row under the cursor. */
  onSelectRange?: (index: number) => void;
  /** `e`: expand or collapse the inspector (REQ-QUEUE-011). Omitted while no
   *  inspector is open, so the key does nothing rather than flipping a
   *  preference the operator cannot see. */
  onToggleExpand?: () => void;
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
  onExtend,
  onSelectRange,
  onToggleExpand,
  searchRef,
  enabled = true,
}: ListKeyboardOptions) {
  const [cursor, setCursor] = useState(0);
  // The range keys need the cursor *and* a side effect, and a side effect
  // inside a `setCursor` updater runs twice under Strict Mode. So they read the
  // cursor from a ref the handler keeps current itself, and the effect below
  // resyncs it after any other path — a click, a clamp — has moved the cursor.
  const cursorRef = useRef(0);

  // Clamp when the list shrinks underneath the cursor — a refresh that drops
  // rows must not leave the cursor pointing past the end.
  const clamped = count === 0 ? 0 : Math.min(cursor, count - 1);
  if (clamped !== cursor) setCursor(clamped);

  useEffect(() => { cursorRef.current = clamped; }, [clamped]);

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

  const extend = useCallback((delta: number) => {
    if (count === 0) return;
    const from = Math.min(cursorRef.current, count - 1);
    const to = Math.max(0, Math.min(count - 1, from + delta));
    cursorRef.current = to;
    setCursor(to);
    onExtend?.(from, to);
  }, [count, onExtend]);

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

      // The shifted range keys are matched before the plain switch, and only
      // these: `/` is Shift+7 on several layouts, so Shift must not disable
      // the keys that never had a shifted meaning.
      if (event.shiftKey) {
        switch (event.key) {
          case 'J':
          case 'ArrowDown':
            if (!onExtend) break;
            event.preventDefault();
            extend(1);
            return;
          case 'K':
          case 'ArrowUp':
            if (!onExtend) break;
            event.preventDefault();
            extend(-1);
            return;
          case ' ':
            if (count === 0 || !onSelectRange) break;
            event.preventDefault();
            onSelectRange(Math.min(cursorRef.current, count - 1));
            return;
          default:
        }
      }

      switch (event.key) {
        case 'e':
          if (!onToggleExpand) return;
          event.preventDefault();
          onToggleExpand();
          return;
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
  }, [count, enabled, extend, move, onClearSelection, onEscape, onExtend, onOpen, onSelectRange, onToggleExpand, onToggleSelect, searchRef]);

  return { cursor: clamped, setCursor };
}

/**
 * An open inspector shows the row under the cursor, at either width
 * (REQ-QUEUE-011, queue-triage-ergonomics AC3): j/k re-point it.
 *
 * Adjusted during render, not in an effect, and keyed on the cursor moving
 * rather than on the list — a refetch that reorders rows under a still cursor
 * leaves the record being read alone.
 */
export function useInspectorFollowsCursor(
  cursor: number,
  openId: string | null,
  idAt: (index: number) => string | undefined,
  setOpenId: (id: string) => void,
) {
  const [seen, setSeen] = useState(cursor);
  if (seen !== cursor) {
    setSeen(cursor);
    const next = idAt(cursor);
    if (openId !== null && next !== undefined && next !== openId) setOpenId(next);
  }
}

/** What a range gesture did — the screen announces it (REQ-A11Y-011). */
export interface RangeOutcome {
  /** Rows the gesture set. */
  changed: number;
  /** The state they took. */
  selected: boolean;
  /** The selection size afterwards — what the bulk bar will state. */
  total: number;
}

/**
 * Selection, keyed by row id so it survives a refetch (REQ-QUEUE-015), with an
 * anchor for range gestures (REQ-QUEUE-024, ADR-5).
 *
 * The range methods compute the next set from this render's selection rather
 * than inside a `setSelected` updater: they return what they did so the screen
 * can announce it, and an updater with a side effect runs twice under Strict
 * Mode. Every caller is a discrete input event, which React renders before the
 * next one arrives, so this render's selection is the current one.
 */
export function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const toggle = useCallback((id: string) => {
    setAnchor(id);
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setAnchor(null);
    setSelected(new Set());
  }, []);

  /** Every id in `ids` set to `state`; the rest untouched. */
  const setMany = useCallback((ids: readonly string[], state: boolean) => {
    setSelected((current) => applyRange(current, ids, state));
  }, []);

  /**
   * shift+click or Shift+Space onto `target`: anchor → target takes the
   * anchor's state, over `displayed` only. With no displayed anchor the
   * gesture is a plain toggle of the target, which becomes the anchor.
   */
  const rangeTo = useCallback((displayed: readonly string[], target: string): RangeOutcome => {
    const plan = planRange(displayed, anchor, target, (id) => selected.has(id));
    if (!plan) {
      const state = !selected.has(target);
      const next = applyRange(selected, [target], state);
      setAnchor(target);
      setSelected(next);
      return { changed: 1, selected: state, total: next.size };
    }
    const next = applyRange(selected, plan.ids, plan.state);
    setSelected(next);
    return { changed: plan.ids.length, selected: plan.state, total: next.size };
  }, [anchor, selected]);

  /** Shift+J/K: the cursor moved `from` → `to`; both take the anchor's state. */
  const extend = useCallback((displayed: readonly string[], from: string, to: string): RangeOutcome | null => {
    const plan = planExtend(displayed, anchor, from, to, (id) => selected.has(id));
    if (!plan) return null;
    const next = applyRange(selected, plan.ids, plan.state);
    if (plan.anchor !== anchor) setAnchor(plan.anchor);
    setSelected(next);
    return { changed: plan.ids.length, selected: plan.state, total: next.size };
  }, [anchor, selected]);

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

  return { selected, anchor, toggle, clear, setMany, rangeTo, extend, reconcile };
}
