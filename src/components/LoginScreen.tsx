'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import Icon from './Icon';
import { Callout } from './ui';
import { api, ApiError } from '@/lib/api';

export default function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Only ever an open redirect to a path on this origin. `next` arrives from the
   * middleware as a pathname, but it is still user-controllable input.
   */
  const next = (() => {
    const raw = params.get('next');
    return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  })();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.login(password);
      setPassword('');
      router.replace(next);
      router.refresh();
    } catch (caught) {
      // The server's message is deliberately generic for a wrong password; it
      // is more specific for throttling and for "no password configured", which
      // are the two cases an operator can actually act on.
      setError(caught instanceof ApiError ? caught.message : 'Sign-in failed.');
      setPending(false);
    }
  }

  return (
    <main
      className="auth"
      id="main"
      tabIndex={-1}
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div className="card" style={{ width: 'min(380px, 100%)' }}>
        <div className="brand" style={{ border: 'none', background: 'none', padding: 0, marginBottom: 'var(--space-4)' }}>
          <span className="brand__mark" aria-hidden="true"><Icon name="plug" size={13} /></span>
          <span className="brand__name">helparr</span>
          <span className="brand__version">0.1.0</span>
        </div>

        <h1 className="screen-head__title" style={{ marginBottom: 'var(--space-1)' }}>Sign in</h1>
        <p className="screen-head__sub" style={{ marginBottom: 'var(--space-4)' }}>
          One operator password protects every stored credential on this server.
        </p>

        {error ? (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <Callout tone="error">{error}</Callout>
          </div>
        ) : null}

        <form onSubmit={submit}>
          <div className="field">
            <label className="field__label" htmlFor="operator-password">
              <Icon name="lock" size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4 }} />
              Password
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input
                id="operator-password"
                className="input"
                type={revealed ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
                disabled={pending}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setRevealed((v) => !v)}
                aria-label={revealed ? 'Hide password' : 'Reveal password'}
                aria-pressed={revealed}
              >
                <Icon name="eye" size={14} />
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 'var(--space-4)', justifyContent: 'center' }}
            disabled={pending || password.length === 0}
          >
            {pending ? <span className="spinner" /> : <Icon name="arrowRight" size={13} />}
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="field__hint" style={{ marginTop: 'var(--space-4)' }}>
          First run? Set <code className="mono">HELPARR_INITIAL_PASSWORD</code> before starting the
          server; helparr hashes it on first boot and never stores the plaintext.
        </p>
      </div>
    </main>
  );
}
