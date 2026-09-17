import 'server-only';

import { createHash } from 'node:crypto';

import type { EvaluatedRelease, GrabOutcome, ParsedTarget } from '@/lib/types';
import {
  countsAsBreakerFailure,
  isReleaseClient,
  type ClientResult,
  type ReleaseCandidate,
  type ReleaseClient,
} from '@/server/clients/types';
import { clientFor } from '@/server/instances/registry';
import { logger, registerSecret } from '@/server/logging/redact';
import { recordOperation } from '@/server/operations/log';
import { fireOn, isCircuitOpen } from '@/server/resilience/breaker';

/**
 * Grab orchestration — helparr's first write (FR7..FR9, REQ-OPS-001..007).
 *
 * Everything before the operator presses confirm is a GET. `resolveTarget` and
 * `evaluateRelease` are both read-only and both operator-triggered; only
 * `grab` sends anything, and it sends it exactly once.
 *
 * The three outcomes it has to keep apart:
 *   accepted  — the instance took the release
 *   rejected  — a successful request that produced a negative answer, whose
 *               reasons are the product and are never rewritten (FR9)
 *   failed    — the call itself broke
 *
 * All three produce exactly one operation row, written from the response.
 */

interface Destination {
  id: string;
  label: string;
  kind: string;
  client: ReleaseClient;
}

export type Refusal =
  /** No such instance, or the operator has it disabled. */
  | { kind: 'no-instance'; reason: string }
  /** Registered, but not something a release can be pushed into. */
  | { kind: 'not-grabbable'; reason: string }
  /** The result carried no usable link — refused explicitly, never silently. */
  | { kind: 'no-url'; reason: string };

export type Attempt<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

/**
 * A disabled instance is one the operator has told helparr not to contact, and
 * a write is not an exception to that — the same rule `clientFor` already
 * enforces for queue removals.
 */
function destination(instanceId: string): Attempt<Destination> {
  const entry = clientFor(instanceId);
  if (!entry) {
    return {
      ok: false,
      refusal: {
        kind: 'no-instance',
        reason: 'That instance is not registered, or it is disabled in Settings.',
      },
    };
  }
  if (!isReleaseClient(entry.client)) {
    return {
      ok: false,
      refusal: {
        kind: 'not-grabbable',
        reason: `${entry.label} is a ${entry.kind} — releases can only be grabbed into Sonarr or Radarr.`,
      },
    };
  }
  return {
    ok: true,
    value: { id: entry.id, label: entry.label, kind: entry.kind, client: entry.client },
  };
}

/** Runs one read through the destination's breaker, flattening every outcome. */
async function readThrough<T>(
  instanceId: string,
  operation: () => Promise<ClientResult<T>>,
): Promise<ClientResult<T>> {
  try {
    const outcome = await fireOn(instanceId, operation, { isFailure: countsAsBreakerFailure });
    if (isCircuitOpen(outcome)) {
      return { ok: false, error: { kind: 'unreachable', reason: outcome.reason } };
    }
    return outcome;
  } catch (error) {
    logger.warn('instance read threw', { instanceId, error });
    return { ok: false, error: { kind: 'upstream-error', reason: 'The read did not complete.' } };
  }
}

/* ── Resolve: what the destination makes of the release name (ADR-3) ──────── */

/**
 * `POST /api/v3/release/push` takes a **title**, not a target — the *arr
 * decides what the release is by parsing the name. So the confirmation asks the
 * destination first and names what *it* resolved, rather than echoing the
 * operator's own click back at them (REQ-OPS-007).
 *
 * A failure here is not a refusal to grab. The dialog degrades to the
 * unresolved branch, which is a designed state, not an error.
 */
export async function resolveTarget(
  instanceId: string,
  title: string,
  signal?: AbortSignal,
): Promise<Attempt<ParsedTarget>> {
  const dest = destination(instanceId);
  if (!dest.ok) return dest;

  const parsed = await readThrough(dest.value.id, () => dest.value.client.parse(title, signal));
  if (!parsed.ok) return { ok: true, value: UNRESOLVED_TARGET };
  return { ok: true, value: parsed.value };
}

/** The designed unresolved state — what a failed pre-flight degrades to. */
export const UNRESOLVED_TARGET: ParsedTarget = {
  resolved: false,
  seriesId: null,
  movieId: null,
  label: null,
  quality: null,
  releaseGroup: null,
  seasonNumber: null,
  fullSeason: false,
  isMultiSeason: false,
  episodeCount: 0,
};

/* ── Evaluate: the destination's own verdict, on request only (ADR-5) ─────── */

/**
 * Matched by `infoHash` first, then by exact title.
 *
 * When neither matches we report `matched: false` rather than inventing a
 * verdict — and that answer ("the instance's own search never returned this
 * release") is itself the thing the operator came for.
 */
function matchCandidate(
  candidates: ReleaseCandidate[],
  title: string,
  infoHash: string | null,
): ReleaseCandidate | null {
  if (infoHash) {
    const hash = infoHash.toLowerCase();
    const byHash = candidates.find((c) => c.infoHash?.toLowerCase() === hash);
    if (byHash) return byHash;
  }
  return candidates.find((c) => c.title === title) ?? null;
}

