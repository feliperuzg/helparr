#!/usr/bin/env node
/**
 * indexer-search-grab / OQ-2, OQ-3, OQ-4 — spike the manual-grab semantics
 * against live Prowlarr and Sonarr instances.
 *
 * Three questions the proposal could not answer from documentation:
 *
 *   OQ-2  Which endpoint grabs — `POST /api/v3/release` (what the *arr UI
 *         calls; wants a `guid` + `indexerId` from a search Sonarr itself ran)
 *         or `POST /api/v3/release/push` (takes an external release by title +
 *         downloadUrl)?
 *   OQ-3  If `/release` needs Sonarr's own `guid`, can a Prowlarr-originated
 *         result be grabbed through it at all?
 *   OQ-4  Where do rejection reasons come from for a release the operator has
 *         NOT grabbed — is there a dry-run path, or are they only a side effect
 *         of attempting the push?
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT IS READ-ONLY. It issues GETs only. It never calls
 * `POST /api/v3/release` or `POST /api/v3/release/push`, because both of those
 * GRAB — they hand a release to the download client. Nothing here adds,
 * removes, or modifies anything in Prowlarr, Sonarr, Radarr or the client.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It prints no credentials. Download URLs carry indexer passkeys, so they are
 * never echoed — only their host, their parameter *names*, and a truncated
 * SHA-256. Release titles are truncated too: a terminal log should not become a
 * list of what the operator is downloading.
 *
 * Usage:
 *
 *   PROWLARR_URL=http://10.0.0.5:9696 PROWLARR_API_KEY=… \
 *   SONARR_URL=http://10.0.0.5:8989   SONARR_API_KEY=… \
 *     npm run spike:grab
 *
 * RADARR_URL / RADARR_API_KEY are optional; used only if Sonarr has no series.
 * SPIKE_QUERY overrides the search term (default: a generic, broad term).
 *
 * Exit codes: 0 = spike produced answers, 2 = could not run (missing config,
 * unreachable host, nothing to search against).
 */

import { createHash } from 'node:crypto';

const env = (name) => process.env[name]?.trim() || null;

/** Enough to correlate two lists across runs, not enough to be a working URL. */
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

const clip = (s, n = 48) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

/** A download URL's shape without its secrets: host + which params it carries. */
function describeUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const params = [...url.searchParams.keys()].sort();
    return {
      scheme: url.protocol.replace(':', ''),
      host: url.host,
      paramNames: params,
      looksLikePasskey: params.filter((p) => /passkey|apikey|api_key|token|rss_?key|secret|auth/i.test(p)),
      fingerprint: fingerprint(raw),
    };
  } catch {
    // Magnet links are not parseable as URLs by every runtime path we care about.
    const isMagnet = raw.startsWith('magnet:');
    return { scheme: isMagnet ? 'magnet' : 'unknown', host: null, paramNames: [], looksLikePasskey: [], fingerprint: fingerprint(raw) };
  }
}

