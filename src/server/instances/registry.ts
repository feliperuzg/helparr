import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  CREDENTIAL_TYPE_BY_KIND,
  type HealthState,
  type InstanceDto,
  type InstanceKind,
} from '@/lib/types';
import { getDb } from '@/server/db';
import { ArrClient } from '@/server/clients/arr';
import { ProwlarrClient } from '@/server/clients/prowlarr';
import { QbitClient, clearSession } from '@/server/clients/qbit';
import type { InstanceClient } from '@/server/clients/types';
import { disposeBreaker } from '@/server/resilience/breaker';
import { registerSecret } from '@/server/logging/redact';
import {
  credentialHint,
  credentialSecrets,
  parseCredential,
  serializeCredential,
  type Credential,
} from './credential';

/**
 * Instance registry — the single place a credential is read from storage.
 *
 * Every function that returns something to a caller outside `src/server`
 * returns an `InstanceDto`, which has no credential field. Decrypted
 * credentials leave this module only as a constructed client (T5/T6), never as
 * data (REQ-INST-005).
 */

interface InstanceRow {
  id: string;
  kind: InstanceKind;
  label: string;
  base_url: string;
  credential: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_status: HealthState;
  last_version: string | null;
  last_checked_at: string | null;
}

function toDto(row: InstanceRow): InstanceDto {
  const credential = parseCredential(row.credential);
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    credentialType: credential.type,
    credentialHint: credentialHint(credential),
    status: row.enabled === 1 ? row.last_status : 'disabled',
    version: row.last_version,
    lastCheckedAt: row.last_checked_at,
  };
}

function rows(): InstanceRow[] {
  return getDb()
    .prepare('SELECT * FROM instance ORDER BY kind, label')
    .all() as InstanceRow[];
}

export function listInstances(): InstanceDto[] {
  return rows().map(toDto);
}

export function getInstance(id: string): InstanceDto | null {
  const row = getDb().prepare('SELECT * FROM instance WHERE id = ?').get(id) as
    | InstanceRow
    | undefined;
  return row ? toDto(row) : null;
}

/** Server-internal: the decrypted record. Never returned from a route handler. */
function getRecord(id: string): (InstanceRow & { parsed: Credential }) | null {
  const row = getDb().prepare('SELECT * FROM instance WHERE id = ?').get(id) as
    | InstanceRow
    | undefined;
  if (!row) return null;
  return { ...row, parsed: parseCredential(row.credential) };
}

export function buildClient(
  id: string,
  kind: InstanceKind,
  baseUrl: string,
  credential: Credential,
): InstanceClient {
  // Registering here means the value is scrubbed from any log line for the
  // lifetime of the process, including upstream errors that echo it back.
  for (const secret of credentialSecrets(credential)) registerSecret(secret);

  if (kind === 'download-client') {
    return new QbitClient(id, { kind, baseUrl, credential });
  }
  // Prowlarr shares the credential and the probe but none of the queue or grab
  // surface — it is an indexer manager, not a library manager.
  if (kind === 'prowlarr') {
    return new ProwlarrClient({ kind, baseUrl, credential });
  }
  return new ArrClient({ kind, baseUrl, credential });
}

/** Clients for every enabled instance, for the health poller's fan-out. */
export function enabledClients(): Array<{
  id: string;
  kind: InstanceKind;
  label: string;
  client: InstanceClient;
}> {
  return rows()
    .filter((row) => row.enabled === 1)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      client: buildClient(row.id, row.kind, row.base_url, parseCredential(row.credential)),
    }));
}

/**
 * One enabled instance's client, for an operation addressed at a single
 * instance — removal, principally. Returns null for a disabled instance as well
 * as a missing one: a disabled instance is one the operator has told us not to
 * contact, and a write is not an exception to that.
 */
export function clientFor(id: string): {
  id: string;
  kind: InstanceKind;
  label: string;
  client: InstanceClient;
} | null {
  const row = getRecord(id);
  if (!row || row.enabled !== 1) return null;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    client: buildClient(row.id, row.kind, row.base_url, row.parsed),
  };
}

