import type { HealthState, InstanceKind } from './types';
import type { Tone } from '@/components/ui';
import type { IconName } from '@/components/Icon';

/**
 * Health state → visual tone. `unauthorized` is an error rather than a warning:
 * unlike a degraded instance it will never recover on its own, so it should not
 * share a channel with "retrying".
 */
export const STATUS_TONE: Record<HealthState, Tone> = {
  untested: 'idle',
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'error',
  unauthorized: 'error',
  disabled: 'idle',
};

export const STATUS_LABEL: Record<HealthState, string> = {
  untested: 'not tested',
  ok: 'connected',
  degraded: 'degraded',
  unreachable: 'unreachable',
  unauthorized: 'bad credentials',
  disabled: 'disabled',
};

export const KIND_ICON: Record<InstanceKind, IconName> = {
  sonarr: 'tv',
  radarr: 'film',
  prowlarr: 'search',
  'download-client': 'down',
};
