'use client';

/**
 * Shared UI primitives, ported from the design prototype.
 *
 * Only the primitives this change actually renders are ported. The prototype's
 * list-oriented pieces (Inspector, BulkBar, SearchField, Poster) arrive with the
 * changes that need them, so nothing here is dead on delivery.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

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

/* ---------------------------------------------------------------------------
   Modal — reserved for blocking confirmations (DESIGN.md §5). Traps Escape
   and restores focus to the trigger on close.
   ------------------------------------------------------------------------- */
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
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => {
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
