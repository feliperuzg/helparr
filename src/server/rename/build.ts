import 'server-only';

import type { RenameScopeEntry, RenameTitleStatus } from '@/lib/types';
import { logger } from '@/server/logging/redact';
import { resolvePlanRows } from './resolve';
import {
  abandonBuild,
  createPlan,
  finalizePlan,
  readScope,
  updateBuildProgress,
} from './store';

/**
 * Plan building (FR2, FR5, FR15; ADR-5).
 *
 * Two upstream calls per title — a rescan that has to be waited on, then the
 * preview — is slow enough that a request-response shape would time out on a
 * scope of any size. So the route returns a plan id immediately and the browser
 * polls it, and this module fills the plan in behind that.
 *
 * helparr runs as one long-lived Node process (it is a self-hosted container,
 * not a serverless function), so work started here outlives the request that
 * started it. That is the assumption the poll model rests on; if the process
 * restarts mid-build the plan stays in `building` and the operator regenerates
 * — which costs a wait, not correctness, because nothing has been written
 * upstream at this point.
 */

/** Plans in flight, so a second request for the same scope does not double it. */
const inFlight = new Set<string>();

export function isBuilding(planId: string): boolean {
  return inFlight.has(planId);
}

/**
 * Opens a plan and starts filling it. Returns as soon as the scope is
 * persisted — the id is usable for polling immediately.
 */
export function startBuild(scope: RenameScopeEntry[]): string {
  const planId = createPlan(scope);
  inFlight.add(planId);
  void runBuild(planId).finally(() => inFlight.delete(planId));
  return planId;
}

async function runBuild(planId: string): Promise<void> {
  const scope = readScope(planId);

  // Seeded so the very first poll shows every selected title as pending rather
  // than an empty list that looks like nothing was selected.
  const titles: RenameTitleStatus[] = scope.map((entry) => pendingTitle(entry));
  updateBuildProgress(planId, titles);

  try {
    const resolved = await resolvePlanRows(scope, {
      onTitle: (title) => {
        const index = titles.findIndex(
          (candidate) => candidate.instanceId === title.status.instanceId
            && candidate.kind === title.status.kind
            && candidate.upstreamId === title.status.upstreamId,
        );
        if (index >= 0) titles[index] = title.status;
        updateBuildProgress(planId, titles);
      },
    });

    // Every title errored — there is no plan here, only a list of failures, and
    // presenting that as a plan ready to apply would be a lie about its
    // emptiness. A plan whose titles simply had nothing pending is different,
    // and is finalized normally (FR5).
    if (resolved.titles.length > 0 && resolved.titles.every((t) => t.state === 'errored')) {
      abandonBuild(planId, {
        kind: 'empty',
        reason: 'No title could be previewed, so there is nothing to approve.',
        drifted: [],
      });
      return;
    }

    finalizePlan(planId, resolved);
  } catch (error) {
    logger.error('rename plan build failed', { planId, error: String(error) });
    abandonBuild(planId, {
      kind: 'empty',
      reason: 'The preview could not be built. Nothing was renamed.',
      drifted: [],
    });
  }
}

function pendingTitle(entry: RenameScopeEntry): RenameTitleStatus {
  return {
    instanceId: entry.instanceId,
    instanceLabel: entry.instanceId,
    kind: entry.kind,
    upstreamId: entry.upstreamId,
    label: entry.label,
    state: 'pending',
    fileCount: 0,
    reason: null,
  };
}
