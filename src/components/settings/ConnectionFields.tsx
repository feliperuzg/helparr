'use client';

import { useState } from 'react';

import Icon from '../Icon';
import type { CredentialInput } from '@/lib/api';
import { CREDENTIAL_TYPE_BY_KIND, type InstanceKind } from '@/lib/types';

export interface CredentialDraft {
  apiKey: string;
  username: string;
  password: string;
}

export const EMPTY_CREDENTIAL: CredentialDraft = { apiKey: '', username: '', password: '' };

/**
 * A draft is only convertible once every field the kind needs is filled. The
 * stored credential is never read back out of the server, so "leave it blank to
 * keep the old one" is not on offer — testing a connection means supplying the
 * credential that will be tested.
 */
export function toCredential(kind: InstanceKind, draft: CredentialDraft): CredentialInput | null {
  if (CREDENTIAL_TYPE_BY_KIND[kind] === 'api-key') {
    return draft.apiKey.trim() ? { type: 'api-key', apiKey: draft.apiKey.trim() } : null;
  }
  return draft.username.trim() && draft.password
    ? { type: 'userpass', username: draft.username.trim(), password: draft.password }
    : null;
}

export default function ConnectionFields({
  idPrefix,
  kind,
  baseUrl,
  onBaseUrl,
  credential,
  onCredential,
  disabled = false,
  hint,
}: {
  idPrefix: string;
  kind: InstanceKind;
  baseUrl: string;
  onBaseUrl: (value: string) => void;
  credential: CredentialDraft;
  onCredential: (value: CredentialDraft) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const usesApiKey = CREDENTIAL_TYPE_BY_KIND[kind] === 'api-key';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 'var(--space-3)',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-url`}>Base URL</label>
        <input
          id={`${idPrefix}-url`}
          className="input mono"
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder="http://10.0.0.5:8989"
        />
        <span className="field__hint">Reached from the helparr server, not from your browser.</span>
      </div>

      {usesApiKey ? (
        <div className="field">
          <label className="field__label" htmlFor={`${idPrefix}-key`}>
            <Icon name="key" size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4 }} />
            API key
          </label>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input
              id={`${idPrefix}-key`}
              className="input mono"
              type={revealed ? 'text' : 'password'}
              value={credential.apiKey}
              onChange={(e) => onCredential({ ...credential, apiKey: e.target.value })}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? 'Hide API key' : 'Reveal API key'}
              aria-pressed={revealed}
              disabled={disabled}
            >
              <Icon name="eye" size={14} />
            </button>
          </div>
          <span className="field__hint">{hint ?? 'Proxied server-side — never sent to the browser.'}</span>
        </div>
      ) : (
        <>
          <div className="field">
            <label className="field__label" htmlFor={`${idPrefix}-user`}>Username</label>
            <input
              id={`${idPrefix}-user`}
              className="input mono"
              type="text"
              value={credential.username}
              onChange={(e) => onCredential({ ...credential, username: e.target.value })}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${idPrefix}-pass`}>
              <Icon name="lock" size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4 }} />
              Password
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input
                id={`${idPrefix}-pass`}
                className="input mono"
                type={revealed ? 'text' : 'password'}
                value={credential.password}
                onChange={(e) => onCredential({ ...credential, password: e.target.value })}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setRevealed((v) => !v)}
                aria-label={revealed ? 'Hide password' : 'Reveal password'}
                aria-pressed={revealed}
                disabled={disabled}
              >
                <Icon name="eye" size={14} />
              </button>
            </div>
            <span className="field__hint">{hint ?? 'Proxied server-side — never sent to the browser.'}</span>
          </div>
        </>
      )}
    </div>
  );
}