async function get(label, baseUrl, apiKey, path, params = {}, timeoutMs = 120_000) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const response = await fetch(url, {
    headers: { 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${label} ${path} returned HTTP ${response.status}`);
  return response.json();
}

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

async function main() {
  const prowlarrUrl = env('PROWLARR_URL');
  const prowlarrKey = env('PROWLARR_API_KEY');
  const sonarrUrl = env('SONARR_URL');
  const sonarrKey = env('SONARR_API_KEY');
  const radarrUrl = env('RADARR_URL');
  const radarrKey = env('RADARR_API_KEY');
  const query = env('SPIKE_QUERY') || '1080p';

  if (!prowlarrUrl || !prowlarrKey || !sonarrUrl || !sonarrKey) {
    console.error('Set PROWLARR_URL, PROWLARR_API_KEY, SONARR_URL and SONARR_API_KEY.');
    console.error('See the header of this file.');
    process.exit(2);
  }

  const findings = {};

  // ── Versions ──────────────────────────────────────────────────────────────
  section('Versions');
  const prowlarrStatus = await get('Prowlarr', prowlarrUrl, prowlarrKey, '/api/v1/system/status');
  const sonarrStatus = await get('Sonarr', sonarrUrl, sonarrKey, '/api/v3/system/status');
  console.log(`Prowlarr: ${prowlarrStatus.version}`);
  console.log(`Sonarr:   ${sonarrStatus.version}`);
  findings.prowlarrVersion = prowlarrStatus.version;
  findings.sonarrVersion = sonarrStatus.version;

  // ── OQ-3, part 1: do Prowlarr and Sonarr agree on indexer identity? ───────
  // Prowlarr syncs its indexers INTO Sonarr as separate indexer definitions.
  // If the ids do not line up, a Prowlarr `indexerId` is meaningless to Sonarr
  // and `POST /api/v3/release` cannot be addressed with Prowlarr's output.
  section('Indexer identity across the two apps (OQ-3)');
  const prowlarrIndexers = await get('Prowlarr', prowlarrUrl, prowlarrKey, '/api/v1/indexer');
  const sonarrIndexers = await get('Sonarr', sonarrUrl, sonarrKey, '/api/v3/indexer');

  console.log(`Prowlarr indexers: ${prowlarrIndexers.length}`);
  console.log(`Sonarr indexers:   ${sonarrIndexers.length}`);

  const prowlarrById = new Map(prowlarrIndexers.map((i) => [i.id, i.name]));
  const sonarrById = new Map(sonarrIndexers.map((i) => [i.id, i.name]));

  let idsAgree = 0;
  let idsCollide = 0;
  for (const [id, name] of prowlarrById) {
    if (!sonarrById.has(id)) continue;
    if (sonarrById.get(id) === name) idsAgree += 1;
    else idsCollide += 1;
  }
  console.log(`ids present in both, same name:      ${idsAgree}`);
  console.log(`ids present in both, DIFFERENT name: ${idsCollide}`);
  findings.indexerIdsAgree = idsAgree;
  findings.indexerIdsCollide = idsCollide;

  if (idsCollide > 0) {
    console.log('');
    console.log('  → A Prowlarr indexerId names a DIFFERENT indexer in Sonarr.');
    console.log('    Passing Prowlarr ids to Sonarr would address the wrong indexer.');
  }

  // ── OQ-2/OQ-3, part 2: what does a Prowlarr search result actually carry? ─
  section(`Prowlarr aggregate search — query "${query}" (OQ-2)`);
  const prowlarrResults = await get(
    'Prowlarr', prowlarrUrl, prowlarrKey, '/api/v1/search',
    { query, indexerIds: -1, type: 'search', limit: 50 },
  );
  console.log(`results: ${prowlarrResults.length}`);
  findings.prowlarrResultCount = prowlarrResults.length;

  if (prowlarrResults.length > 0) {
    const sample = prowlarrResults[0];
    const fields = Object.keys(sample).sort();
    console.log(`fields on a result: ${fields.join(', ')}`);
    console.log('');
    console.log(`sample guid:        ${clip(String(sample.guid), 64)}`);
    console.log(`sample indexerId:   ${sample.indexerId} (${prowlarrById.get(sample.indexerId) ?? 'unknown'})`);
    console.log(`sample protocol:    ${sample.protocol}`);
    console.log(`carries rejections: ${Object.hasOwn(sample, 'rejections') ? 'yes' : 'NO'}`);

    const dl = describeUrl(sample.downloadUrl || sample.magnetUrl);
    if (dl) {
      console.log(`downloadUrl shape:  ${dl.scheme}://${dl.host ?? '(magnet)'} params=[${dl.paramNames.join(',')}]`);
      console.log(`  passkey-ish params: ${dl.looksLikePasskey.length ? dl.looksLikePasskey.join(',') : 'none detected'}`);
      console.log(`  fingerprint:        ${dl.fingerprint}`);
    }
    findings.prowlarrResultCarriesRejections = Object.hasOwn(sample, 'rejections');
    findings.prowlarrGuidSample = String(sample.guid);
    findings.passkeyParams = dl?.looksLikePasskey ?? [];
  } else {
    console.log('  (no results — try SPIKE_QUERY with a broader term)');
  }

  // ── OQ-4: are rejections available WITHOUT grabbing? ──────────────────────
  // Sonarr's interactive search is a GET. If its results already carry a
  // populated `rejections` array, the decision engine can be consulted without
  // any write at all — which is the whole question.
  section("Sonarr interactive search — rejections without a grab (OQ-4)");
  const series = await get('Sonarr', sonarrUrl, sonarrKey, '/api/v3/series');
  console.log(`series in library: ${series.length}`);

  let sonarrReleases = null;
  let searchTarget = null;

  if (series.length > 0) {
    // Prefer a monitored series with episodes already on disk, because a
    // rejection like "Existing file meets cutoff" is exactly what we want to
    // see — it is the failure mode the whole feature exists to surface.
    const candidate = series.find((s) => s.monitored && s.statistics?.episodeFileCount > 0) ?? series[0];
    searchTarget = candidate.title;
    console.log(`searching against: ${clip(candidate.title, 40)} (id ${candidate.id})`);
    console.log('  (this runs a live interactive search; it can take a minute)');
    sonarrReleases = await get(
      'Sonarr', sonarrUrl, sonarrKey, '/api/v3/release',
      { seriesId: candidate.id },
      180_000,
    );
  } else if (radarrUrl && radarrKey) {
    const movies = await get('Radarr', radarrUrl, radarrKey, '/api/v3/movie');
    if (movies.length > 0) {
      const candidate = movies.find((m) => m.monitored && m.hasFile) ?? movies[0];
      searchTarget = candidate.title;
      console.log(`no series; searching Radarr against: ${clip(candidate.title, 40)} (id ${candidate.id})`);
      sonarrReleases = await get('Radarr', radarrUrl, radarrKey, '/api/v3/release', { movieId: candidate.id }, 180_000);
    }
  }

  if (!sonarrReleases) {
    console.error('\nINCONCLUSIVE — nothing in the library to run an interactive search against.');
    process.exit(2);
  }

  console.log(`releases returned: ${sonarrReleases.length}`);
  findings.sonarrReleaseCount = sonarrReleases.length;

  if (sonarrReleases.length > 0) {
    const withRejections = sonarrReleases.filter((r) => Array.isArray(r.rejections) && r.rejections.length > 0);
    console.log(`carrying a non-empty rejections array: ${withRejections.length}/${sonarrReleases.length}`);
    findings.releasesWithRejections = withRejections.length;

    const reasons = [...new Set(withRejections.flatMap((r) => r.rejections.map((x) => (typeof x === 'string' ? x : x.reason))))];
    if (reasons.length > 0) {
      console.log('');
      console.log('verbatim rejection reasons seen (this is the product value):');
      for (const reason of reasons.slice(0, 8)) console.log(`  · ${reason}`);
      if (reasons.length > 8) console.log(`  … and ${reasons.length - 8} more`);
    }
    findings.rejectionReasons = reasons;

    const sample = sonarrReleases[0];
    console.log('');
    console.log(`sample guid:      ${clip(String(sample.guid), 64)}`);
    console.log(`sample indexerId: ${sample.indexerId} (${sonarrById.get(sample.indexerId) ?? 'unknown'})`);

    // ── OQ-3, the decisive comparison ───────────────────────────────────────
    // Do the two apps even speak the same guid vocabulary? If Prowlarr's guids
    // never appear in Sonarr's own search output, then `POST /api/v3/release`
    // has nothing to resolve and cannot grab a Prowlarr-only release.
    if (findings.prowlarrGuidSample) {
      const sonarrGuids = new Set(sonarrReleases.map((r) => String(r.guid)));
      const prowlarrGuids = new Set(prowlarrResults.map((r) => String(r.guid)));
      const shared = [...prowlarrGuids].filter((g) => sonarrGuids.has(g));
      console.log('');
      console.log(`guid overlap, Prowlarr search ∩ Sonarr search: ${shared.length}`);
      console.log(`  (different queries, so overlap is not expected — the point is the FORMAT below)`);
      console.log(`  Prowlarr guid format: ${clip(findings.prowlarrGuidSample, 56)}`);
      console.log(`  Sonarr   guid format: ${clip(String(sample.guid), 56)}`);
      findings.guidOverlap = shared.length;
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  section('Verdict');

  if (findings.releasesWithRejections > 0) {
    console.log('OQ-4: ANSWERED — rejection reasons are available WITHOUT grabbing.');
    console.log('      `GET /api/v3/release` returns them on every release it lists,');
    console.log('      so the decision engine can be consulted read-only. A dry run');
    console.log('      does not require `/release/push`.');
  } else if (findings.sonarrReleaseCount > 0) {
    console.log('OQ-4: PARTIAL — the interactive search returned releases but none');
    console.log('      were rejected, so the rejections array was never populated.');
    console.log('      Re-run against a series whose episodes are already on disk.');
  }

  console.log('');
  if (findings.indexerIdsCollide > 0 || findings.indexerIdsAgree === 0) {
    console.log('OQ-3: ANSWERED — Prowlarr and Sonarr do NOT share indexer identity,');
    console.log('      so a Prowlarr result cannot address `POST /api/v3/release`.');
    console.log('      `/release/push` is the only path for a Prowlarr-only release.');
  } else {
    console.log('OQ-3: indexer ids line up; inspect the guid formats above before');
    console.log('      concluding that `/release` can take Prowlarr output.');
  }

  console.log('');
  console.log('OQ-2: decided by OQ-3 plus the rejection path above — see plan.md ADRs.');

  if (findings.passkeyParams?.length) {
    console.log('');
    console.log(`NFR2 note: download URLs carry ${findings.passkeyParams.join(', ')} —`);
    console.log('      confirming the operation log must never store them verbatim.');
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(`\nINCONCLUSIVE — ${error.message}`);
  process.exit(2);
});
