import 'server-only';

/**
 * Per-kind force-import write gate (ADR-6).
 *
 * Sonarr's `ManualImport` payload was captured live against a running
 * instance (OQ-5, research.md): `{name: 'ManualImport', importMode: 'auto',
 * files: [{path, seriesId, episodeIds, quality, languages, releaseGroup,
 * indexerFlags, releaseType, downloadId}]}`. Radarr's is the same projection
 * with `movieId` in place of `seriesId`/`episodeIds`.
 *
 * Radarr was enabled without a live capture: the operator waived T0 and took
 * the payload as Sonarr's equivalent (ADR-6, amended). Its shape is pinned by
 * `test/import-plan.test.ts` against `fakeArr`, not against a real instance.
 *
 * `startImport` reads this map before issuing any write. A kind set to `false`
 * still renders its candidates read-only — the gate is on the write, not the
 * read.
 */
export const IMPORT_WRITE_ENABLED: Record<'sonarr' | 'radarr', boolean> = {
  sonarr: true,
  radarr: true,
};

export function importWriteEnabled(kind: 'sonarr' | 'radarr'): boolean {
  return IMPORT_WRITE_ENABLED[kind];
}
