import type {
  RenameApplySummary, RenamePlanDto, RenamePlanRow, RenameWarning,
} from '@/lib/types';
import type { Tone } from '@/components/ui';
import type { IconName } from '@/components/Icon';

/**
 * The bulk-rename screen's pure layer (T12, T13, T14).
 *
 * Everything here is a function of the plan as the server returned it. Nothing
 * derives a count from a command's self-report, and nothing invents a state a
 * row has not actually reached — the two ways a rename screen lies (ADR-7,
 * FR12, FR13).
 */

/* ── Path diffing (FR3, NFR6) ─────────────────────────────────────────────── */

/** The unchanged lead, the span that differs, and the unchanged trail. */
export interface Span {
  lead: string;
  changed: string;
  trail: string;
}

export interface PathDiff {
  fromDir: string;
  toDir: string;
  /** True when this row is a *move*: the destination directory is a different one. */
  dirChanged: boolean;
  /** Directory strings split at the first difference, for the folder channel. */
  fromDirSpan: Span;
  toDirSpan: Span;
  fromBase: string;
  toBase: string;
  fromBaseSpan: Span;
  toBaseSpan: Span;
}

/** Splits on either separator — Windows hosts report backslashes. */
export function splitPath(path: string): { dir: string; base: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (at < 0) return { dir: '', base: path };
  return { dir: path.slice(0, at), base: path.slice(at + 1) };
}

/**
 * The narrowest span that covers the difference — common prefix and common
 * suffix trimmed off both sides.
 *
 * Two identical strings produce an empty `changed`, which is what lets the
 * renderer say "this half did not move" rather than bracketing the whole thing.
 */
export function spanOf(from: string, to: string): { from: Span; to: Span } {
  if (from === to) {
    return {
      from: { lead: from, changed: '', trail: '' },
      to: { lead: to, changed: '', trail: '' },
    };
  }

  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start += 1;

  let end = 0;
  while (
    end < from.length - start
    && end < to.length - start
    && from[from.length - 1 - end] === to[to.length - 1 - end]
  ) end += 1;

  return {
    from: {
      lead: from.slice(0, start),
      changed: from.slice(start, from.length - end),
      trail: from.slice(from.length - end),
    },
    to: {
      lead: to.slice(0, start),
      changed: to.slice(start, to.length - end),
      trail: to.slice(to.length - end),
    },
  };
}

export function diffPath(existingPath: string, proposedPath: string): PathDiff {
  const from = splitPath(existingPath);
  const to = splitPath(proposedPath);
  const dirSpan = spanOf(from.dir, to.dir);
  const baseSpan = spanOf(from.base, to.base);

  return {
    fromDir: from.dir,
    toDir: to.dir,
    dirChanged: from.dir !== to.dir,
    fromDirSpan: dirSpan.from,
    toDirSpan: dirSpan.to,
    fromBase: from.base,
    toBase: to.base,
    fromBaseSpan: baseSpan.from,
    toBaseSpan: baseSpan.to,
  };
}

/* ── Warnings (FR6, ADR-9) ────────────────────────────────────────────────── */

/**
 * The wording for helparr's own derived warnings.
 *
 * ADR-9 is load-bearing in this table: the spike printed the full key union of
 * every preview row on both backends and found **no warning field**. Every
 * sentence below is therefore helparr asserting something the instance did not
 * say, and none of them may read as relayed upstream text — a derived warning
 * that is wrong is helparr's bug, and the operator has to know whom to doubt.
 */
export const WARNING_COPY: Record<RenameWarning, {
  /** The badge. Short enough for a dense row. */
  label: string;
  /** One clause, for the plan-level callout. */
  summary: string;
  /** The inspector's full explanation. */
  detail: string;
}> = {
  'moves-directory': {
    label: 'Moves folder',
    summary: 'changes which folder the file lives in — a move, not just a rename',
    detail:
      'The proposed path is in a different folder from the one this file is in now, so '
      + 'applying moves the file as well as renaming it. The folder it leaves is not '
      + 'removed and may be left empty. helparr derived this by comparing the two paths '
      + 'in this plan — neither Sonarr nor Radarr reports a warning of its own.',
  },
  'destination-collision': {
    label: 'Two rows, one destination',
    summary: 'shares its destination path with another row in this plan',
    detail:
      'Another row in this plan resolves to exactly this destination path. Whichever '
      + 'one is written second cannot land there as well, so one of the two files is '
      + 'lost or left where it is. helparr derived this by comparing this plan’s own '
      + 'rows against each other.',
  },
  'destination-exists': {
    label: 'Destination occupied',
    summary: 'has a file already sitting at its destination path',
    detail:
      'Something already occupies the destination path, and it is not a file in this '
      + 'plan. The rename will silently do nothing: measured against a live instance on '
      + '2026-09-17, Sonarr accepted the command, reported it completed and successful, '
      + 'and renamed no file at all. helparr derived this by asking the instance what is '
      + 'on disk; the instance raises no warning about it.',
  },
  'multi-episode': {
    label: 'Multi-episode file',
    summary: 'is one file covering more than one episode',
    detail:
      'This single file covers more than one episode, so one proposed name has to stand '
      + 'for all of them. Sonarr only — Radarr has no multi-episode equivalent, so a film '
      + 'never carries this flag. helparr derived it from the episode numbers on the row.',
  },
};

/** Rows the operator would actually send — exclusions already removed (FR7). */
export function includedRows(rows: RenamePlanRow[]): RenamePlanRow[] {
  return rows.filter((row) => !row.excluded);
}

/** How many of the rows that would be sent carry at least one derived warning. */
export function warningCount(rows: RenamePlanRow[]): number {
  return includedRows(rows).filter((row) => row.warnings.length > 0).length;
}

