import 'server-only';

import type {
  DecisionCandidate as ClientDecisionCandidate,
  ExplainFailureKind as ClientExplainFailureKind,
  ImportCandidateExplanation as ClientImportCandidateExplanation,
} from '@/lib/api';
import type {
  DecisionComparison,
  DecisionSide,
  FormatScoreLine,
  Verdict,
} from '@/lib/decisions';
import { isImportClient } from '@/server/clients/types';
import type {
  ArrCustomFormatRef,
  ArrExistingFile,
  ArrQualityModel,
  ArrQualityProfileDetail,
  ReleaseCandidate,
} from '@/server/clients/types';
import {
  getDecisionsConfig,
  readThroughDecisions,
  resolveDecisionsClient,
  type DecisionsFailureKind,
  type DecisionsResult,
} from './configCache';

/**
 * The explainer (ADR-10, ADR-12, ADR-13; REQ-DEC-001..008).
 *
 * `buildComparison` is pure — no cache read, no instance call — so it is the
 * one piece of this capability `test/decisions.test.ts` (T24) can exercise
 * without `fakeArr`. Everything that touches the network lives in
 * `explainCandidate` and `evaluateReleases`, which assemble its inputs and
 * nothing else.
 */

export interface BuildComparisonInput {
  instanceId: string;
  candidate: ReleaseCandidate;
  /** `null` is the real "no file on disk" case, not a failed read (ADR-12). */
  existing: ArrExistingFile | null;
  /** `null` when the target profile could not be resolved — degrades the thresholds, not the two sides. */
  profile: ArrQualityProfileDetail | null;
  /** The instance's custom-format catalog, for naming a format id neither side's own list names. */
  customFormats: ArrCustomFormatRef[];
  /** ISO — propagated onto the comparison's `configFetchedAt` (ADR-11). */
  fetchedAt: string;
  /**
   * Where the candidate's own score came from (ADR-12): a release name for
   * search and gap results, the file name for an import candidate.
   */
  candidateScoreSource?: DecisionSide['scoreSource'];
}

function qualityName(quality: ArrQualityModel | null): string | null {
  return quality?.quality.name ?? null;
}

/**
 * Names a format id by the most specific source available: the profile's own
 * `formatItems` (ADR-10's join), then the side's own ref, then the instance's
 * catalog. All three *should* agree; this only matters when one of them is
 * missing the id.
 */
function resolveName(
  formatId: number,
  ownName: string,
  profile: ArrQualityProfileDetail | null,
  catalogById: Map<number, string>,
): string {
  const fromProfile = profile?.formatItems.find((item) => item.format === formatId)?.name;
  // `||` for the ref: an upstream that sends an empty name has not named it.
  return fromProfile ?? (ownName || null) ?? catalogById.get(formatId) ?? `Format ${formatId}`;
}

function scoreFor(formatId: number, profile: ArrQualityProfileDetail | null): number | null {
  const item = profile?.formatItems.find((entry) => entry.format === formatId);
  return item ? item.score : null;
}

function buildSide(
  label: DecisionSide['label'],
  present: boolean,
  quality: string | null,
  formatRefs: ArrCustomFormatRef[],
  reportedScore: number | null,
  scoreSource: DecisionSide['scoreSource'],
  profile: ArrQualityProfileDetail | null,
  catalogById: Map<number, string>,
): DecisionSide {
  const formats: FormatScoreLine[] = formatRefs.map((ref) => ({
    formatId: ref.id,
    name: resolveName(ref.id, ref.name, profile, catalogById),
    score: scoreFor(ref.id, profile),
  }));

  // Only computable once a profile is known to score against — a null profile
  // means there is nothing to sum, not a sum of zero (REQ-DEC-002, ADR-10).
  const helparrSum = present && profile
    ? formats.reduce((total, line) => total + (line.score ?? 0), 0)
    : null;

  const sumMatches = helparrSum !== null && reportedScore !== null
    ? helparrSum === reportedScore
    : null;

  return {
    label,
    present,
    quality,
    formats,
    helparrSum,
    reportedScore,
    sumMatches,
    scoreSource: present ? scoreSource : 'unknown',
  };
}

/**
 * The verdict (REQ-DEC-001, -003): what the comparison concludes, printed
 * beside — never instead of — the verbatim rejection reasons.
 */