export interface CreateInstanceInput {
  kind: InstanceKind;
  label: string;
  baseUrl: string;
  credential: Credential;
  enabled?: boolean;
}

export function assertCredentialMatchesKind(
  kind: InstanceKind,
  credential: Credential,
): void {
  const expected = CREDENTIAL_TYPE_BY_KIND[kind];
  if (credential.type !== expected) {
    throw new Error(`${kind} expects a ${expected} credential, got ${credential.type}`);
  }
}

export function createInstance(input: CreateInstanceInput): InstanceDto {
  assertCredentialMatchesKind(input.kind, input.credential);
  const now = new Date().toISOString();
  const id = randomUUID();

  getDb().prepare(`
    INSERT INTO instance
      (id, kind, label, base_url, credential, enabled, created_at, updated_at, last_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'untested')
  `).run(
    id,
    input.kind,
    input.label.trim(),
    input.baseUrl.trim().replace(/\/+$/, ''),
    serializeCredential(input.credential),
    input.enabled === false ? 0 : 1,
    now,
    now,
  );

  return getInstance(id)!;
}

export interface UpdateInstanceInput {
  label?: string;
  baseUrl?: string;
  credential?: Credential;
  enabled?: boolean;
}

export function updateInstance(id: string, input: UpdateInstanceInput): InstanceDto | null {
  const existing = getRecord(id);
  if (!existing) return null;

  if (input.credential) assertCredentialMatchesKind(existing.kind, input.credential);

  const next = {
    label: input.label?.trim() ?? existing.label,
    baseUrl: (input.baseUrl ?? existing.base_url).trim().replace(/\/+$/, ''),
    credential: input.credential
      ? serializeCredential(input.credential)
      : existing.credential,
    enabled: input.enabled === undefined ? existing.enabled : Number(input.enabled),
  };

  const connectionChanged = next.baseUrl !== existing.base_url
    || next.credential !== existing.credential;

  getDb().prepare(`
    UPDATE instance
       SET label = ?, base_url = ?, credential = ?, enabled = ?, updated_at = ?,
           last_status = CASE WHEN ? THEN 'untested' ELSE last_status END,
           last_version = CASE WHEN ? THEN NULL ELSE last_version END
     WHERE id = ?
  `).run(
    next.label,
    next.baseUrl,
    next.credential,
    next.enabled,
    new Date().toISOString(),
    connectionChanged ? 1 : 0,
    connectionChanged ? 1 : 0,
    id,
  );

  // A changed URL or credential invalidates everything cached against the old
  // one: the breaker's failure history and qBittorrent's session cookie.
  if (connectionChanged || next.enabled === 0) {
    disposeBreaker(id);
    clearSession(id);
  }

  return getInstance(id);
}

export function deleteInstance(id: string): boolean {
  disposeBreaker(id);
  clearSession(id);
  const result = getDb().prepare('DELETE FROM instance WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Written by the health poller after hysteresis has been applied. */
export function recordHealth(
  id: string,
  state: HealthState,
  version: string | null,
  latencyMs: number | null,
  reason: string | null,
): void {
  const db = getDb();
  const observedAt = new Date().toISOString();

  db.prepare(`
    UPDATE instance
       SET last_status = ?, last_checked_at = ?,
           last_version = COALESCE(?, last_version)
     WHERE id = ?
  `).run(state, observedAt, version, id);

  db.prepare(`
    INSERT INTO health_sample (instance_id, observed_at, status, latency_ms, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, observedAt, state, latencyMs, reason);

  // Retention: samples are for a short trend line in the UI, not an audit log.
  db.prepare(`
    DELETE FROM health_sample
     WHERE instance_id = ? AND observed_at < ?
  `).run(id, new Date(Date.now() - 24 * 60 * 60_000).toISOString());
}
