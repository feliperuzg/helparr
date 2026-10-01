/**
 * Shared, client-safe shapes for the decision comparison panel (ADR-10,
 * ADR-12, ADR-14; REQ-DEC-001..008). New file rather than an addition to
 * `types.ts` (ADR-14) so this task and the others touching `types.ts` in the
 * same change never collide on one file.
 *
 * Nothing here imports from `@/server/*` — this module is read by both
 * `src/server/decisions/explain.ts` and, eventually, the client components
 * `DecisionExplainer` (T18) renders from.
 */

/** One custom format's contribution to a side's total. */
export interface FormatScoreLine {
  formatId: number;
  name: string;
  /**
   * `null` means this format is not in the target quality profile's
   * `formatItems` — it contributes nothing toward the profile's threshold,
   * and the panel says so rather than rendering a scored zero (REQ-DEC-002,
   * REQ-DEC-005: "no empty or placeholder comparison" cuts the other way too —
   * a false zero is its own kind of placeholder).
   */
  score: number | null;
}

/**
 * One side of the comparison — the candidate release, or the file currently
 * on disk (REQ-DEC-002).
 */
export interface DecisionSide {
  label: 'candidate' | 'existing';
  /**
   * `false` is the "no file on disk" case (ADR-12, REQ-DEC-002's "No file on
   * disk" scenario): the side still renders, naming the absence, and never a
   * score of 0 standing in for it.
   */
  present: boolean;
  quality: string | null;
  formats: FormatScoreLine[];
  /** helparr's own arithmetic over the profile's `formatItems` (ADR-10). */
  helparrSum: number | null;
  /** The instance's own `customFormatScore` — authoritative on disagreement. */
  reportedScore: number | null;
  /** `null` when either side's total is unknown — never a false match. */
  sumMatches: boolean | null;
  /** Which string the score was computed from (ADR-12, REQ-DEC-004). */
  scoreSource: 'releaseName' | 'filename' | 'unknown';
}

export interface DecisionComparison {
  instanceId: string;
  profile: {
    id: number;
    name: string;
    cutoff: string | null;
    minFormatScore: number;
    cutoffFormatScore: number;
    upgradeAllowed: boolean;
  } | null;
  candidate: DecisionSide;
  existing: DecisionSide;
  /**
   * Verbatim from the instance (REQ-DEC-001). The comparison supplements
   * this; it never replaces or rewrites it.
   */
  rejections: string[];
  verdict: Verdict;
  /** ISO — the age of the cached config this comparison was built from (ADR-11). */
  configFetchedAt: string;
}

/**
 * REQ-DEC's own taxonomy for what the comparison concludes, distinct from
 * `ReleaseInspector`'s local `Verdict` component (`matched` / `rejections`),
 * which only answers "did the instance's own search return this release" —
 * a narrower question than "what will the instance do with this file now".
 * ADR-14 names `Verdict` as a piece T18 extracts from that component; this is
 * the data shape it extracts *onto*, not a second, competing one — T18
 * should wire its presentational component to render this `Verdict`, not
 * invent a third taxonomy.
 */
export type VerdictKind = 'upgrade' | 'not-upgrade' | 'rejected' | 'no-existing' | 'unknown';

export interface Verdict {
  kind: VerdictKind;
  reason: string;
}

/* ── Candidate and target (client-safe mirrors) ───────────────────────── */

export interface DecisionQualityModel {
  quality: { id: number; name: string; source?: string; resolution?: number };
  revision: { version: number; real: number; isRepack: boolean };
}

export interface DecisionCustomFormatRef {
  id: number;
  name: string;
}

/**
 * A pure, client-safe mirror of `ReleaseCandidate` (`src/server/clients/types.ts`),
 * field for field. Not imported directly: that module (and `src/server/decisions/
 * explain.ts`, which defines the failure shapes below) pulls in `server-only`,
 * which a browser bundle must never see — the same reason this file,
 * `importPlan.ts` and `unmapped.ts` exist as their own client-safe files.
 */
export interface DecisionCandidate {
  title: string;
  infoHash: string | null;
  guid: string | null;
  rejections: string[];
  quality: DecisionQualityModel | null;
  customFormats: DecisionCustomFormatRef[];
  customFormatScore: number | null;
  episodeIds: number[];
  movieId: number | null;
  indexer: string | null;
}

/** The item a candidate would land on — `ExplainInput` without the instance and candidate. */
export interface DecisionTarget {
  episodeId?: number;
  movieId?: number;
  /** `null` means the item has no file on disk at all — not that the read failed. */
  fileId: number | null;
  /** The quality profile governing the item — its thresholds are what the verdict is checked against. */
  profileId: number;
}
