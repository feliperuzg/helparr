import type { HealthResponse, InstanceDto, InstanceKind, TestOutcome } from './types';

/**
 * Browser-side API client.
 *
 * Every call goes to helparr's own route handlers — never to an *arr instance
 * directly. That is the whole point of the BFF: the browser has no base URL and
 * no credential to leak (REQ-INST-005).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

async function request<T>(path: string, init?: RequestInit, bounceOn401 = true): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });

  if (response.status === 401 && bounceOn401 && typeof window !== 'undefined') {
    // The session expired underneath a long-lived tab. Bounce to login rather
    // than rendering a screen full of errors that look like instance failures.
    window.location.assign('/login');
    throw new ApiError(401, 'Session expired.');
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = (payload && typeof payload.error === 'string')
      ? payload.error
      : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message, payload?.reason);
  }

  return payload as T;
}

export type CredentialInput =
  | { type: 'api-key'; apiKey: string }
  | { type: 'userpass'; username: string; password: string };

export interface InstanceInput {
  kind: InstanceKind;
  label: string;
  baseUrl: string;
  credential: CredentialInput;
  enabled?: boolean;
  testToken?: string;
}

export const api = {
  listInstances: () =>
    request<{ instances: InstanceDto[] }>('/api/instances').then((r) => r.instances),

  health: () => request<HealthResponse>('/api/health'),

  testConnection: (body: { kind: InstanceKind; baseUrl: string; credential: CredentialInput }) =>
    request<TestOutcome>('/api/instances/test', { method: 'POST', body: JSON.stringify(body) }),

  createInstance: (body: InstanceInput) =>
    request<{ instance: InstanceDto }>('/api/instances', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => r.instance),

  updateInstance: (id: string, body: Partial<Omit<InstanceInput, 'kind'>>) =>
    request<{ instance: InstanceDto }>(`/api/instances/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .then((r) => r.instance),

  deleteInstance: (id: string) =>
    request<void>(`/api/instances/${id}`, { method: 'DELETE' }),

  // The auth endpoints opt out of the bounce. A 401 here means "that password
  // is wrong", not "your session lapsed" — redirecting to /login would reload
  // the page the operator is already on and throw away the only explanation
  // they were going to get.
  login: (password: string) =>
    request<void>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }, false),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }, false),
};
