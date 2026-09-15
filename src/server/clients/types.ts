import 'server-only';

import type { InstanceKind } from '@/lib/types';
import type { Credential } from '@/server/instances/credential';

/**
 * The shared shape of a per-instance client.
 *
 * Two implementations exist and they are genuinely different animals:
 * `ArrClient` is stateless and authenticates with a header; `QbitClient` holds
 * a session cookie and must re-login when it expires. Forcing them into one
 * class would produce a union of every special case in both, so the shared
 * surface is deliberately narrow — the two operations the registry and the
 * health poller actually need.
 */

/**
 * A probe never throws for an expected upstream condition. Callers fan out with
 * `Promise.allSettled` and need a complete per-instance picture; an exception
 * for "the host is down" would make the common case the error path.
 */
export type ProbeResult =
  | { state: 'ok'; version: string; latencyMs: number }
  | { state: 'unauthorized'; reason: string }
  | { state: 'unreachable'; reason: string }
  | { state: 'degraded'; reason: string };

export interface InstanceClient {
  readonly kind: InstanceKind;
  readonly baseUrl: string;

  /** Liveness plus credential validity plus the upstream version string. */
  probe(signal?: AbortSignal): Promise<ProbeResult>;
}

export interface ClientConfig {
  kind: InstanceKind;
  baseUrl: string;
  credential: Credential;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Normalizes an operator-entered base URL. Trailing slashes are stripped so
 * path joining never produces a double slash, which some reverse proxies treat
 * as a distinct (and 404-ing) path.
 */
export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connection refused — the host is reachable but nothing is listening on that port.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host not found — DNS could not resolve the base URL.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable — check the address and the network route.';
    case 'ECONNRESET':
      return 'Connection reset by the upstream before a response was returned.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'TLS certificate rejected — use http:// on the LAN or install the certificate.';
    default:
      break;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Timed out waiting for a response.';
  }
  return error instanceof Error ? error.message : 'Unknown network error.';
}
