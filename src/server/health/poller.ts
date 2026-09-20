import 'server-only';

import type { HealthState, InstanceHealthDto, InstanceHealthSummary } from '@/lib/types';
import type { ProbeResult } from '@/server/clients/types';
import { enabledClients, recordHealth } from '@/server/instances/registry';
import { fireOn, isCircuitOpen, retryAt } from '@/server/resilience/breaker';
import { logger } from '@/server/logging/redact';

/**
 * Health fan-out with hysteresis (ADR-6, REQ-INST-009 / FR9, NFR8).
 *
 * Cost at rest: one `system/status` call per enabled instance per interval —
 * 240 requests/hour at four instances and 60s, collapsing toward zero for any
 * instance whose breaker is open.
 */

const FAILURE_THRESHOLD = 2;

/** Consecutive failures per instance. An instance is declared down only on the
 *  second one: a single transient timeout must not flap the shell badge.
 *  Flapping health notifications are a documented problem in the *arr apps
 *  themselves, so this is a known failure mode being designed around. */
const consecutiveFailures = new Map<string, number>();
const lastReported = new Map<string, InstanceHealthDto>();

export function resetHysteresis(): void {
  consecutiveFailures.clear();
  lastReported.clear();
}

function isFailure(result: ProbeResult): boolean {
  return result.state === 'unreachable' || result.state === 'degraded';
}

export async function probeAll(): Promise<InstanceHealthSummary> {
  const targets = enabledClients();
  const observedAt = new Date().toISOString();

  // allSettled, never all-or-nothing: one instance throwing must not deprive
  // the operator of the other three's state (FR10).
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      // The probe goes through the same breaker as queue reads and removals, so
      // a persistently failing queue endpoint eventually silences this probe too
      // — and the rail says "not contacted" instead of claiming connectivity it
      // is no longer testing.
      const outcome = await fireOn(target.id, () => target.client.probe(), { isFailure });
      return { target, outcome };
    }),
  );

  const instances: InstanceHealthDto[] = settled.map((entry, index) => {
    const target = targets[index]!;
    const outcome = entry.status === 'fulfilled' ? entry.value.outcome : null;
    const circuitOpen = outcome !== null && isCircuitOpen(outcome) ? outcome : null;

    // An errored probe resolves to `degraded` with a reason, never to `ok`.
    // Sonarr's own health run can abort when the host is offline, so "no
    // problems reported" is not evidence that there are none.
    const result: ProbeResult = outcome !== null && !isCircuitOpen(outcome)
      ? outcome
      : {
        state: 'degraded',
        reason: 'The probe did not complete; treating the instance as unknown rather than healthy.',
      };

    if (entry.status === 'rejected') {
      logger.warn('probe threw', { instanceId: target.id, error: entry.reason });
    }

    const failures = circuitOpen !== null || isFailure(result)
      ? (consecutiveFailures.get(target.id) ?? 0) + 1
      : 0;
    consecutiveFailures.set(target.id, failures);

    let state: HealthState;
    let reason: string | null;

    if (circuitOpen !== null) {
      // No hysteresis here. The breaker only opened because several failures
      // already accumulated, so absorbing one more would delay a state that is
      // by construction not a blip.
      state = 'unreachable';
      reason = circuitOpen.reason;
    } else if (result.state === 'ok') {
      state = 'ok';
      reason = null;
    } else if (result.state === 'unauthorized') {
      // Never subject to hysteresis. A rejected credential is deterministic,
      // not transient, and it is the operator's most actionable state.
      state = 'unauthorized';
      reason = result.reason;
    } else if (failures < FAILURE_THRESHOLD) {
      // `pending_failure` — invisible by design. The operator keeps seeing the
      // last good state while a single blip is absorbed.
      const previous = lastReported.get(target.id);
      state = previous?.state ?? 'untested';
      reason = previous?.reason ?? null;
    } else {
      state = result.state === 'unreachable' ? 'unreachable' : 'degraded';
      reason = result.reason;
    }

    const dto: InstanceHealthDto = {
      instanceId: target.id,
      kind: target.kind,
      label: target.label,
      state,
      latencyMs: result.state === 'ok' ? result.latencyMs : null,
      version: result.state === 'ok' ? result.version : (lastReported.get(target.id)?.version ?? null),
      reason,
      retryAt: retryAt(target.id),
      observedAt,
    };

    lastReported.set(target.id, dto);
    recordHealth(target.id, state, dto.version, dto.latencyMs, reason);
    return dto;
  });

  return {
    instances,
    degradedCount: instances.filter((i) => i.state !== 'ok').length,
  };
}
