/**
 * Types shared between server and client.
 *
 * This module is imported by client components, so it must never describe a
 * credential. `InstanceDto` has no credential field at all — not an optional
 * one, not a nullable one. A field that does not exist cannot be accidentally
 * populated by a careless `SELECT *` (REQ-INST-005 / AC6).
 */

export const INSTANCE_KINDS = ['sonarr', 'radarr', 'prowlarr', 'download-client'] as const;
export type InstanceKind = (typeof INSTANCE_KINDS)[number];

/** States from `design/state-instance-health.md`. */
export const HEALTH_STATES = [
  'untested',
  'ok',
  'degraded',
  'unreachable',
  'unauthorized',
  'disabled',
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface InstanceDto {
  id: string;
  kind: InstanceKind;
  label: string;
  baseUrl: string;
  enabled: boolean;
  /** How the credential is supplied — never the credential itself. */
  credentialType: 'api-key' | 'userpass';
  /** Non-reversible display form, e.g. `••••••••3f2a`. */
  credentialHint: string;
  status: HealthState;
  version: string | null;
  lastCheckedAt: string | null;
}

export interface InstanceHealthDto {
  instanceId: string;
  kind: InstanceKind;
  label: string;
  state: HealthState;
  latencyMs: number | null;
  version: string | null;
  /** Operator-facing explanation; present whenever state is not `ok`. */
  reason: string | null;
  /** When the breaker is open, the wall-clock time the next probe is allowed. */
  retryAt: string | null;
  observedAt: string;
}

export interface HealthResponse {
  instances: InstanceHealthDto[];
  /** Count of enabled instances not in `ok` — drives the shell badge. */
  degradedCount: number;
}

/**
 * The four outcomes of a connection test (REQ-INST-003). They are discriminated
 * rather than collapsed into ok/failed because the operator's next action
 * differs for each: fix the URL, paste a new key, start the service, or check
 * the reverse proxy.
 */
export type TestOutcome =
  | { outcome: 'ok'; version: string; latencyMs: number; testToken: string }
  | { outcome: 'unauthorized'; reason: string }
  | { outcome: 'unreachable'; reason: string }
  | { outcome: 'unexpected-response'; reason: string };

export const CREDENTIAL_TYPE_BY_KIND: Record<InstanceKind, 'api-key' | 'userpass'> = {
  sonarr: 'api-key',
  radarr: 'api-key',
  prowlarr: 'api-key',
  'download-client': 'userpass',
};

export const KIND_LABEL: Record<InstanceKind, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  prowlarr: 'Prowlarr',
  'download-client': 'qBittorrent',
};
