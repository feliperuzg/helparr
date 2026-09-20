'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import Icon from '../Icon';
import { Callout, type Tone } from '../ui';
import { api, ApiError } from '@/lib/api';
import { MIN_OPERATOR_PASSWORD_LENGTH } from '@/lib/types';

/**
 * Operator password rotation (REQ-AUTH-009, FR1–FR6).
 *
 * The current password is asked for even though the operator is already signed
 * in — an unattended tab is the normal state of a homelab dashboard, and the
 * re-authentication also closes the CSRF hole a session-only change would open.
 *
 * Per-field reveal toggles rather than one shared toggle: someone proofreading
 * a fumbled new password should not have to expose their current one to do it.
 */

interface Refusal {
  tone: Tone;
  message: string;
  /** Throttled refusals disable the whole form, not just the button (NFR2). */
  lockOut?: boolean;
}

export default function ChangePasswordCard({
  onToast,
}: {
  onToast: (message: string, tone?: Tone) => void;
}) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const mismatch = next.length > 0 && confirm.length > 0 && next !== confirm;

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setRefusal(null);
      // The provisional-credential banner is derived from the health payload
      // (ADR-8). Invalidating the query is what makes it disappear now rather
      // than up to 60 seconds from now, on the next poll.
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      onToast("Operator password changed. You're still signed in on this device.", 'ok');
    },
    onError: (error) => {
      const status = error instanceof ApiError ? error.status : 0;
      const message = error instanceof ApiError ? error.message : 'Could not change the password.';

      if (status === 429) {
        // `warn`, not `error`: this refusal is not about anything the operator
        // typed being wrong, and the rest of the app already uses that tone
        // split for "the system is protecting itself".
        setRefusal({ tone: 'warn', message, lockOut: true });
        return;
      }

      // Only the current-password field clears. Preserving the new password
      // means a correct retry does not cost the operator what they already
      // typed — and on a length refusal, nothing typed was wrong at all.
      if (status === 401) setCurrent('');
      setRefusal({ tone: 'error', message });
    },
  });

  const lockedOut = refusal?.lockOut === true;
  const busy = change.isPending || lockedOut;
  const complete = current.length > 0 && next.length > 0 && confirm.length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete || mismatch || busy) return;
    change.mutate();
  }

  return (
    <div className="card">
      <div className="card__head">
        <Icon name="lock" size={14} />
        <span className="card__title">Operator password</span>
      </div>

      <p className="screen-head__sub" style={{ marginBottom: 'var(--space-4)' }}>
        Change the password used to sign in. This does not touch any *arr instance credential
        above — helparr has exactly one operator account.
      </p>

      {refusal ? (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Callout tone={refusal.tone}>{refusal.message}</Callout>
        </div>
      ) : null}

      <form onSubmit={submit}>
        <PasswordField
          id="current-password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          disabled={busy}
        />
        <PasswordField
          id="new-password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          disabled={busy}
          hint={`At least ${MIN_OPERATOR_PASSWORD_LENGTH} characters.`}
        />
        <PasswordField
          id="confirm-password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          disabled={busy}
          error={mismatch ? 'Passwords do not match.' : undefined}
        />

        <p className="field__hint" style={{ marginTop: 'var(--space-3)' }}>
          Changing this signs every other browser and device out. This one stays signed in.
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!complete || mismatch || busy}
          >
            {change.isPending ? <span className="spinner" /> : <Icon name="check" size={12} />}
            {change.isPending ? 'Changing password…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoComplete,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  autoComplete: string;
  hint?: string;
  error?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="field" style={{ marginBottom: 'var(--space-3)' }}>
      <label className="field__label" htmlFor={id}>{label}</label>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input
          id={id}
          className="input"
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          aria-invalid={error ? true : undefined}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Reveal ${label.toLowerCase()}`}
          aria-pressed={revealed}
          disabled={disabled}
        >
          <Icon name="eye" size={14} />
        </button>
      </div>
      {error ? (
        <span className="field__hint" id={`${id}-error`} style={{ color: 'var(--color-status-error)' }}>
          {error}
        </span>
      ) : hint ? (
        <span className="field__hint" id={`${id}-hint`}>{hint}</span>
      ) : null}
    </div>
  );
}
