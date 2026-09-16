#!/usr/bin/env node
/**
 * library-gaps-attach / OQ-1, OQ-2, OQ-5, OQ-6 — spike the gap read and the
 * manual-attach semantics against live Sonarr, Radarr and qBittorrent.
 *
 * Four questions the proposal could not answer from documentation:
 *
 *   OQ-1  Does the attach go through the *arr (`/release/push`, which maps the
 *         download by PARSING a title helparr controls) or through the download
 *         client directly (precise mapping, but the *arr has to be told what
 *         the file is afterwards)?
 *   OQ-2  If it goes through the client, what enforces the episode mapping at
 *         import — a category the *arr watches, or an explicit manual import?
 *   OQ-5  Is "last search failed" distinguishable from "never searched" in the
 *         data the API actually returns?
 *   OQ-6  Is the "reason still missing" field derivable from the API, or is it
 *         something helparr infers and must label as inferred?
 *
 * It also measures the three things the gap read itself depends on: whether
 * `wanted/missing` really crashes without an explicit `sortKey` (research.md
 * pitfall 1), whether its undeclared paging parameters actually page
 * (pitfall 2), and what Radarr's whole-library read costs (pitfall 3, NFR1).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT IS READ-ONLY. It issues GETs only. It never posts a command,
 * never pushes a release, never adds a torrent. Nothing here adds, removes or
 * modifies anything in Sonarr, Radarr or the download client.
 *
 * That boundary is also why OQ-1 comes back NARROWED rather than PROVEN: the
 * one thing a read cannot establish is whether a given mechanism imports to the
 * right episode, because that needs a real write and a real download. What this
 * does establish is which mechanisms EXIST on your versions and what each one
 * demands — which is what the plan has to choose between.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It prints no credentials. Download-client settings carry passwords, so only
 * field NAMES are echoed from those payloads, never values. Series, episode and
 * movie titles are truncated: a terminal log should not become an inventory of
 * what the operator is missing.
 *
 * Usage:
 *
 *   SONARR_URL=http://10.0.0.5:8989 SONARR_API_KEY=… \
 *   RADARR_URL=http://10.0.0.5:7878 RADARR_API_KEY=… \
 *     npm run spike:gaps
 *
 * QBIT_URL / QBIT_USER / QBIT_PASS are optional; used for OQ-2's category
 * question. RADARR_* is optional but leaves FR3/NFR1 unmeasured.
 * SPIKE_HISTORY_SAMPLE overrides how many missing episodes get a history read
 * (default 12; each is one request).
 *
 * Exit codes: 0 = spike produced answers, 2 = could not run (missing config,
 * unreachable host, nothing missing to inspect).
 */

const env = (name) => process.env[name]?.trim() || null;

const clip = (s, n = 44) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

/**
 * A GET that reports the failure instead of throwing it away.
 *
 * Several of this spike's questions are answered BY a non-200 — "does
 * `wanted/missing` crash without a sortKey" is one of them — so the status and
 * the body come back as data rather than as an exception. Error bodies from the
 * *arr APIs carry no credentials; the request key is never echoed back.
 */
async function probe(label, baseUrl, apiKey, path, params = {}, timeoutMs = 120_000) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }

  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, detail: String(error?.message ?? error) };
  }

  const text = await response.text().catch(() => '');
  const ms = Date.now() - started;

  if (!response.ok) {
    return { ok: false, status: response.status, ms, bytes: text.length, detail: clip(text, 300) };
  }

  try {
    return { ok: true, status: response.status, ms, bytes: text.length, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, ms, bytes: text.length, detail: 'body was not JSON' };
  }
}

