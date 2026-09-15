'use client';

import Icon, { type IconName } from '@/components/Icon';
import { StatusBadge, StatusDot, type Tone } from '@/components/ui';
import { formatAge, formatCountdown } from '@/lib/queue';
import { KIND_ICON } from '@/lib/status';
import type { InstanceHealthDto } from '@/lib/types';

/**
 * The health rail (REQ-QUEUE-009, -015, T16).
 *
 * Five states, and the fifth is the reason this is not just the health badge
 * repeated: **Not contacted** is distinct from **Unreachable** on purpose. "We
 * tried and it failed" and "we have stopped trying" call for different actions,
 * and only the second explains why the screen is no longer updating.
 */

type RailState = 'ok' | 'degraded' | 'unreachable' | 'not-contacted' | 'unknown';

const RAIL_TONE: Record<RailState, Tone> = {
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'error',
  'not-contacted': 'idle',
  unknown: 'idle',
};

const RAIL_LABEL: Record<RailState, string> = {
  ok: 'Connected',
  degraded: 'Degraded',
  unreachable: 'Unreachable',
  'not-contacted': 'Not contacted',
  unknown: 'Unknown',
};

const RAIL_ICON: Record<RailState, IconName> = {
  ok: 'check',
  degraded: 'alert',
  unreachable: 'x',
  'not-contacted': 'pause',
  unknown: 'clock',
};

/**
 * An open breaker surfaces as `unreachable` with a `retryAt` (T11). That pair is
 * what separates the two error states — there is no separate health state for
 * it, because as far as the *instance* is concerned nothing changed; what
 * changed is what helparr is doing about it.
 */
export function railState(instance: InstanceHealthDto): RailState {
  if (instance.state === 'unreachable' && instance.retryAt) return 'not-contacted';
  if (instance.state === 'ok') return 'ok';
  if (instance.state === 'degraded') return 'degraded';
  if (instance.state === 'unreachable' || instance.state === 'unauthorized') return 'unreachable';
  return 'unknown';
}

export interface InstanceHealthRailProps {
  instances: InstanceHealthDto[];
  /** Per-instance last *successful* queue read, from `GET /api/queue`. */
  lastReadAt: Record<string, string>;
  onRetry: (instanceId: string) => void;
  retrying: ReadonlySet<string>;
}

export default function InstanceHealthRail({
  instances,
  lastReadAt,
  onRetry,
  retrying,
}: InstanceHealthRailProps) {
  return (
    <div className="grid grid--instances">
      {instances.map((instance) => {
        const state = railState(instance);
        const tone = RAIL_TONE[state];
        const countdown = state === 'not-contacted' ? formatCountdown(instance.retryAt) : null;

        return (
          <article key={instance.instanceId} className="card">
            <div className="card__head">
              <StatusDot tone={tone} pulse={state === 'ok'} label={RAIL_LABEL[state]} />
              <Icon name={KIND_ICON[instance.kind]} size={12} />
              <span className="card__title">{instance.label}</span>
              <span className="mono subtle" style={{ marginLeft: 'auto' }}>
                {instance.version ?? '—'}
              </span>
            </div>

            <StatusBadge tone={tone} icon={RAIL_ICON[state]}>{RAIL_LABEL[state]}</StatusBadge>

            {/* Freshness is per instance, never one stamp for the whole table:
                Sonarr's rows being 12s old says nothing about Radarr's being
                4 minutes old (REQ-QUEUE-015). */}
            <p className="mono subtle truncate" style={{ marginTop: 'var(--space-2)' }}>
              {formatAge(lastReadAt[instance.instanceId] ?? null)}
              {countdown ? ` · next attempt ${countdown}` : ''}
              {!countdown && instance.reason ? ` · ${instance.reason}` : ''}
            </p>

            {state === 'not-contacted' ? (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                style={{ marginTop: 'var(--space-3)' }}
                disabled={retrying.has(instance.instanceId)}
                onClick={() => onRetry(instance.instanceId)}
              >
                <Icon name="refresh" size={12} />
                {retrying.has(instance.instanceId) ? 'Retrying…' : 'Retry now'}
              </button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