function deriveVerdict(
  candidate: DecisionSide,
  existing: DecisionSide,
  profile: DecisionComparison['profile'],
  rejections: string[],
): Verdict {
  // The instance's own refusal outranks everything helparr can work out: a
  // rejected candidate is rejected whether or not a file exists to compare.
  if (rejections.length > 0) {
    return {
      kind: 'rejected',
      reason: `${rejections.length} reason${rejections.length === 1 ? '' : 's'} given by the instance — see the verbatim text above.`,
    };
  }

  if (!existing.present) {
    return {
      kind: 'no-existing',
      reason: 'There is no existing file to compare this candidate against.',
    };
  }

  if (profile && !profile.upgradeAllowed) {
    return {
      kind: 'not-upgrade',
      reason: `The profile "${profile.name}" does not allow upgrades.`,
    };
  }

  if (
    profile
    && candidate.reportedScore !== null
    && existing.reportedScore !== null
  ) {
    const clearsFloor = candidate.reportedScore >= profile.minFormatScore;
    const beatsExisting = candidate.reportedScore > existing.reportedScore;
    return beatsExisting && clearsFloor
      ? {
        kind: 'upgrade',
        reason: `${candidate.reportedScore} beats the existing file's ${existing.reportedScore} and clears the profile's minimum of ${profile.minFormatScore}.`,
      }
      : {
        kind: 'not-upgrade',
        reason: beatsExisting
          ? `${candidate.reportedScore} beats the existing file's ${existing.reportedScore}, but is below the profile's minimum of ${profile.minFormatScore}.`
          : `${candidate.reportedScore} does not beat the existing file's ${existing.reportedScore}.`,
      };
  }

  return {
    kind: 'unknown',
    reason: 'Not enough information was read to compare the two scores.',
  };
}

export function buildComparison(input: BuildComparisonInput): DecisionComparison {
  const {
    instanceId,
    candidate,
    existing,
    profile,
    customFormats,
    fetchedAt,
    candidateScoreSource = 'releaseName',
  } = input;
  const catalogById = new Map(customFormats.map((format) => [format.id, format.name]));

  // A release is evaluated from its own name and an import candidate from its
  // file name (ADR-12); the caller says which, defaulting to the release.
  const candidateSide = buildSide(
    'candidate',
    true,
    qualityName(candidate.quality),
    candidate.customFormats,
    candidate.customFormatScore,
    candidateScoreSource,
    profile,
    catalogById,
  );

  const existingSide = buildSide(
    'existing',
    existing !== null,
    existing ? qualityName(existing.quality) : null,
    existing?.customFormats ?? [],
    existing?.customFormatScore ?? null,
    // `sceneName` present means the instance's own score came from a release
    // name baked into the file, not the filename on disk (ADR-12).
    existing?.sceneName != null ? 'releaseName' : 'filename',
    profile,
    catalogById,
  );

  const profileSummary = profile
    ? {
      id: profile.id,
      name: profile.name,
      cutoff: profile.cutoffName,
      minFormatScore: profile.minFormatScore,
      cutoffFormatScore: profile.cutoffFormatScore,
      upgradeAllowed: profile.upgradeAllowed,
    }
    : null;

  return {
    instanceId,
    profile: profileSummary,
    candidate: candidateSide,
    existing: existingSide,
    // Verbatim, never summarised (REQ-SEARCH-006's rule, restated here as
    // REQ-DEC-001): the comparison supplements this, it does not replace it.
    rejections: candidate.rejections,
    verdict: deriveVerdict(candidateSide, existingSide, profileSummary, candidate.rejections),
    configFetchedAt: fetchedAt,
  };
}

/* ── Orchestration: config cache + one file read + the pure join ─────────── */

export interface ExplainTarget {
  episodeId?: number;
  movieId?: number;
  /** `null` means the target has no file at all — never read, never 404'd. */
  fileId: number | null;
  /** `null` when the instance reported no profile — the thresholds degrade, the two sides still render. */
  profileId: number | null;
  candidate: ReleaseCandidate;
  candidateScoreSource?: DecisionSide['scoreSource'];
}

/**
 * The explainer's own failure shape, distinct from `DecisionsResult`'s: a
 * degraded explanation still carries the candidate's verbatim rejections
 * (REQ-DEC-008 — "the verbatim rejection reason SHALL still be displayed"),
 * so the caller never has to go back to the candidate to recover them.
 */
export interface ExplainFailure {
  kind: DecisionsFailureKind | 'config-unavailable' | 'existing-file-unavailable';
  /** Names the instance and what could not be read (REQ-DEC-008). */
  reason: string;
  rejections: string[];
}

export type ExplainResult =
  | { ok: true; value: DecisionComparison }
  | { ok: false; error: ExplainFailure };

/**
 * One candidate against one instance's config and one on-disk file — read on
 * demand, never per row (NFR2). Config comes from the shared cache
 * (`configCache.ts`); the file read is the one request this costs beyond that,
 * and only when the target actually has a file to read.
 */
