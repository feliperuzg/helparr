import type { IconName } from '@/components/Icon';
import type { Tone } from '@/components/ui';
import type { QueueRecord } from './types';

/**
 * Presentation derivations for the queue screen.
 *
 * Client-safe on purpose: nothing here reaches an instance, and the derivations
 * have to be identical wherever they are made. The badge in the table and the
 * badge in the inspector disagreeing about a row would be worse than either
 * being wrong.
 */

export const QUEUE_STATES = [
  'downloading',
  'importing',
  'queued',
  'paused',
  'stalled',
  'failed',
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export const STATE_LABEL: Record<QueueState, string> = {
  downloading: 'Downloading',
  importing: 'Importing',
  queued: 'Queued',
  paused: 'Paused',
  stalled: 'Stalled',
  failed: 'Failed',
};

export const STATE_TONE: Record<QueueState, Tone> = {
  downloading: 'ok',
  importing: 'ok',
  queued: 'idle',
  paused: 'idle',
  stalled: 'warn',
  failed: 'error',
};

export const STATE_ICON: Record<QueueState, IconName> = {
  downloading: 'down',
  importing: 'import',
  queued: 'clock',
  paused: 'pause',
  stalled: 'pause',
  failed: 'alert',
};

/**
 * The derived badge (REQ-QUEUE-004, -005).
 *
 * The stall verdict is consulted **first**, and that ordering is the whole
 * point: a torrent stuck fetching metadata reports `trackedDownloadStatus: ok`,
 * so any derivation that reads the *arr channels first would paint the row
 * healthy — the exact bug this screen exists to expose. The four raw channels
 * are never collapsed away; they stay on the record for the inspector to show
 * verbatim.
 */
export function deriveState(record: QueueRecord): QueueState {
  if (record.stall.stalled) return 'stalled';

  const status = record.status.toLowerCase();
  const trackedState = record.trackedDownloadState.toLowerCase();

  if (record.trackedDownloadStatus.toLowerCase() === 'error') return 'failed';
  if (status === 'failed' || status === 'warning' || trackedState.startsWith('failed')) {
    return 'failed';
  }
  if (trackedState.startsWith('import')) return 'importing';
  if (status === 'paused') return 'paused';
  if (status === 'downloading') return 'downloading';
  return 'queued';
}

/** True for the rows the "N need attention" badge counts. */
export function needsAttention(record: QueueRecord): boolean {
  const state = deriveState(record);
  return state === 'stalled' || state === 'failed';
}

/**
 * Why helparr disagrees with the *arr, in one line — shown next to the badge
 * whenever it does. A derived verdict the operator cannot trace back to evidence
 * is just a second opinion.
 */
export function stallDisagreement(record: QueueRecord): string | null {
  if (!record.stall.stalled) return null;
  if (record.trackedDownloadStatus.toLowerCase() !== 'ok') return null;
  return `per the download client: ${record.stall.evidence} — `
    + `${record.instanceLabel} reports this download as ok`;
}

export function progressOf(record: QueueRecord): number {
  if (record.size <= 0) return 0;
  const done = (record.size - record.sizeleft) / record.size;
  return Math.max(0, Math.min(100, Math.round(done * 100)));
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** qBittorrent reports 8640000 (100 days) as its "unknown" sentinel. */
const ETA_UNKNOWN = 8_640_000;

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds >= ETA_UNKNOWN) return '∞';
  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `${days}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return `${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

/**
 * The ETA the row shows. The download client's own estimate wins when there is
 * one, because it is measuring the transfer; the *arr's
 * `estimatedCompletionTime` is a projection and drifts badly once a torrent
 * slows down.
 */
export function etaOf(record: QueueRecord): string {
  if (record.torrent) return formatDuration(record.torrent.eta);
  if (!record.estimatedCompletionTime) return '—';
  const seconds = (Date.parse(record.estimatedCompletionTime) - Date.now()) / 1000;
  return Number.isNaN(seconds) ? '—' : formatDuration(seconds);
}

/**
 * Relative time, phrased for the freshness stamps on the health rail. Always
 * past tense — these describe reads that already happened.
 */
export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never read';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return 'never read';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `read ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `read ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `read ${hours}h ago`;
  return `read ${Math.round(hours / 24)}d ago`;
}

/** Forward-looking counterpart, for "next attempt in 3m 40s". */
export function formatCountdown(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return 'any moment now';
  return `in ${formatDuration(ms / 1000)}`;
}