/** A GET that throws — for the calls whose failure means the spike cannot run. */
async function get(label, baseUrl, apiKey, path, params, timeoutMs) {
  const result = await probe(label, baseUrl, apiKey, path, params, timeoutMs);
  if (!result.ok) {
    throw new Error(`${label} ${path} returned HTTP ${result.status}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  return result.body;
}

/**
 * The keys an object actually carries, sorted.
 *
 * OQ-5 and OQ-6 are questions about whether a field EXISTS, and the ecosystem's
 * client libraries carry stale field names (research.md pitfall 7). Enumerating
 * what came back is the only answer that cannot be wrong.
 */
const keysOf = (value) => (value && typeof value === 'object' ? Object.keys(value).sort() : []);

/** Field names that would answer "when was this last searched, and how did it go". */
const SEARCH_STATE_HINTS = /search|lastSearch|grabbed|failed|attempt|rejected|status/i;

async function main() {
  const sonarrUrl = env('SONARR_URL');
  const sonarrKey = env('SONARR_API_KEY');
  const radarrUrl = env('RADARR_URL');
  const radarrKey = env('RADARR_API_KEY');
  const qbitUrl = env('QBIT_URL');
  const historySample = Number(env('SPIKE_HISTORY_SAMPLE') ?? 12);

  if (!sonarrUrl || !sonarrKey) {
    console.error('Set SONARR_URL and SONARR_API_KEY. See the header of this file.');
    process.exit(2);
  }

  const findings = {};

  // ── Versions ──────────────────────────────────────────────────────────────
  section('Versions');
  const sonarrStatus = await get('Sonarr', sonarrUrl, sonarrKey, '/api/v3/system/status');
  console.log(`Sonarr: ${sonarrStatus.version}`);
  findings.sonarrVersion = sonarrStatus.version;

  if (radarrUrl && radarrKey) {
    const radarrStatus = await get('Radarr', radarrUrl, radarrKey, '/api/v3/system/status');
    console.log(`Radarr: ${radarrStatus.version}`);
    findings.radarrVersion = radarrStatus.version;
  } else {
    console.log('Radarr: not configured — FR3 and NFR1 go unmeasured this run.');
  }

  // ── FR2 / AC3: does the sort crash reproduce? ─────────────────────────────
  // research.md pitfall 1 says `wanted/missing` has thrown a fatal
  // NullReferenceException from PagingSpecExtensions when resolving the default
  // sort property. FR2 mandates an explicit sortKey as the mitigation. Whether
  // that mitigation is load-bearing on THIS version is measurable, and worth
  // measuring: a defensive parameter nobody can justify gets dropped later.
  section('wanted/missing without an explicit sortKey (FR2, AC3)');
  const bare = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/wanted/missing', { page: 1, pageSize: 5 });
  if (bare.ok) {
    console.log(`HTTP 200 in ${bare.ms}ms — the default sort does NOT crash on ${sonarrStatus.version}.`);
    console.log('   The explicit sortKey stays anyway: the bug is version-specific and');
    console.log('   the parameter costs nothing. It is a guard, not a workaround.');
    findings.bareSortCrashes = false;
  } else {
    console.log(`HTTP ${bare.status} — ${bare.detail}`);
    console.log('   The crash reproduces. FR2\'s explicit sortKey is load-bearing.');
    findings.bareSortCrashes = true;
  }

  // ── FR2 / AC2: do the undeclared paging parameters actually page? ─────────
  // research.md pitfall 2: page/pageSize work but are not declared in the
  // OpenAPI definition, so generated clients may expose no way to request a
  // page — yielding a silently truncated gap list. helparr uses raw HTTP, so
  // what matters is whether the parameters are honoured at all.
  section('wanted/missing paging (FR2, AC2)');
  const sortKey = 'airDateUtc';
  const page1 = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/wanted/missing', {
    page: 1, pageSize: 5, sortKey, sortDirection: 'descending',
  });

  if (!page1.ok) {
    console.log(`HTTP ${page1.status} — ${page1.detail}`);
    console.log(`   sortKey="${sortKey}" was rejected. Try another key before concluding.`);
    findings.wantedMissing = 'failed';
  } else {
    const envelope = page1.body ?? {};
    console.log(`envelope keys: ${keysOf(envelope).join(', ')}`);
    console.log(`totalRecords:  ${envelope.totalRecords}`);
    console.log(`records/page:  ${envelope.records?.length ?? 0}`);
    findings.missingTotal = envelope.totalRecords ?? 0;

    if ((envelope.totalRecords ?? 0) > 5) {
      const page2 = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/wanted/missing', {
        page: 2, pageSize: 5, sortKey, sortDirection: 'descending',
      });
      const idsOf = (p) => (p.body?.records ?? []).map((r) => r.id).join(',');
      const distinct = page2.ok && idsOf(page1) !== idsOf(page2) && (page2.body?.records?.length ?? 0) > 0;
      console.log(distinct
        ? 'page=2 returned a DIFFERENT record set — paging is honoured, FR2 is implementable.'
        : 'page=2 returned the same records (or none) — paging is NOT honoured; the read needs another strategy.');
      findings.pagingHonoured = distinct;
    } else {
      console.log(`only ${envelope.totalRecords} missing episode(s) — not enough to prove paging.`);
      findings.pagingHonoured = null;
    }

    // ── OQ-5 / OQ-6: what does a missing record actually carry? ─────────────
    // The question is not "what do the docs list" but "what is in the object",
    // because the answer decides whether the screen can distinguish a failed
    // search from one that never ran without a second request per row.
    section('Fields on a missing record (OQ-5, OQ-6)');
    const record = envelope.records?.[0];
    if (!record) {
      console.log('no missing episodes to inspect — OQ-5 and OQ-6 go unanswered.');
      findings.missingRecordKeys = [];
    } else {
      const keys = keysOf(record);
      console.log(`episode keys (${keys.length}): ${keys.join(', ')}`);
      const seriesKeys = keysOf(record.series);
      console.log(`series keys  (${seriesKeys.length}): ${seriesKeys.join(', ')}`);

      const hints = [...keys, ...seriesKeys].filter((k) => SEARCH_STATE_HINTS.test(k));
      console.log(hints.length
        ? `fields that might carry search state: ${hints.join(', ')}`
        : 'NO field on the record carries search state. OQ-5 cannot be answered from this payload —');
      if (!hints.length) {
        console.log('   the distinction needs /history per episode, or it does not exist.');
      }
      findings.missingRecordKeys = keys;
      findings.searchStateHints = hints;

      // FR4 wants source instance, item code, title, air date, wanted quality
      // and target path. Which of those are present here, and which need a join?
      const fr4 = {
        itemCode: record.seasonNumber !== undefined && record.episodeNumber !== undefined,
        airDate: record.airDateUtc !== undefined,
        title: record.title !== undefined,
        seriesTitle: record.series?.title !== undefined,
        targetPath: record.series?.path !== undefined,
      };
      console.log(`FR4 coverage on this payload: ${JSON.stringify(fr4)}`);
      findings.fr4Coverage = fr4;

      // The record carries `seriesId` but no series object, so FR4's series
      // title and target path need a join. Two ways to get it, and the choice
      // is a real cost difference at 357 gaps: ask the endpoint to embed the
      // series per record, or read /series once and join locally.
      const embedded = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/wanted/missing', {
        page: 1, pageSize: 5, sortKey, sortDirection: 'descending', includeSeries: true,
      });
      const withSeries = embedded.ok && keysOf(embedded.body?.records?.[0]?.series).length > 0;
      console.log(`includeSeries=true → ${withSeries ? 'series object IS embedded' : 'no effect'}`
        + ` (${embedded.bytes} bytes vs ${page1.bytes} without, same 5 records)`);
      findings.includeSeriesWorks = withSeries;
      findings.includeSeriesBytes = embedded.bytes;
      findings.bareBytes = page1.bytes;
    }

    // ── OQ-5 continued: does /history distinguish the two states? ───────────
    // A search that found nothing may simply produce no event at all, in which
    // case "failed" and "never searched" are the same row to the API and the
    // prototype's visual distinction is not implementable as drawn.
    section(`Per-episode history for ${historySample} missing episodes (OQ-5)`);
    const sample = (envelope.records ?? []).slice(0, historySample);
    const wide = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/wanted/missing', {
      page: 1, pageSize: Math.max(historySample, 5), sortKey, sortDirection: 'descending',
    });
    const episodes = (wide.ok ? wide.body?.records : sample) ?? sample;

    const eventTypes = new Map();
    let withHistory = 0;
    let withoutHistory = 0;

    for (const episode of episodes.slice(0, historySample)) {
      const history = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/history', {
        episodeId: episode.id, page: 1, pageSize: 20,
      });
      if (!history.ok) {
        console.log(`  episode ${episode.id}: history HTTP ${history.status}`);
        continue;
      }
      const records = history.body?.records ?? [];
      if (records.length === 0) withoutHistory += 1;
      else withHistory += 1;
      for (const entry of records) {
        const type = entry.eventType ?? 'unknown';
        eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
      }
    }

    console.log(`episodes WITH history:    ${withHistory}`);
    console.log(`episodes WITHOUT history: ${withoutHistory}`);
    console.log(`event types seen: ${[...eventTypes.entries()].map(([t, n]) => `${t}×${n}`).join(', ') || 'none'}`);
    findings.historyWith = withHistory;
    findings.historyWithout = withoutHistory;
    findings.historyEventTypes = [...eventTypes.keys()];

    const failureEvents = [...eventTypes.keys()].filter((t) => /fail|ignored/i.test(String(t)));
    console.log(failureEvents.length
      ? `failure-shaped events present (${failureEvents.join(', ')}) — "last search failed" is derivable, at one request per row.`
      : 'NO failure-shaped event appeared. A search that finds nothing seems to leave no trace,');
    if (!failureEvents.length) {
      console.log('   so "failed" and "never searched" are the same state to the API (OQ-5),');
      console.log('   and any "reason still missing" is helparr\'s inference, not the API\'s (OQ-6).');
    }
    findings.failureEventsDerivable = failureEvents.length > 0;
  }

  // ── OQ-1 / OQ-2: which attach mechanisms exist on this Sonarr? ────────────
  // Read-only probes of the two candidate paths. Neither is exercised; what is
  // established is whether each one is THERE, and what it demands.
  section('Attach mechanisms available (OQ-1, OQ-2)');

  // Candidate B: the explicit manual import. `GET /api/v3/manualimport` is the
  // read half of the same surface the ManualImport command writes through; if
  // it answers at all, the command exists on this version.
  const manualImport = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/manualimport', {
    folder: '/nonexistent-helparr-spike-probe',
  });
  console.log(`GET /api/v3/manualimport → HTTP ${manualImport.status}`);
  if (manualImport.status === 404) {
    console.log('   absent on this version — candidate B (client + explicit import) is not available.');
  } else if (manualImport.ok) {
    const rows = Array.isArray(manualImport.body) ? manualImport.body : [];
    console.log(`   present. Answered with ${rows.length} row(s) for a folder that does not exist.`);
    console.log(`   row shape: ${rows[0] ? keysOf(rows[0]).join(', ') : 'n/a (empty, as expected)'}`);
    console.log('   The write half is POST /api/v3/command {name:"ManualImport", files:[…]},');
    console.log('   which maps a file to an episode BY episodeId — no filename parsing (OQ-2).');
  } else {
    console.log(`   ${manualImport.detail}`);
    console.log('   A 4xx that is not 404 still means the route exists and validated the input.');
  }
  findings.manualImportStatus = manualImport.status;

  // Candidate B's other half: does the *arr's own completed-download handling
  // stand between the client and the import? If it is on, a torrent that lands
  // in the *arr's category gets parsed by the *arr on completion — which is the
  // very parse the manual attach exists to bypass.
  const dcConfig = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/config/downloadclient');
  if (dcConfig.ok) {
    const cfg = dcConfig.body ?? {};
    console.log(`completed-download handling: ${cfg.enableCompletedDownloadHandling}`);
    console.log(`config keys: ${keysOf(cfg).join(', ')}`);
    findings.completedDownloadHandling = cfg.enableCompletedDownloadHandling;
    if (cfg.enableCompletedDownloadHandling) {
      console.log('   ON — a torrent dropped into the *arr\'s category will be parsed and imported');
      console.log('   by the *arr itself on completion. Candidate B must either use a category the');
      console.log('   *arr does NOT watch, or accept that it is racing the *arr\'s own parser (OQ-2).');
    }
  }

  // Which categories does the *arr watch? Only names and the category field —
  // download-client settings carry passwords, so no value from this payload is
  // printed beyond the category string itself.
  const clients = await probe('Sonarr', sonarrUrl, sonarrKey, '/api/v3/downloadclient');
  if (clients.ok && Array.isArray(clients.body)) {
    console.log(`download clients registered: ${clients.body.length}`);
    for (const client of clients.body) {
      const fields = Array.isArray(client.fields) ? client.fields : [];
      const category = fields.find((f) => /category/i.test(f.name ?? ''));
      console.log(`  ${clip(client.name, 24)} — ${client.implementation}, enabled=${client.enable}, `
        + `category=${category?.value === '' ? '(none)' : clip(String(category?.value ?? 'n/a'), 24)}`);
      // Field NAMES only. Several of these hold a password.
      console.log(`    settable fields: ${fields.map((f) => f.name).sort().join(', ')}`);
    }
    findings.downloadClientCount = clients.body.length;
  }

  // Candidate A already exists in helparr: ArrClient.pushRelease() posts title +
  // downloadUrl to /release/push. Nothing to probe — it shipped in
  // indexer-search-grab and its behaviour is covered by that change's tests.
  console.log('');
  console.log('Candidate A (/release/push with a title helparr synthesizes) needs no probe —');
  console.log('it already ships as ArrClient.pushRelease(). What a read cannot tell us is');
  console.log('whether Sonarr re-parses the FILE name at import and overrides that mapping.');

  // ── FR3 / NFR1 / OQ-3: what does Radarr's whole-library read cost? ────────
  if (radarrUrl && radarrKey) {
    // research.md reads Radarr #7704 as "there is no missing endpoint", which is
    // why FR3 specifies a whole-library read filtered client-side. That reading
    // predates Radarr 4 and is worth re-testing before paying 1.45 MB to find
    // two gaps: if `wanted/missing` answers here, FR3's mechanism is wrong.
    section('Radarr wanted/missing — does it exist? (FR3, NFR1)');
    const rMissing = await probe('Radarr', radarrUrl, radarrKey, '/api/v3/wanted/missing', {
      page: 1, pageSize: 5, sortKey: 'title', sortDirection: 'ascending',
    });
    if (rMissing.ok) {
      console.log(`HTTP 200 in ${rMissing.ms}ms, ${rMissing.bytes} bytes`);
      console.log(`envelope keys: ${keysOf(rMissing.body).join(', ')}`);
      console.log(`totalRecords:  ${rMissing.body?.totalRecords}`);
      console.log(`record keys:   ${keysOf(rMissing.body?.records?.[0]).join(', ') || '(no records)'}`);
      console.log('   The endpoint EXISTS. FR3 does not need the whole-library read.');
      findings.radarrMissingEndpoint = true;
      findings.radarrMissingTotal = rMissing.body?.totalRecords;
      findings.radarrMissingMs = rMissing.ms;
      findings.radarrMissingBytes = rMissing.bytes;
    } else {
      console.log(`HTTP ${rMissing.status} — ${rMissing.detail}`);
      console.log('   Absent, as research.md read it. FR3\'s whole-library read stands.');
      findings.radarrMissingEndpoint = false;
    }

    section('Radarr whole-library read (FR3, NFR1, OQ-3)');
    const movies = await probe('Radarr', radarrUrl, radarrKey, '/api/v3/movie');
    if (!movies.ok) {
      console.log(`HTTP ${movies.status} — ${movies.detail}`);
    } else {
      const all = Array.isArray(movies.body) ? movies.body : [];
      const gaps = all.filter((m) => m.monitored === true && m.hasFile === false);
      console.log(`movies:        ${all.length}`);
      console.log(`payload:       ${(movies.bytes / 1_000_000).toFixed(2)} MB in ${movies.ms}ms`);
      console.log(`monitored && !hasFile: ${gaps.length}  ← this is the Radarr gap count (FR3)`);
      console.log(`per-movie cost: ${(movies.bytes / Math.max(all.length, 1) / 1024).toFixed(1)} kB`);
      console.log('');
      console.log(`movie keys: ${keysOf(all[0]).join(', ')}`);
      const hints = keysOf(all[0]).filter((k) => SEARCH_STATE_HINTS.test(k));
      console.log(hints.length
        ? `fields that might carry search state: ${hints.join(', ')}`
        : 'no field carries search state on the movie object either (OQ-5).');
      findings.radarrMovies = all.length;
      findings.radarrGaps = gaps.length;
      findings.radarrPayloadMB = Number((movies.bytes / 1_000_000).toFixed(2));
      findings.radarrReadMs = movies.ms;
      findings.radarrSearchStateHints = hints;
    }
  }

  // ── OQ-2: what categories does the client already have? ──────────────────
  if (qbitUrl) {
    section('qBittorrent categories (OQ-2)');
    const user = env('QBIT_USER');
    const pass = env('QBIT_PASS');
    try {
      const form = new URLSearchParams({ username: user ?? '', password: pass ?? '' });
      const auth = await fetch(new URL('/api/v2/auth/login', qbitUrl), {
        method: 'POST',
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(30_000),
      });
      // 5.1 renamed the session cookie to QBT_SID_<port>; read whatever came
      // back rather than a name (see unified-queue-overview's lessons).
      const cookie = (auth.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      const categories = await fetch(new URL('/api/v2/torrents/categories', qbitUrl), {
        headers: cookie ? { Cookie: cookie } : {},
        signal: AbortSignal.timeout(30_000),
      });
      const parsed = await categories.json().catch(() => ({}));
      const names = Object.keys(parsed);
      console.log(`categories: ${names.length ? names.join(', ') : '(none)'}`);
      console.log('Candidate B would need one the *arr does NOT watch, plus the write half of');
      console.log('QbitClient — which today is read-only (torrents() and nothing else).');
      findings.qbitCategories = names;
    } catch (error) {
      console.log(`could not read categories — ${String(error?.message ?? error)}`);
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  section('What this settles');
  const lines = [];

  lines.push(findings.bareSortCrashes
    ? 'FR2  the sort crash REPRODUCES — the explicit sortKey is load-bearing.'
    : 'FR2  the sort crash does not reproduce here; the explicit sortKey stays as a guard.');

  if (findings.pagingHonoured === true) lines.push('AC2  paging is honoured — the complete read is implementable as specified.');
  else if (findings.pagingHonoured === false) lines.push('AC2  paging is NOT honoured — FR2 needs a different read strategy.');
  else lines.push('AC2  too few missing episodes to prove paging; re-run against a fuller library.');

  lines.push(findings.failureEventsDerivable
    ? 'OQ-5 derivable from /history, at one request per row — decide if that cost is worth it.'
    : 'OQ-5 NOT derivable — "failed" and "never searched" are one state. The prototype\'s'
      + '\n     visual distinction cannot ship as drawn.');

  lines.push(findings.failureEventsDerivable
    ? 'OQ-6 partly derivable; anything beyond the history events is inference and must say so.'
    : 'OQ-6 inference. Whatever the screen says about "why" must be labelled as helparr\'s'
      + '\n     reading, not the API\'s answer.');

  if (findings.manualImportStatus === 404) {
    lines.push('OQ-1 candidate B unavailable on this version — the attach goes through the *arr.');
  } else {
    lines.push('OQ-1 both mechanisms exist. A read cannot rank them: what decides it is whether');
    lines.push('     Sonarr re-parses the file name at import, which needs a real download.');
    lines.push('OQ-2 the mapping is enforced by episodeId through the ManualImport command,');
    lines.push('     not by a category — categories only decide WHO parses the file.');
  }

  if (findings.radarrMovies !== undefined) {
    lines.push(`OQ-3 Radarr's read is ${findings.radarrPayloadMB} MB / ${findings.radarrReadMs}ms for `
      + `${findings.radarrMovies} movies — ${findings.radarrGaps} gaps.`);
  }

  for (const line of lines) console.log(line);

  console.log('');
  console.log('findings (JSON):');
  console.log(JSON.stringify(findings, null, 2));
}

main().catch((error) => {
  console.error('');
  console.error(`INCONCLUSIVE — ${error.message}`);
  process.exit(2);
});
