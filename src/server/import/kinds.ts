import 'server-only';

/**
 * Per-kind force-import write gate (ADR-6).
 *
 * Sonarr's `ManualImport` payload was captured live against a running
 * instance (OQ-5, research.md): `{name: 'ManualImport', importMode: 'auto',
 * files: [{path, seriesId, episodeIds, quality, languages, releaseGroup,
 * indexerFlags, releaseType, downloadId}]}`. Radarr's is a projection —
 * `movieId` in place of `seriesId`/`episodeIds` — implemented and tested
 * against `fakeArr`, but never exercised against a real instance.
 *
 * `startImport` (T8) reads this map before issuing any write, and
 * `radarr: false` is what keeps that unverified projection out of a real
 * library. T0 captures one real Radarr import and confirms or amends ADR-6;
 * T28 flips this flag only if that capture matches. While disabled, Radarr's
 * candidates still render read-only — the gate is on the write, not the read.
 */
export const IMPORT_WRITE_ENABLED: Record<'sonarr' | 'radarr', boolean> = {
  sonarr: true,
  radarr: false,
};

export function importWriteEnabled(kind: 'sonarr' | 'radarr'): boolean {
  return IMPORT_WRITE_ENABLED[kind];
}
