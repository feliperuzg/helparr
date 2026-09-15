import 'server-only';

import {
  classifyNetworkError,
  type ClientFailure,
  type ClientResult,
} from './types';

/**
 * Shared request discipline for queue reads and removals (REQ-QUEUE-010, T4).
 *
 * Exactly one retry, jittered, and only for failures that a retry can plausibly
 * fix. The asymmetry is the point: a 500 is often a restarting upstream and
 * worth one more attempt; a 401 is a rejected credential and retrying it just
 * doubles the failed-login noise in someone's log — with a download client that
 * can mean a temporary IP ban.
 */

const RETRY_BASE_MS = 250;

/** Full jitter over the base: instances that fail in the same instant must not
 *  retry in the same instant, which is how a shared NAS outage turns into a
 *  synchronised thundering herd on recovery. */
function retryDelay(): number {
  return Math.round(RETRY_BASE_MS * (0.5 + Math.random()));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function attempt(url: string, init: RequestInit): Promise<ClientResult<Response>> {
  try {
    return { ok: true, value: await fetch(url, { ...init, cache: 'no-store' }) };
  } catch (error) {
    return { ok: false, error: classifyNetworkError(error) };
  }
}

function worthRetrying(result: ClientResult<Response>): boolean {
  if (result.ok) return result.value.status >= 500;
  // A timeout is excluded deliberately. It means the deadline for this instance
  // is already spent, so a second attempt would push the fan-out past the budget
  // that exists to stop one slow instance holding the whole screen.
  return result.error.kind !== 'timeout';
}

/**
 * One request, retried at most once. `signal` is the caller's deadline — when it
 * has fired, the retry is skipped rather than queued behind an already-dead
 * budget.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<ClientResult<Response>> {
  const first = await attempt(url, init);
  if (!worthRetrying(first) || signal?.aborted) return first;

  // Drain the discarded response. An undrained body keeps its socket checked out
  // of the pool, and the leak only shows up under sustained polling.
  if (first.ok) await first.value.body?.cancel().catch(() => {});

  await sleep(retryDelay(), signal);
  if (signal?.aborted) return first;

  return attempt(url, init);
}

/** Maps a non-2xx response onto the closed error union the banner reads. */
export function classifyResponse(response: Response, context: string): ClientFailure {
  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'unauthorized',
      reason: `${context} rejected the credential (HTTP ${response.status}).`,
    };
  }
  if (response.status === 404) {
    return {
      kind: 'upstream-error',
      reason: `${context} answered but the endpoint does not exist (HTTP 404). `
        + 'Check the base URL — a URL base or reverse-proxy prefix is a common cause.',
    };
  }
  return {
    kind: 'upstream-error',
    reason: `${context} returned HTTP ${response.status}.`,
  };
}

/** A body that did not parse as JSON is the reverse-proxy login page again. */
export async function readJson(
  response: Response,
  context: string,
): Promise<ClientResult<unknown>> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return {
      ok: false,
      error: {
        kind: 'upstream-error',
        reason: `${context} answered but the response was not JSON — something is intercepting the request.`,
      },
    };
  }
}
