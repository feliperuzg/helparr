'use client';

import Icon from '@/components/Icon';
import { formatAge, formatCountdown } from '@/lib/queue';
import type { InstanceReadError } from '@/lib/types';

/**
 * The degraded banner (REQ-QUEUE-007, -008, ADR-5, T17 — deviation D3).
 *
 * It **names the instance**. "Some instances are unavailable" is not acceptable:
 * the operator's next action is different for Radarr being down than for the
 * download client being down, and a banner that hides which one costs them the
 * trip to find out.
 *
 * `role="status"` / `aria-live="polite"` so it announces when it appears without
 * stealing focus from the grid the operator is working in.
 */
export default function DegradedBanner({
  errors,
  lastReadAt,
  shownRows,
  onRetry,
  retrying,
}: {
  errors: InstanceReadError[];
  lastReadAt: Record<string, string>;
  shownRows: number;
  onRetry: (instanceId: string) => void;
  retrying: ReadonlySet<string>;
}) {
  // Absent entirely when everything is readable — it does not reserve layout
  // space in the healthy case.
  if (errors.length === 0) return null;

  return (
    <div className="callout callout--warn banner" role="status" aria-live="polite">
      <Icon name="alert" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {errors.map((error) => (
          <div key={`${error.instanceId}-${error.kind}`} className="banner__line">
            <span>
              <strong>{error.instanceLabel}</strong>
              {error.kind === 'circuit-open' ? (
                <>
                  {' is not being contacted. '}
                  {error.reason}
                  {formatCountdown(error.retryAt)
                    ? ` Next attempt ${formatCountdown(error.retryAt)}.`
                    : ''}
                </>
              ) : (
                <>{` could not be read — ${error.reason}`}</>
              )}
              {' '}
              <span className="subtle">
                Last successful read: {formatAge(lastReadAt[error.instanceId] ?? null)}.
              </span>
            </span>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={retrying.has(error.instanceId)}
              onClick={() => onRetry(error.instanceId)}
            >
              <Icon name="refresh" size={12} />
              {retrying.has(error.instanceId) ? 'Retrying…' : 'Retry now'}
            </button>
          </div>
        ))}
        <p className="subtle" style={{ fontSize: 12, marginTop: 'var(--space-1)' }}>
          {/* The screen never blanks: whatever was read still renders. */}
          Showing {shownRows} row{shownRows === 1 ? '' : 's'} from the instances that answered.
        </p>
      </div>
    </div>
  );
}
