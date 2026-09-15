import type {
  HealthResponse,
  InstanceDto,
  InstanceKind,
  QueueResponse,
  RemovalOutcome,
  RemovalRequest,
  TestOutcome,
} from './types';

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
    //
    // A hard navigation is the point, so Next 16's preference for
    // `useRouter().push()` does not apply here twice over: this is a plain
    // module with no hooks available, and a soft navigation would preserve the
    // TanStack Query cache — which still holds instance data fetched under the
    // session that just died. Reloading the document is what discards it.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
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

  queue: (signal?: AbortSignal) => request<QueueResponse>('/api/queue', { signal }),

  // Every flag is spelled out on the wire. The route rejects an omitted one
  // rather than defaulting it, so the type being required here is the same rule
  // enforced twice — once where it is easy to catch, once where it matters.
  removeQueueItem: (instanceId: string, recordId: number, flags: RemovalRequest) =>
    request<RemovalOutcome>(
      `/api/queue/${encodeURIComponent(instanceId)}/${recordId}`
        + `?removeFromClient=${flags.removeFromClient}`
        + `&blocklist=${flags.blocklist}`
        + `&skipRedownload=${flags.skipRedownload}`,
      { method: 'DELETE' },
    ),

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

  /** Collapses an open breaker's reset window so the next read gets through. */
  retryInstance: (id: string) =>
    request<void>(`/api/instances/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  // The auth endpoints opt out of the bounce. A 401 here means "that password
  // is wrong", not "your session lapsed" — redirecting to /login would reload
  // the page the operator is already on and throw away the only explanation
  // they were going to get.
  login: (password: string) =>
    request<void>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }, false),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }, false),
};
