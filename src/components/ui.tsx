'use client';

/**
 * Shared UI primitives, ported from the design prototype.
 *
 * Only the primitives the shipped screens actually render are ported, so
 * nothing here is dead on delivery. The list-oriented pieces below — Inspector,
 * BulkBar, SearchField, KeyboardHints — arrived with `unified-queue-overview`.
 * `Poster` is still absent: no shipped screen has artwork to show yet.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import Icon, { type IconName } from './Icon';

export type Tone = 'ok' | 'warn' | 'error' | 'idle';

/* ---------------------------------------------------------------------------
   StatusBadge — colour is never the only channel (DESIGN.md §7). Every badge
   pairs a tone with an icon AND a text label.
   ------------------------------------------------------------------------- */
const TONE_ICON: Record<Tone, IconName> = {
  ok: 'check',
  warn: 'alert',
  error: 'x',
  idle: 'clock',
};

export function StatusBadge({
  tone = 'idle',
  icon,
  children,
  glow = false,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  glow?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      <Icon name={icon || TONE_ICON[tone]} size={11} className={glow ? 'glow' : undefined} />
      {children}
    </span>
  );
}

export function StatusDot({
  tone = 'idle',
  pulse = false,
  label,
}: {
  tone?: Tone;
  pulse?: boolean;
  label: string;
}) {
  const color = {
    ok: 'var(--color-status-ok)',
    warn: 'var(--color-status-warn)',
    error: 'var(--color-status-error)',
    idle: 'var(--color-status-idle)',
  }[tone];
  return (
    <span
      className={`dot${pulse ? ' dot--pulse' : ''}`}
      style={{ color, background: color }}
      role="img"
      aria-label={label}
    />
  );
}

