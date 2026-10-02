import { describe, expect, it } from 'vitest';

import { applyRange, planExtend, planRange, rangeBetween } from '@/lib/rangeSelection';

/**
 * T1 / REQ-QUEUE-024, ADR-5 of queue-triage-ergonomics.
 *
 * The range semantics every multi-select screen shares, pinned without a DOM:
 * inclusive in either direction, computed over the displayed ids only, and
 * undefined — not guessed — when the anchor is not on screen.
 */
const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'];

describe('rangeBetween', () => {
  it('is inclusive at both ends, anchor before target', () => {
    expect(rangeBetween(rows, 'r3', 'r8')).toEqual(['r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  });

  it('is inclusive at both ends, anchor after target, in display order', () => {
    expect(rangeBetween(rows, 'r8', 'r3')).toEqual(['r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
  });

  it('is the single row when target is the anchor', () => {
    expect(rangeBetween(rows, 'r4', 'r4')).toEqual(['r4']);
  });

  it('has no range without an anchor', () => {
    expect(rangeBetween(rows, null, 'r4')).toBeNull();
  });

  it('has no range when the anchor is not displayed', () => {
    expect(rangeBetween(rows, 'gone', 'r4')).toBeNull();
  });

  it('has no range when the target is not displayed', () => {
    expect(rangeBetween(rows, 'r4', 'gone')).toBeNull();
  });

  it('never sweeps in rows a filter hides', () => {
    // r5 and r6 are filtered out: the displayed array is all the range sees.
    const displayed = rows.filter((id) => id !== 'r5' && id !== 'r6');
    const range = rangeBetween(displayed, 'r3', 'r8');
    expect(range).toEqual(['r3', 'r4', 'r7', 'r8']);
    expect(range).not.toContain('r5');
  });
});

describe('planRange', () => {
  it('gives the range the anchor row state', () => {
    const selected = new Set(['r3']);
    expect(planRange(rows, 'r3', 'r8', (id) => selected.has(id)))
      .toEqual({ ids: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'], state: true, anchor: 'r3' });
  });

  it('deselects when the anchor is deselected', () => {
    expect(planRange(rows, 'r4', 'r7', () => false)?.state).toBe(false);
  });

  it('has nothing to plan when the anchor is filtered out', () => {
    expect(planRange(['r1', 'r2'], 'r5', 'r2', () => true)).toBeNull();
  });
});

describe('planExtend', () => {
  it('extends with the anchor state', () => {
    expect(planExtend(rows, 'r2', 'r4', 'r5', (id) => id === 'r2'))
      .toEqual({ ids: ['r4', 'r5'], state: true, anchor: 'r2' });
  });

  it('makes the starting row the anchor and selects when there is none', () => {
    expect(planExtend(rows, null, 'r2', 'r3', () => false))
      .toEqual({ ids: ['r2', 'r3'], state: true, anchor: 'r2' });
  });

  it('treats an anchor that is no longer displayed as no anchor', () => {
    expect(planExtend(rows, 'gone', 'r2', 'r1', () => false)?.anchor).toBe('r2');
  });
});

describe('applyRange', () => {
  it('selects the range and leaves rows outside it alone', () => {
    const next = applyRange(new Set(['r1']), ['r3', 'r4'], true);
    expect([...next].sort()).toEqual(['r1', 'r3', 'r4']);
  });

  it('deselects the range and leaves rows outside it alone', () => {
    const all = new Set(rows);
    const next = applyRange(all, rangeBetween(rows, 'r4', 'r7')!, false);
    expect(rows.filter((id) => next.has(id))).toEqual(['r1', 'r2', 'r3', 'r8', 'r9', 'r10']);
  });

  it('does not mutate its input', () => {
    const before = new Set(['r1']);
    applyRange(before, ['r2'], true);
    expect([...before]).toEqual(['r1']);
  });
});
