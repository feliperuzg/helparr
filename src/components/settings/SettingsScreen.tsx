'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import Icon from '../Icon';
import {
  Callout, EmptyState, KV, Modal, ScreenHead, StatusBadge, ToastStack, useToasts, type Tone,
} from '../ui';
import ChangePasswordCard from './ChangePasswordCard';
import ConnectionFields, { EMPTY_CREDENTIAL, toCredential, type CredentialDraft } from './ConnectionFields';
import { useConnectionTest } from './useConnectionTest';
import { api, ApiError } from '@/lib/api';
import { KIND_ICON, STATUS_LABEL, STATUS_TONE } from '@/lib/status';
import {
  INSTANCE_KINDS, KIND_LABEL,
  type InstanceDto, type InstanceHealthDto, type InstanceKind,
} from '@/lib/types';

export default function SettingsScreen({ initiallyAdding = false }: { initiallyAdding?: boolean }) {
  const { toasts, push } = useToasts();
  const [adding, setAdding] = useState(initiallyAdding);
  const addRef = useRef<HTMLDivElement>(null);

  /**
   * Scroll the deep-linked form into view once, on arrival from the guided
   * first run. Only when it was opened by the URL: doing it on every open would
   * yank the page under an operator who clicked the button they could already
   * see.
   *
   * `behavior` is left to default rather than forced to 'smooth' — a scroll is
   * motion, and DESIGN.md §7 has the reduced-motion answer everywhere else.
   */
  useEffect(() => {
    if (initiallyAdding) addRef.current?.scrollIntoView({ block: 'nearest' });
  }, [initiallyAdding]);

  const instances = useQuery({ queryKey: ['instances'], queryFn: api.listInstances });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });

  const byId = new Map((health.data?.instances ?? []).map((h) => [h.instanceId, h]));
  const rows = instances.data ?? [];

  return (
    <main className="main" id="main" tabIndex={-1}>
      <div className="content">
        <ScreenHead
          title="Settings"
          sub="Connection details for each *arr instance and the download client. Credentials are stored encrypted on the server and are never sent to the browser."
          actions={
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)} disabled={adding}>
              <Icon name="plus" size={12} />Add instance
            </button>
          }
        />

        <div className="content__scroll">
          <section className="section">
            <h2 className="section__title">Connections</h2>

            {adding ? (
              <div ref={addRef} style={{ marginBottom: 'var(--space-3)' }}>
                <AddInstanceCard onDone={() => setAdding(false)} onToast={push} />
              </div>
            ) : null}

            {instances.isPending ? (
              <p className="subtle">Loading instances…</p>
            ) : instances.isError ? (
              <Callout tone="error">
                {instances.error instanceof ApiError ? instances.error.message : 'Could not load instances.'}
              </Callout>
            ) : rows.length === 0 && !adding ? (
              <EmptyState title="No instances configured">
                Add Sonarr, Radarr, Prowlarr or your download client to get started. Nothing else in
                helparr works until at least one instance answers.
              </EmptyState>
            ) : (
              <div className="grid" style={{ gap: 'var(--space-3)' }}>
                {rows.map((instance) => (
                  <InstanceCard
                    key={instance.id}
                    instance={instance}
                    health={byId.get(instance.id)}
                    onToast={push}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Between Connections and About: this is a thing the operator
              *does*, so it belongs above the read-only facts, and below the
              instance work that is why they usually come to this screen. */}
          <section className="section" id="operator-password">
            <h2 className="section__title">Operator password</h2>
            <ChangePasswordCard onToast={push} />
          </section>

          <section className="section">
            <h2 className="section__title">About</h2>
            <div className="card">
              <KV
                rows={[
                  ['Version', 'helparr 0.1.0'],
                  ['Credentials', 'AES-encrypted SQLite, keyed by HELPARR_ENCRYPTION_KEY'],
                  ['Health polling', 'every 60s, with backoff after repeated failure'],
                  ['Mode', 'LAN-only, no public exposure'],
                ]}
              />
              <div style={{ marginTop: 'var(--space-4)' }}>
                <Callout tone="ok">
                  helparr never owns library state. Every read hits the live *arr instance and
                  every write goes back through their APIs, so Sonarr and Radarr stay the
                  source of truth.
                </Callout>
              </div>
            </div>
          </section>
        </div>
      </div>

      <ToastStack toasts={toasts} />
    </main>
  );
}

/* ------------------------------------------------------------------------- */

function InstanceCard({
  instance,
  health,
  onToast,
}: {
  instance: InstanceDto;
  health?: InstanceHealthDto;
  onToast: (message: string, tone?: Tone) => void;
}) {
  const queryClient = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(instance.baseUrl);
  const [credential, setCredential] = useState<CredentialDraft>(EMPTY_CREDENTIAL);
  const [confirming, setConfirming] = useState(false);
  const test = useConnectionTest(instance.kind);

  const state = instance.enabled ? (health?.state ?? instance.status) : 'disabled';
  const tone = STATUS_TONE[state];
  const dirty = baseUrl !== instance.baseUrl || toCredential(instance.kind, credential) !== null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['instances'] });
    void queryClient.invalidateQueries({ queryKey: ['health'] });
  };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateInstance(instance.id, { enabled }),
    onSuccess: (_data, enabled) => {
      refresh();
      onToast(`${instance.label} ${enabled ? 'enabled' : 'disabled'}`, 'ok');
    },
    onError: (error) => onToast(message(error), 'error'),
  });

  const save = useMutation({
    mutationFn: async () => {
      const cred = toCredential(instance.kind, credential);
      if (!cred || !test.token) throw new Error('Run a connection test first.');
      return api.updateInstance(instance.id, { baseUrl, credential: cred, testToken: test.token });
    },
    onSuccess: () => {
      setCredential(EMPTY_CREDENTIAL);
      test.clear();
      refresh();
      onToast(`${instance.label} connection updated`, 'ok');
    },
    onError: (error) => onToast(message(error), 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteInstance(instance.id),
    onSuccess: () => {
      setConfirming(false);
      refresh();
      onToast(`${instance.label} removed`, 'ok');
    },
    onError: (error) => {
      setConfirming(false);
      onToast(message(error), 'error');
    },
  });

  async function runTest() {
    const cred = toCredential(instance.kind, credential);
    if (!cred) return;
    const outcome = await test.run(baseUrl, cred);
    onToast(`${instance.label}: ${outcome.ok ? 'connection OK' : 'connection failed'}`, outcome.ok ? 'ok' : 'error');
  }

  const canTest = toCredential(instance.kind, credential) !== null && baseUrl.trim().length > 0;

  return (
    <div className="card">
      <div className="card__head">
        <Icon name={KIND_ICON[instance.kind]} size={14} />
        <span className="card__title">{instance.label}</span>
        <span className="badge badge-neutral">{KIND_LABEL[instance.kind]}</span>
        <StatusBadge tone={tone}>{STATUS_LABEL[state]}</StatusBadge>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <label className="sr-only" htmlFor={`enable-${instance.id}`}>Enable {instance.label}</label>
          <input
            type="checkbox"
            className="toggle"
            id={`enable-${instance.id}`}
            checked={instance.enabled}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
        </span>
      </div>

      {/* AC10: one instance's failure is reported on its own card and nowhere
          else — no screen is blocked, no global error state is entered. */}
      {instance.enabled && health && health.state !== 'ok' && health.reason ? (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Callout tone={tone === 'ok' ? 'info' : tone}>
            {health.reason}
            {health.retryAt ? (
              <span className="subtle"> · next retry {new Date(health.retryAt).toLocaleTimeString()}</span>
            ) : null}
          </Callout>
        </div>
      ) : null}

      <ConnectionFields
        idPrefix={instance.id}
        kind={instance.kind}
        baseUrl={baseUrl}
        onBaseUrl={(v) => { setBaseUrl(v); test.clear(); }}
        credential={credential}
        onCredential={(v) => { setCredential(v); test.clear(); }}
        disabled={!instance.enabled}
        hint={`Stored as ${instance.credentialHint} — re-enter it to test or change this connection.`}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={runTest}
          disabled={!instance.enabled || test.pending || !canTest}
        >
          {test.pending ? <span className="spinner" /> : <Icon name="plug" size={12} />}
          {test.pending ? 'Testing…' : 'Test connection'}
        </button>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => save.mutate()}
          disabled={!instance.enabled || !test.token || save.isPending}
          title={test.token ? undefined : 'A successful connection test is required before saving.'}
        >
          {save.isPending ? <span className="spinner" /> : <Icon name="check" size={12} />}
          Save changes
        </button>

        {/* Result only ever renders after the round-trip resolves. */}
        {test.result ? (
          <StatusBadge tone={test.result.tone}>{test.result.text}</StatusBadge>
        ) : dirty ? (
          <span className="mono subtle">unsaved — test to continue</span>
        ) : (
          <span className="mono subtle">
            {instance.version ? `${instance.version} · ` : ''}
            {instance.lastCheckedAt
              ? `checked ${new Date(instance.lastCheckedAt).toLocaleTimeString()}`
              : 'never checked'}
          </span>
        )}

        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirming(true)}>
          <Icon name="x" size={12} />Remove
        </button>
      </div>

      {confirming ? (
        <Modal
          title={`Remove ${instance.label}?`}
          labelledBy={`remove-${instance.id}`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger-solid btn-sm"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending ? <span className="spinner" /> : <Icon name="x" size={12} />}
                Remove instance
              </button>
            </>
          }
        >
          <p>
            helparr will forget this connection and its stored credential. Nothing changes inside{' '}
            {KIND_LABEL[instance.kind]} itself — no library, download or file is touched.
          </p>
          <p className="subtle" style={{ marginTop: 'var(--space-2)' }}>
            To silence a known-down instance without re-entering its credential later, turn it off
            with the toggle instead.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function AddInstanceCard({
  onDone,
  onToast,
}: {
  onDone: () => void;
  onToast: (message: string, tone?: Tone) => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<InstanceKind>('sonarr');
  const [label, setLabel] = useState(KIND_LABEL.sonarr);
  const [baseUrl, setBaseUrl] = useState('');
  const [credential, setCredential] = useState<CredentialDraft>(EMPTY_CREDENTIAL);
  const test = useConnectionTest(kind);

  const create = useMutation({
    mutationFn: async () => {
      const cred = toCredential(kind, credential);
      if (!cred || !test.token) throw new Error('Run a connection test first.');
      return api.createInstance({ kind, label: label.trim(), baseUrl, credential: cred, testToken: test.token });
    },
    onSuccess: (instance) => {
      void queryClient.invalidateQueries({ queryKey: ['instances'] });
      void queryClient.invalidateQueries({ queryKey: ['health'] });
      onToast(`${instance.label} added`, 'ok');
      onDone();
    },
    onError: (error) => onToast(message(error), 'error'),
  });

  function changeKind(next: InstanceKind) {
    setKind(next);
    // The label defaults to the product name, but only while it is untouched.
    if (label === KIND_LABEL[kind]) setLabel(KIND_LABEL[next]);
    setCredential(EMPTY_CREDENTIAL);
    test.clear();
  }

  async function runTest() {
    const cred = toCredential(kind, credential);
    if (!cred) return;
    const outcome = await test.run(baseUrl, cred);
    onToast(`${label || KIND_LABEL[kind]}: ${outcome.ok ? 'connection OK' : 'connection failed'}`, outcome.ok ? 'ok' : 'error');
  }

  const canTest = toCredential(kind, credential) !== null && baseUrl.trim().length > 0;

  return (
    <div className="card">
      <div className="card__head">
        <Icon name={KIND_ICON[kind]} size={14} />
        <span className="card__title">New instance</span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" className="icon-btn" onClick={onDone} aria-label="Cancel adding an instance">
            <Icon name="x" size={14} />
          </button>
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-3)',
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor="new-kind">Type</label>
          <select
            id="new-kind"
            className="input"
            value={kind}
            onChange={(e) => changeKind(e.target.value as InstanceKind)}
          >
            {INSTANCE_KINDS.map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="new-label">Label</label>
          <input
            id="new-label"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={64}
          />
          <span className="field__hint">Shown in the sidebar. Must be unique per type.</span>
        </div>
      </div>

      <ConnectionFields
        idPrefix="new"
        kind={kind}
        baseUrl={baseUrl}
        onBaseUrl={(v) => { setBaseUrl(v); test.clear(); }}
        credential={credential}
        onCredential={(v) => { setCredential(v); test.clear(); }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline btn-sm" onClick={runTest} disabled={test.pending || !canTest}>
          {test.pending ? <span className="spinner" /> : <Icon name="plug" size={12} />}
          {test.pending ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => create.mutate()}
          disabled={!test.token || !label.trim() || create.isPending}
          title={test.token ? undefined : 'A successful connection test is required before saving.'}
        >
          {create.isPending ? <span className="spinner" /> : <Icon name="check" size={12} />}
          Save instance
        </button>
        {test.result ? (
          <StatusBadge tone={test.result.tone}>{test.result.text}</StatusBadge>
        ) : (
          <span className="mono subtle">test the connection before saving</span>
        )}
      </div>
    </div>
  );
}

function message(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