/** Every warning kind present among the rows that would be sent, in table order. */
export function warningKinds(rows: RenamePlanRow[]): RenameWarning[] {
  const present = new Set<RenameWarning>();
  includedRows(rows).forEach((row) => row.warnings.forEach((warning) => present.add(warning)));
  return (Object.keys(WARNING_COPY) as RenameWarning[]).filter((kind) => present.has(kind));
}

/* ── Per-row status (FR8, FR12) ───────────────────────────────────────────── */

export type GridMode = 'preview' | 'expired' | 'applying' | 'done';

export interface RowStatus {
  label: string;
  tone: Tone;
  icon: IconName;
  /** Spoken in full, because the badge word alone is an abbreviation of it. */
  spoken: string;
}

/**
 * What a row's status cell says, and it never says `renamed` before the upstream
 * result for that row has landed (FR12, DESIGN.md §7's last "Don't").
 *
 * `applying` deliberately has no optimistic value: a row whose outcome is still
 * `pending` reads as *waiting*, which is the true statement — helparr has
 * dispatched the command but has not yet observed what it did (ADR-7 verifies by
 * re-running the preview, so an outcome only exists once that returns).
 */
export function rowStatus(row: RenamePlanRow, mode: GridMode): RowStatus {
  if (mode === 'preview' || mode === 'expired') {
    if (row.excluded) {
      return {
        label: 'excluded',
        tone: 'idle',
        icon: 'x',
        spoken: 'excluded from the plan — this file will not be sent',
      };
    }
    if (mode === 'expired') {
      return {
        label: 'expired',
        tone: 'idle',
        icon: 'clock',
        spoken: 'expired — this plan can no longer be applied',
      };
    }
    if (row.warnings.length > 0) {
      return {
        label: 'review',
        tone: 'warn',
        icon: 'alert',
        spoken: `needs review — ${row.warnings.map((w) => WARNING_COPY[w].label).join(', ')}`,
      };
    }
    return { label: 'ready', tone: 'idle', icon: 'check', spoken: 'ready to apply' };
  }

  if (row.excluded) {
    return {
      label: 'skipped',
      tone: 'idle',
      icon: 'x',
      spoken: 'skipped — excluded before applying, so it was never sent',
    };
  }

  switch (row.outcome) {
    case 'succeeded':
      return { label: 'renamed', tone: 'ok', icon: 'check', spoken: 'renamed by the instance' };
    case 'failed':
      return {
        label: 'failed',
        tone: 'error',
        icon: 'alert',
        spoken: `not renamed — ${row.outcomeDetail ?? 'the instance did not say why'}`,
      };
    case 'skipped':
      return { label: 'skipped', tone: 'idle', icon: 'x', spoken: 'skipped — not sent' };
    default:
      return mode === 'applying'
        ? {
          label: 'waiting',
          tone: 'idle',
          icon: 'clock',
          spoken: 'waiting — sent or queued, with no result observed yet',
        }
        : {
          // A plan that finished without an outcome for a row is a gap in what
          // helparr knows, and saying so is the only honest option: counting it
          // as renamed would be the exact lie FR13 exists to prevent.
          label: 'no outcome',
          tone: 'warn',
          icon: 'alert',
          spoken: 'no outcome was observed for this file',
        };
  }
}

/* ── The final summary (FR13) ─────────────────────────────────────────────── */

export interface TruthfulSummary extends RenameApplySummary {
  /**
   * Rows that were sent and whose result never arrived. Kept out of the other
   * three buckets rather than folded into one — it is not a success, and calling
   * it a failure would assert something equally unobserved.
   */
  unreported: number;
  /** Rows whose outcome has landed, of those that were sent. For the progress bar. */
  resolved: number;
  sent: number;
}

/**
 * Counted from the per-row outcomes the server recorded, one row at a time.
 *
 * Never from a command's own report: the spike measured Sonarr returning
 * `completed` / `successful` for a command that renamed nothing (ADR-7, ADR-9).
 * A summary built from that would have said "47 of 47 succeeded" about a library
 * that had not changed.
 */
export function summarize(rows: RenamePlanRow[]): TruthfulSummary {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let unreported = 0;

  for (const row of rows) {
    if (row.excluded && row.outcome === 'pending') { skipped += 1; continue; }
    switch (row.outcome) {
      case 'succeeded': succeeded += 1; break;
      case 'failed': failed += 1; break;
      case 'skipped': skipped += 1; break;
      default: unreported += 1;
    }
  }

  const sent = rows.length - rows.filter((row) => row.excluded && row.outcome === 'pending').length;
  return {
    succeeded,
    failed,
    skipped,
    unreported,
    resolved: succeeded + failed,
    sent,
  };
}

/* ── Expiry (FR11) ────────────────────────────────────────────────────────── */

/** `mm:ss`, floored. A countdown that rounds up claims time the plan does not have. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Milliseconds left on the plan, or null when it carries no window. */
export function millisLeft(plan: RenamePlanDto, now: number): number | null {
  if (!plan.expiresAt) return null;
  const at = Date.parse(plan.expiresAt);
  return Number.isNaN(at) ? null : at - now;
}

/* ── Grouping (T12) ───────────────────────────────────────────────────────── */

/**
 * Keyed by instance *and* title, never by label alone: two Sonarrs can both hold
 * a series called `Reacher`, and merging them would put one instance's rows
 * under the other's heading (inherited from `GapsGrid.buildRenderRows`).
 */
export function titleKeyOf(row: RenamePlanRow): string {
  return `${row.instanceId ?? ''}:${row.titleKind}:${row.titleUpstreamId}`;
}