export async function explainCandidate(
  instanceId: string,
  target: ExplainTarget,
  signal?: AbortSignal,
): Promise<ExplainResult> {
  const resolved = resolveDecisionsClient(instanceId);
  if (!resolved.ok) {
    return {
      ok: false,
      error: { kind: resolved.error.kind, reason: resolved.error.reason, rejections: target.candidate.rejections },
    };
  }

  const config = await getDecisionsConfig(instanceId, {}, signal);
  if (!config.ok) {
    return {
      ok: false,
      error: {
        kind: 'config-unavailable',
        reason: `${resolved.value.label}: custom formats and quality profiles could not be read (${config.error.reason})`,
        rejections: target.candidate.rejections,
      },
    };
  }

  let existing: ArrExistingFile | null = null;
  if (target.fileId !== null) {
    const file = await readThroughDecisions(
      instanceId,
      (s) => resolved.value.client.existingFile(target.fileId as number, s),
      signal,
    );
    if (!file.ok) {
      return {
        ok: false,
        error: {
          kind: 'existing-file-unavailable',
          reason: `${resolved.value.label}: the existing file could not be read (${file.error.reason})`,
          rejections: target.candidate.rejections,
        },
      };
    }
    // `null` here is the client's own 404 — a confirmed absence, not a failure.
    existing = file.value;
  }

  const profile = config.value.profiles.find((p) => p.id === target.profileId) ?? null;

  return {
    ok: true,
    value: buildComparison({
      instanceId,
      candidate: target.candidate,
      existing,
      profile,
      customFormats: config.value.customFormats,
      fetchedAt: config.value.fetchedAt,
      candidateScoreSource: target.candidateScoreSource,
    }),
  };
}

export type EvaluateReleasesResult = DecisionsResult<ReleaseCandidate[]>;

/**
 * Gaps' "Evaluate releases" (ADR-13) — the instance's own interactive search
 * for one item, run only when the operator presses the button. Nothing here
 * runs on open; the quota warning lives in the UI that calls this (T20).
 */
export async function evaluateReleases(
  instanceId: string,
  target: { episodeId?: number; movieId?: number },
  signal?: AbortSignal,
): Promise<EvaluateReleasesResult> {
  const resolved = resolveDecisionsClient(instanceId);
  if (!resolved.ok) return resolved;

  return readThroughDecisions(
    instanceId,
    (s) => resolved.value.client.releasesForItem(target, s),
    signal,
  );
}

/* ── Queue: explain a download's own rejected import candidates (FR17) ──── */

export interface ImportCandidateExplanation {
  path: string;
  /** The file name the instance scored, as it reported it. */
  name: string;
  result: ExplainResult;
}

/**
 * The queue's `import-rejected` cause explained file by file: each
 * `manualimport?downloadId=` candidate the instance rejected, against the file
 * it would replace. Read only when the operator asks — one candidate read,
 * then the same config cache and file read as `explainCandidate`.
 */
export async function explainImportCandidates(
  instanceId: string,
  downloadId: string,
  signal?: AbortSignal,
): Promise<DecisionsResult<ImportCandidateExplanation[]>> {
  const resolved = resolveDecisionsClient(instanceId);
  if (!resolved.ok) return resolved;
  const { client, label } = resolved.value;
  if (!isImportClient(client)) {
    return {
      ok: false,
      error: { kind: 'not-decisions-client', reason: `${label} has no import candidates to read.` },
    };
  }

  const candidates = await readThroughDecisions(
    instanceId,
    (s) => client.manualImportCandidates(downloadId, s),
    signal,
  );
  if (!candidates.ok) return candidates;

  const rejected = candidates.value.filter((candidate) => candidate.rejections.length > 0);
  const explanations = await Promise.all(rejected.map(async (candidate) => {
    const name = candidate.relativePath ?? candidate.name ?? candidate.path;
    const episode = candidate.episodes.find((entry) => entry.hasFile && entry.episodeFileId !== null)
      ?? candidate.episodes[0];
    const fileId = candidate.movie
      ? (candidate.movie.hasFile ? candidate.movie.movieFileId : null)
      : (episode?.hasFile ? episode.episodeFileId : null);

    const result = await explainCandidate(instanceId, {
      ...(candidate.movieId !== null ? { movieId: candidate.movieId } : {}),
      ...(episode ? { episodeId: episode.id } : {}),
      fileId,
      profileId: candidate.qualityProfileId,
      candidateScoreSource: 'filename',
      candidate: {
        title: name,
        infoHash: null,
        guid: null,
        rejections: candidate.rejections,
        quality: candidate.quality,
        customFormats: candidate.customFormats,
        customFormatScore: candidate.customFormatScore,
        episodeIds: candidate.episodes.map((entry) => entry.id),
        movieId: candidate.movieId,
        indexer: null,
      },
    }, signal);

    return { path: candidate.path, name, result };
  }));

  return { ok: true, value: explanations };
}

/* ── Drift guard for the client's mirrors in `src/lib/api.ts` ───────────── */

// The client cannot import these types (this module is `server-only`), so
// `api.ts` restates them. These assertions fail to compile the moment either
// side gains a field or a failure kind the other does not have.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const candidateMirror: Same<ReleaseCandidate, ClientDecisionCandidate> = true;
const failureMirror: Same<ExplainFailure['kind'], ClientExplainFailureKind> = true;
void candidateMirror;
void failureMirror;
const importMirror: Same<ImportCandidateExplanation, ClientImportCandidateExplanation> = true;
void importMirror;