export async function evaluateRelease(
  instanceId: string,
  title: string,
  infoHash: string | null,
  signal?: AbortSignal,
): Promise<Attempt<EvaluatedRelease>> {
  const dest = destination(instanceId);
  if (!dest.ok) return dest;

  const parsed = await readThrough(dest.value.id, () => dest.value.client.parse(title, signal));
  if (!parsed.ok || (!parsed.value.seriesId && !parsed.value.movieId)) {
    // Nothing to search against. The instance cannot have an opinion about a
    // release it cannot place, which is exactly `matched: false`.
    return { ok: true, value: { matched: false, rejections: [] } };
  }

  const candidates = await readThrough(dest.value.id, () => dest.value.client.evaluate(
    { seriesId: parsed.value.seriesId, movieId: parsed.value.movieId },
    signal,
  ));
  if (!candidates.ok) return { ok: true, value: { matched: false, rejections: [] } };

  const match = matchCandidate(candidates.value, title, infoHash);
  return match
    ? { ok: true, value: { matched: true, rejections: match.rejections } }
    : { ok: true, value: { matched: false, rejections: [] } };
}

/* ── Grab: the write ─────────────────────────────────────────────────────── */

export interface GrabRequest {
  instanceId: string;
  title: string;
  downloadUrl: string;
  protocol: 'torrent' | 'usenet';
  publishDate: string;
  /** Originating indexer, by name — the log keeps no indexer id (ADR-2). */
  indexer: string | null;
  /** What the confirmation named, or null on the unresolved branch (ADR-3). */
  entityRef: string | null;
  /**
   * Which flow produced this write, for the operations log (ADR-7 of
   * `library-gaps-attach`). The two flows hit the same endpoint and differ only
   * in where the descriptor came from — a search result, or a link the operator
   * pasted against a known gap — so they share this function rather than
   * reimplementing redaction, breaker, logging and the no-retry rule twice.
   *
   * Defaults to `'grab'` so every existing caller is unchanged.
   */
  operationKind?: 'grab' | 'attach';
}

/**
 * The URL is reduced to a fingerprint before it can reach the log module
 * (REQ-OPS-004, ADR-7). Two rows for the same release still match on the
 * digest; the credential does not survive.
 */
function fingerprint(url: string): { urlSha256: string; urlHost: string | null } {
  const urlSha256 = createHash('sha256').update(url).digest('hex');
  try {
    // A magnet link has no host, which is a fact about the link rather than a
    // parse failure — `null` says so without pretending otherwise.
    const host = new URL(url).host;
    return { urlSha256, urlHost: host.length > 0 ? host : null };
  } catch {
    return { urlSha256, urlHost: null };
  }
}

function summaryFor(label: string, entityRef: string | null, verb: string): string {
  return entityRef
    ? `${verb} into ${label} — ${entityRef}`
    : `${verb} into ${label} — unresolved target`;
}

/** Past and present tense, so the summary reads as a sentence either way. */
const VERBS = {
  grab: { accepted: 'Grabbed', otherwise: 'Grab' },
  attach: { accepted: 'Attached', otherwise: 'Attach' },
} as const;

export async function grab(
  request: GrabRequest,
  signal?: AbortSignal,
): Promise<Attempt<GrabOutcome>> {
  const dest = destination(request.instanceId);
  if (!dest.ok) return dest;

  if (!request.downloadUrl) {
    return {
      ok: false,
      refusal: {
        kind: 'no-url',
        reason: 'That result carried no download link, so there is nothing to send.',
      },
    };
  }

  // Before the push, not after: the redactor has to know the value before any
  // request logging can emit it. The URL is proxied through Prowlarr and
  // carries Prowlarr's own API key — the credential to the whole application.
  registerSecret(request.downloadUrl);
  const { urlSha256, urlHost } = fingerprint(request.downloadUrl);

  // No retry. A push is not idempotent from the operator's point of view — if
  // it landed and the response was lost, a retry would grab twice.
  const pushed = await readThrough(dest.value.id, () => dest.value.client.pushRelease({
    title: request.title,
    downloadUrl: request.downloadUrl,
    protocol: request.protocol,
    publishDate: request.publishDate,
  }, signal));

  const accepted = pushed.ok && pushed.value.accepted;
  const rejected = pushed.ok && !pushed.value.accepted;
  const detail = pushed.ok ? pushed.value.rejections : [pushed.error.reason];

  const operationKind = request.operationKind ?? 'grab';
  const verbs = VERBS[operationKind];

  const row = recordOperation({
    kind: operationKind,
    summary: summaryFor(
      dest.value.label,
      request.entityRef,
      accepted ? verbs.accepted : verbs.otherwise,
    ),
    instanceId: dest.value.id,
    instanceLabel: dest.value.label,
    instanceKind: dest.value.kind,
    entityTitle: request.title,
    entityRef: request.entityRef,
    indexer: request.indexer,
    urlSha256,
    urlHost,
    // Two values, not three. A rejected grab is recorded as "failed" verbatim,
    // and `rejected` splits "your profile said no" from "radarr returned 502".
    outcome: accepted ? 'succeeded' : 'failed',
    rejected,
    detail,
  });

  return {
    ok: true,
    value: {
      status: accepted ? 'succeeded' : 'failed',
      rejected,
      // Verbatim. Not sentence-cased, not summarised, not deduplicated — the
      // reasons are the product (REQ-SEARCH-006, FR9).
      rejections: pushed.ok ? pushed.value.rejections : [],
      detail: pushed.ok ? null : pushed.error.reason,
      operationId: row.id,
      entityRef: request.entityRef,
    },
  };
}