export function KV({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt className="kv__k">{k}</dt>
          <dd className="kv__v">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Callout({
  tone = 'info',
  icon,
  children,
}: {
  tone?: Tone | 'info';
  icon?: IconName;
  children: ReactNode;
}) {
  const cls = tone === 'info' ? 'callout' : `callout callout--${tone}`;
  const name: IconName =
    icon || ({ warn: 'alert', error: 'alert', ok: 'check', idle: 'clock', info: 'info' } as const)[tone];
  return (
    <div className={cls}>
      <Icon name={name} size={14} />
      <div>{children}</div>
    </div>
  );
}

export function SearchField({
  inputRef,
  value,
  onChange,
  placeholder,
  label,
  mono = false,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <div className="search">
      <Icon name="search" size={13} />
      <label className="sr-only" htmlFor="list-search">{label}</label>
      <input
        id="list-search"
        ref={inputRef}
        className={`input${mono ? ' mono' : ''}`}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="search__kbd"><kbd className="kbd">/</kbd></span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   FilterChip — a toggle, not a tab. Several can be on at once (indexer scope),
   so the group is a plain `role="group"` of `aria-pressed` buttons rather than
   a listbox or a radio group.
   ------------------------------------------------------------------------- */

/** The wrapper is exported alongside the chip because the accessible group
 *  label is not optional: a bare row of toggles announces no subject. */
export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="chip-row" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function FilterChip({
  label,
  selected,
  onToggle,
  count,
  degraded = false,
  degradedReason,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  /** Rendered trailing and muted. `0` is shown — an explicit zero is a fact. */
  count?: number;
  /** Unhealthy scope: visible, focusable, and inert until it answers again. */
  degraded?: boolean;
  degradedReason?: string;
}) {
  // Glyph first, colour second: selection has to survive a monochrome display
  // and a colour-blind operator, so `●` / `○` / `⚠` carry it on their own
  // (DESIGN.md §7). Hidden from assistive tech, which reads `aria-pressed`.
  const glyph = degraded ? '⚠' : selected ? '●' : '○';

  const className = [
    'filter-chip',
    selected && !degraded ? 'is-on' : '',
    degraded ? 'is-degraded' : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={className}
      // Not the `disabled` attribute: a disabled button drops out of the tab
      // order, and the operator would never reach the explanation for why the
      // indexer cannot be scoped to.
      aria-pressed={selected}
      aria-disabled={degraded || undefined}
      title={degraded ? degradedReason : undefined}
      onClick={() => { if (!degraded) onToggle(); }}
    >
      <span className="filter-chip__glyph" aria-hidden="true">{glyph}</span>
      <span className="filter-chip__label">{label}</span>
      {count === undefined ? null : <span className="filter-chip__count">{count}</span>}
      {degraded && degradedReason ? <span className="sr-only">{degradedReason}</span> : null}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Inspector — detail opens beside the list, never over it (DESIGN.md §5).
   ------------------------------------------------------------------------- */
export function Inspector({
  eyebrow,
  title,
  onClose,
  footer,
  label = 'Queue item detail',
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** What the panel is showing. Two panels on one screen must not share a name. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <aside className="inspector" aria-label={label}>
      <div className="inspector__head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="inspector__eyebrow">{eyebrow}</div>
          <div className="inspector__title">{title}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close inspector (Esc)">
          <Icon name="x" size={14} />
        </button>
      </div>
      {/* Focusable because it scrolls (WCAG 2.1.1). A panel whose content
          happens to contain a button is reachable by accident; one that does
          not — the rename detail is paths, flags and prose — traps its own
          overflow away from anyone not using a pointer. */}
      <div className="inspector__body" tabIndex={0}>{children}</div>
      {footer ? <div className="inspector__foot">{footer}</div> : null}
    </aside>
  );
}

export function InspectorGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="inspector__group">
      <h3 className="inspector__group-title">{title}</h3>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   Sticky bulk-action bar — appears only when >= 1 row is selected, and states
   the exact count. "Several" is not an option: the number has to match what
   the action will affect (REQ-QUEUE-013).
   ------------------------------------------------------------------------- */
export function BulkBar({
  count,
  noun,
  onClear,
  children,
}: {
  count: number;
  noun: string;
  onClear: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="bulkbar" role="region" aria-label="Bulk actions">
      <span className="bulkbar__count">
        {count} {noun}{count === 1 ? '' : 's'} selected
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button>
      <span className="bulkbar__spacer" />
      {children}
    </div>
  );
}

export function KeyboardHints({ items }: { items: Array<[string[], string]> }) {
  return (
    <div className="hint-row">
      {items.map(([keys, label]) => (
        <span className="hint" key={label}>
          {keys.map((k) => <kbd className="kbd" key={k}>{k}</kbd>)}
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Modal — reserved for blocking confirmations (DESIGN.md §5). Traps Tab and
   Escape, and restores focus to the trigger on close.
   ------------------------------------------------------------------------- */

/** Everything the platform considers focusable that a dialog can contain. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * How many dialogs are currently up.
 *
 * `aria-modal="true"` claims nothing behind the dialog exists. Tab honours that
 * because the trap below makes it, but the app's other window-level key
 * handlers — the list cursor, the shell's digit shortcuts — would otherwise
 * keep firing underneath, and the claim would be false for exactly the keys
 * that change state. Read through `isDialogOpen()` rather than a context so a
 * plain `keydown` handler can consult it without re-rendering on every open.
 */
let openDialogs = 0;

export function isDialogOpen(): boolean {
  return openDialogs > 0;
}

export function Modal({
  title,
  onClose,
  footer,
  children,
  labelledBy = 'modal-title',
}: {
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openDialogs += 1;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;

      // `aria-modal="true"` tells assistive tech that nothing behind the dialog
      // exists. Without this the claim is false for the keyboard: Tab walks off
      // the footer into the sidebar, and the operator is editing a screen the
      // browser says is not there.
      const root = ref.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
        // A radio group is one tab stop, not one per radio — the checked one,
        // or the first when none is. Counting each radio separately puts the
        // "first stop" behind the group, and Shift+Tab walks straight past it.
        if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true;
        const group = root.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(el.name)}"]`,
        );
        return el === ([...group].find((radio) => radio.checked) ?? group[0]);
      });
      const active = document.activeElement as HTMLElement | null;

      if (items.length === 0) {
        // A dialog with nothing to focus still holds the keyboard; the panel
        // itself is the only stop.
        e.preventDefault();
        root.focus();
        return;
      }
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (active === edge || active === root || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
      openDialogs -= 1;
      window.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref} tabIndex={-1}>
        <div className="modal__head">
          <h2 className="modal__title" id={labelledBy}>{title}</h2>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Toasts — the only place a write reports its outcome. Never optimistic:
   screens push a toast after the round-trip resolves.
   ------------------------------------------------------------------------- */
export interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <Icon name={t.tone === 'ok' ? 'check' : 'alert'} size={14} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  function push(message: string, tone: Tone = 'ok') {
    seq.current += 1;
    const id = seq.current;
    setToasts((t) => [...t, { id, message, tone }]);
    timers.current.push(
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200),
    );
  }

  return { toasts, push };
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Icon name="plug" size={20} />
      <p className="empty__title">{title}</p>
      <p className="empty__body">{children}</p>
    </div>
  );
}

export function ScreenHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="screen-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="screen-head__title">{title}</h1>
        {sub ? <p className="screen-head__sub">{sub}</p> : null}
      </div>
      {actions ? <div className="screen-head__actions">{actions}</div> : null}
    </header>
  );
}
