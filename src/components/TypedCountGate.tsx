'use client';

import { useState } from 'react';

/**
 * The typed-count gate, shared by every irreversible bulk write (ADR-14, ADR-3).
 *
 * Extracted from rename's `ConfirmApplyDialog` (REQ-RENAME-010, ADR-8) so that
 * force import (REQ-QUEUE-022) runs the *same* gate, not a copy that drifts.
 * The operator types the number of items the write will touch; the confirm
 * control stays disabled until that number matches exactly.
 *
 * Two halves, so the gate can sit in a dialog body while the button it guards
 * sits in the dialog footer:
 *
 * - `useTypedCountGate(count)` owns the state and the matching rule. The
 *   caller wires its confirm button to `gate.matches` — disabled, never
 *   hidden — and sends `gate.expected`, never a re-read count.
 * - `<TypedCountGate gate={gate} … />` renders the labelled field and its
 *   live status line.
 *
 * There is deliberately no prop, option or setting that skips the gate
 * (ADR-8): a bypass would make it a formality for exactly the operators who
 * have done this often enough to stop reading.
 */

/**
 * The matching rule, in one place. The field is compared to the count, not
 * parsed for intent: surrounding whitespace is trimmed (it is not a typo), but
 * `"03"`, `"3.0"` or `"+3"` are misses — only the count's own decimal string
 * matches.
 */
export function typedCountMatches(typed: string, expected: number): boolean {
  return typed.trim() === String(expected);
}

export interface TypedCountGateState {
  /** The count captured when the gate mounted. Never recomputed. */
  expected: number;
  /** What the operator has typed, verbatim. */
  typed: string;
  setTyped: (value: string) => void;
  /** True only when `typed` matches `expected` under `typedCountMatches`. */
  matches: boolean;
  /** True once the field holds anything other than whitespace. */
  touched: boolean;
}

/**
 * Holds the gate's state. `count` is frozen at first render: a `useState`
 * initializer runs once for the life of the component, so a poll that fires a
 * second later cannot move the target out from under a half-typed number —
 * which would either reject a correct answer or accept one typed about a
 * different plan. Mount the owning dialog only while it is open, so "once" and
 * "at open" are the same moment.
 */
export function useTypedCountGate(count: number): TypedCountGateState {
  const [expected] = useState(count);
  const [typed, setTyped] = useState('');
  return {
    expected,
    typed,
    setTyped,
    matches: typedCountMatches(typed, expected),
    touched: typed.trim() !== '',
  };
}

export interface TypedCountGateProps {
  /** State from `useTypedCountGate`, shared with the confirm button. */
  gate: TypedCountGateState;
  /** The input's id; the label points at it. */
  inputId: string;
  /** The status line's id; the input is described by it. */
  hintId: string;
  /**
   * What typing the number attests to, rendered after "Type <n>". Defaults to
   * `"to confirm"`; rename says `"to confirm you have read the plan"`.
   */
  purpose?: string;
  /** The guarded action as a noun, e.g. `"rename"` or `"import"`. */
  action: string;
  /** Status line once the number matches, e.g. "Confirmed." */
  matchedMessage: string;
  /** Disables the field, e.g. while the write is being sent. */
  disabled?: boolean;
}

// No `autoFocus` option: the gate lives inside `Modal`, which moves focus to
// the dialog itself on mount, so a field that grabbed focus first would lose
// it a tick later and leave the operator typing into nothing.

export default function TypedCountGate({
  gate, inputId, hintId, purpose = 'to confirm', action, matchedMessage, disabled = false,
}: TypedCountGateProps) {
  const { expected, typed, setTyped, matches, touched } = gate;
  const wrong = touched && !matches;

  return (
    <div className="confirm-gate">
      <label className="confirm-gate__label" htmlFor={inputId}>
        Type <strong className="mono">{expected}</strong>{` ${purpose}`}
      </label>
      <input
        id={inputId}
        className="input mono confirm-gate__input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        disabled={disabled}
        aria-describedby={hintId}
        aria-invalid={wrong}
      />
      {/* Three states, and none of them mentions a way to skip this step —
          there is none to mention (ADR-8). */}
      <p
        id={hintId}
        className={`confirm-gate__hint${wrong ? ' is-wrong' : ''}`}
        role="status"
      >
        {!touched
          ? `Nothing is sent until this field reads ${expected}.`
          : matches
            ? matchedMessage
            : `That is not ${expected}. The ${action} stays disabled until it matches.`}
      </p>
    </div>
  );
}
