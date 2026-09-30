#!/usr/bin/env node
/**
 * stuck-item-triage / OQ-5, OQ-6, OQ-7, OQ-8 — spike manual import, custom
 * format detail and unmapped folders against live Sonarr and Radarr.
 *
 * Four questions the proposal could not answer from documentation:
 *
 *   OQ-5  Does `/api/v3/manualimport` take a `downloadId` on the same terms on
 *         both instances, and what does a candidate row carry? What shape does
 *         a past `ManualImport` command record show for its payload?
 *   OQ-6  Do release, queue, file and import-candidate records carry the list
 *         of matched custom formats, or only a total score? And does the sum of
 *         the quality profile's per-format scores over that list reproduce the
 *         instance's own total — i.e. is a per-format breakdown a JOIN helparr
 *         can label as its arithmetic, rather than a re-implementation of the
 *         format evaluator?
 *   OQ-7  Does Sonarr populate `unmappedFolders` on `/api/v3/rootfolder`, or is
 *         it Radarr-only? How often is the key absent rather than empty?
 *   OQ-8  Which `trackedDownloadState` values does a completed-but-unimported
 *         record carry, and which of them are transient? The queue is read twice,
 *         SPIKE_RESAMPLE_SECONDS apart (default 70 — longer than the *arr's
 *         one-minute ProcessMonitoredDownloads cycle), and state changes between
 *         the two reads are reported.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT IS READ-ONLY. It issues GETs only (plus the qBittorrent login
 * POST, which creates a session and nothing else). It never posts a command,
 * never imports, never removes, never blocklists. Nothing here adds, removes or
 * modifies anything in Sonarr, Radarr or the download client.
 *
 * That boundary is why OQ-5 comes back NARROWED rather than PROVEN for the
 * write half: whether a `ManualImport` command with a given payload is accepted
 * can only be established by importing a real file. What this establishes is
 * the candidate shape both instances return and, where one ran recently, the
 * payload a past ManualImport command carried.
 *
 * `GET /api/v3/release` runs one interactive search per instance, against an
 * item that already has a file — the same read `spike:grab` makes. It queries
 * the operator's indexers and grabs nothing. SPIKE_SKIP_RELEASE=1 skips it.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It prints no credentials and no API keys. Paths are basenamed and folder names
 * are counted, not listed: a terminal log should not become an inventory of the
 * operator's library.
 *
 * Usage:
 *
 *   npm run spike:import
 *
 * Credentials come from `~/.helparr-verify.env`, like the other spikes; point
 * `SPIKE_ENV_FILE` elsewhere to use a different one. Anything already exported
 * in the shell wins over the file. QBIT_URL / QBIT_USER / QBIT_PASS are optional
 * and supply OQ-8's client-side evidence.
 *
 * SPIKE_CANDIDATE_SAMPLE caps the manualimport reads per instance (default 5;
 * each is one request). SPIKE_RESAMPLE_SECONDS=0 skips the second queue read.
 *
 * Exit codes: 0 = spike produced answers, 2 = could not run (missing config,
 * unreachable host).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const env = (name) => process.env[name]?.trim() || null;

const ENV_FILE = resolve(process.env.SPIKE_ENV_FILE?.trim() || `${homedir()}/.helparr-verify.env`);

/** Same loader as spike:rename — returns the key names it applied, never the values. */
function loadEnvFile(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    return { found: false, reason: error?.code === 'ENOENT' ? 'not found' : String(error?.message ?? error) };
  }

  const applied = [];
  for (const line of contents.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value === '') continue;
    if (process.env[key]?.trim()) continue;

    process.env[key] = value;
    applied.push(key);
  }
  return { found: true, applied };
}

const envFile = loadEnvFile(ENV_FILE);

const CANDIDATE_SAMPLE = Number(env('SPIKE_CANDIDATE_SAMPLE') ?? 5);
const RESAMPLE_SECONDS = Number(env('SPIKE_RESAMPLE_SECONDS') ?? 70);

const clip = (s, n = 44) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const basename = (p) => (typeof p === 'string' ? clip(p.split('/').pop() ?? '', 58) : '');

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

const tally = (items) => {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ') || 'none';
};

/** A GET that returns status and body as data — a 404 on one version is an answer. */
async function probe(baseUrl, apiKey, path, params = {}, timeoutMs = 120_000) {
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
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
  if (!response.ok) return { ok: false, status: response.status, ms, detail: clip(text, 300) };
  if (text.trim() === '') return { ok: true, status: response.status, ms, body: null, empty: true };
  try {
    return { ok: true, status: response.status, ms, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, ms, detail: 'body was not JSON' };
  }
}

function printKeys(label, rows) {
  const keys = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      const seen = keys.get(k) ?? { count: 0, types: new Set() };
      seen.count += 1;
      seen.types.add(Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
      keys.set(k, seen);
    }
  }
  if (keys.size === 0) {
    console.log(`  ${label}: no rows to inspect`);
    return keys;
  }
  console.log(`  ${label} — ${rows.length} row(s), ${keys.size} key(s):`);
  for (const [k, info] of [...keys.entries()].sort()) {
    console.log(`    ${k.padEnd(26)} ${[...info.types].join('|').padEnd(16)} ${info.count}/${rows.length}`);
  }
  return keys;
}

/** What a `customFormats` entry carries: id+name only, or the whole specification. */
function describeFormatEntries(label, rows) {
  const entries = rows.flatMap((r) => (Array.isArray(r?.customFormats) ? r.customFormats : []));
  const withList = rows.filter((r) => Array.isArray(r?.customFormats)).length;
  const withScore = rows.filter((r) => typeof r?.customFormatScore === 'number').length;
  console.log(
    `  ${label}: customFormats list on ${withList}/${rows.length}, customFormatScore on ${withScore}/${rows.length}, ${entries.length} matched entries`,
  );
  if (entries.length) {
    const keys = [...new Set(entries.flatMap((e) => Object.keys(e ?? {})))].sort();
    console.log(`    entry keys: ${keys.join(', ')}`);
  }
  return { withList, withScore, entries: entries.length };
}

/**
 * OQ-6's decisive check. Sum the profile's score for every matched format and
 * compare to the instance's own total. Agreement means the breakdown is a join;
 * disagreement means it is not, and the plan has to say so.
 */
function reconcileScores(rows, profilesById, profileIdOf) {
  let agree = 0;
  let disagree = 0;
  let skipped = 0;
  const misses = [];
  for (const row of rows) {
    if (!Array.isArray(row?.customFormats) || typeof row?.customFormatScore !== 'number') {
      skipped += 1;
      continue;
    }
    const profile = profilesById.get(profileIdOf(row));
    if (!profile) {
      skipped += 1;
      continue;
    }
    const scores = new Map((profile.formatItems ?? []).map((f) => [f.format, f.score]));
    const sum = row.customFormats.reduce((acc, cf) => acc + (scores.get(cf.id) ?? 0), 0);
    if (sum === row.customFormatScore) agree += 1;
    else {
      disagree += 1;
      if (misses.length < 3) misses.push(`reported ${row.customFormatScore}, joined ${sum}`);
    }
  }
  return { agree, disagree, skipped, misses };
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function readQueue(kind, baseUrl, apiKey) {
  const isSonarr = kind === 'sonarr';
  return probe(baseUrl, apiKey, 'api/v3/queue', {
    page: 1,
    pageSize: 500,
    [isSonarr ? 'includeUnknownSeriesItems' : 'includeUnknownMovieItems']: true,
    [isSonarr ? 'includeSeries' : 'includeMovie']: true,
  });
}

async function spikeArr(kind, baseUrl, apiKey, qbit) {
  const isSonarr = kind === 'sonarr';
  const K = kind.toUpperCase();
  const findings = { kind, reachable: false };

  section(`${K} — reachability and version`);
  const status = await probe(baseUrl, apiKey, 'api/v3/system/status');
  if (!status.ok) {
    console.log(`  ✗ system/status HTTP ${status.status} — ${status.detail}`);
    return findings;
  }
  findings.reachable = true;
  findings.version = status.body?.version;
  console.log(`  version ${findings.version}  (${status.ms}ms)`);

  /* ── OQ-7: root folders ───────────────────────────────────────────────── */
  section(`${K} — GET /api/v3/rootfolder (OQ-7, FR19, FR20)`);
  const roots = await probe(baseUrl, apiKey, 'api/v3/rootfolder');
  if (roots.ok && Array.isArray(roots.body)) {
    console.log(`  ${roots.body.length} root folder(s)  (${roots.ms}ms)`);
    printKeys('root folder shape', roots.body);
    findings.rootFolders = roots.body.map((r) => ({
      hasKey: Object.prototype.hasOwnProperty.call(r, 'unmappedFolders'),
      count: Array.isArray(r.unmappedFolders) ? r.unmappedFolders.length : null,
      accessible: r.accessible,
      hasFreeSpace: typeof r.freeSpace === 'number',
    }));
    for (const [i, r] of findings.rootFolders.entries()) {
      console.log(
        `    root #${i + 1}: unmappedFolders ${r.hasKey ? `present, ${r.count} folder(s)` : 'KEY ABSENT'}` +
          `, accessible=${r.accessible}, freeSpace ${r.hasFreeSpace ? 'present' : 'ABSENT'}`,
      );
    }
    const entryKeys = [
      ...new Set(roots.body.flatMap((r) => (r.unmappedFolders ?? []).flatMap((u) => Object.keys(u ?? {})))),
    ].sort();
    if (entryKeys.length) console.log(`  unmapped folder entry keys: ${entryKeys.join(', ')}`);
    findings.unmappedEntryKeys = entryKeys;
    findings.unmappedPaths = roots.body.flatMap((r) => (r.unmappedFolders ?? []).map((u) => u.path)).filter(Boolean);
  } else {
    console.log(`  ✗ rootfolder HTTP ${roots.status} — ${roots.detail ?? 'unexpected body'}`);
  }

  /* ── OQ-6 prerequisites: definitions and profiles ────────────────────── */
  section(`${K} — custom formats and quality profiles (OQ-6, FR13, FR14, FR18)`);
  const formats = await probe(baseUrl, apiKey, 'api/v3/customformat');
  const profiles = await probe(baseUrl, apiKey, 'api/v3/qualityprofile');
  const profilesById = new Map();
  if (formats.ok && Array.isArray(formats.body)) {
    const bytes = JSON.stringify(formats.body).length;
    console.log(`  ${formats.body.length} custom format definition(s)  (${formats.ms}ms, ${bytes} bytes)`);
  } else {
    console.log(`  ✗ customformat HTTP ${formats.status} — ${formats.detail ?? 'unexpected body'}`);
  }
  if (profiles.ok && Array.isArray(profiles.body)) {
    console.log(`  ${profiles.body.length} quality profile(s)  (${profiles.ms}ms)`);
    for (const p of profiles.body) profilesById.set(p.id, p);
    const top = Object.keys(profiles.body[0] ?? {}).sort();
    console.log(`  profile keys: ${top.join(', ')}`);
    const scored = profiles.body.filter((p) => (p.formatItems ?? []).some((f) => f.score !== 0)).length;
    console.log(`  profiles with any non-zero format score: ${scored}/${profiles.body.length}`);
    const fi = profiles.body[0]?.formatItems?.[0];
    if (fi) console.log(`  formatItems entry keys: ${Object.keys(fi).sort().join(', ')}`);
  } else {
    console.log(`  ✗ qualityprofile HTTP ${profiles.status} — ${profiles.detail ?? 'unexpected body'}`);
  }

  /* ── OQ-8: the queue, and what the client says about each record ─────── */
  section(`${K} — GET /api/v3/queue (OQ-8, FR1, FR2)`);
  const queue = await readQueue(kind, baseUrl, apiKey);
  const records = queue.ok && Array.isArray(queue.body?.records) ? queue.body.records : [];
  if (!queue.ok) console.log(`  ✗ queue HTTP ${queue.status} — ${queue.detail ?? 'unexpected body'}`);
  console.log(`  ${records.length} record(s)  (${queue.ms}ms)`);
  console.log(`  status:                ${tally(records.map((r) => r.status))}`);
  console.log(`  trackedDownloadStatus: ${tally(records.map((r) => r.trackedDownloadStatus))}`);
  console.log(`  trackedDownloadState:  ${tally(records.map((r) => r.trackedDownloadState))}`);
  console.log(`  protocol:              ${tally(records.map((r) => r.protocol))}`);
  findings.states = [...new Set(records.map((r) => r.trackedDownloadState))];
  describeFormatEntries('queue records', records);

  const importish = records.filter((r) => /^import/i.test(String(r.trackedDownloadState ?? '')));
  console.log('');
  console.log(`  import* states: ${importish.length} record(s)`);
  for (const r of importish.slice(0, 8)) {
    const torrent = qbit?.byHash.get(String(r.downloadId ?? '').toLowerCase());
    const messages = (r.statusMessages ?? []).flatMap((m) => m.messages ?? []);
    const done = torrent?.completion_on > 0 ? `${Math.round((Date.now() / 1000 - torrent.completion_on) / 60)}m ago` : 'n/a';
    console.log(
      `    ${String(r.trackedDownloadState).padEnd(14)} status=${r.status} tds=${r.trackedDownloadStatus}` +
        ` client=${torrent ? `${torrent.state} ${(torrent.progress * 100).toFixed(0)}% completed ${done}` : 'not found in qBittorrent'}`,
    );
    for (const m of messages.slice(0, 2)) console.log(`      “${clip(m, 90)}”`);
  }
  if (importish.length) printKeys('statusMessages entry', importish.flatMap((r) => r.statusMessages ?? []));

  // A completed download the *arr still calls `downloading` would be a gap in
  // any state-only rule. Surface it rather than assume it cannot happen.
  if (qbit) {
    const finishedButDownloading = records.filter((r) => {
      const t = qbit.byHash.get(String(r.downloadId ?? '').toLowerCase());
      return t && t.progress >= 1 && String(r.trackedDownloadState).toLowerCase() === 'downloading';
    });
    console.log(`  client 100% but *arr state still 'downloading': ${finishedButDownloading.length}`);
    const missing = records.filter((r) => r.protocol === 'torrent' && !qbit.byHash.has(String(r.downloadId ?? '').toLowerCase()));
    console.log(`  torrent records with no matching torrent in the client (payload missing): ${missing.length}`);
    findings.payloadMissing = missing.length;
  }

  /* ── OQ-5: import candidates ─────────────────────────────────────────── */
  section(`${K} — GET /api/v3/manualimport?downloadId= (OQ-5, FR6, FR11)`);
  // Prefer the records force import is for; fall back to any completed record
  // so the candidate shape is still observed on an instance with a clean queue.
  const targets = [
    ...importish,
    ...records.filter((r) => !importish.includes(r) && (r.sizeleft === 0 || r.status === 'completed')),
    ...records.filter((r) => !importish.includes(r) && r.sizeleft !== 0 && r.status !== 'completed'),
  ]
    .filter((r) => r.downloadId)
    .slice(0, Math.max(1, CANDIDATE_SAMPLE));

  const candidates = [];
  for (const r of targets) {
    const result = await probe(baseUrl, apiKey, 'api/v3/manualimport', { downloadId: r.downloadId, filterExistingFiles: false });
    if (!result.ok) {
      console.log(`  ✗ ${String(r.trackedDownloadState).padEnd(12)} HTTP ${result.status} — ${result.detail}`);
      continue;
    }
    const rows = Array.isArray(result.body) ? result.body : [];
    console.log(`  ${String(r.trackedDownloadState).padEnd(12)} → ${rows.length} candidate(s)  (${result.ms}ms)`);
    for (const c of rows.slice(0, 3)) {
      const mapped = isSonarr
        ? `series=${c.series ? 'resolved' : 'NONE'} episodes=${(c.episodes ?? []).length}`
        : `movie=${c.movie ? 'resolved' : 'NONE'}`;
      const rejections = (c.rejections ?? []).map((x) => `${x.type ?? '?'}: ${clip(x.reason, 60)}`);
      console.log(`      ${basename(c.path)}  ${mapped}  cfScore=${c.customFormatScore ?? '—'}`);
      for (const x of rejections.slice(0, 2)) console.log(`        rejection ${x}`);
    }
    candidates.push(...rows);
  }
  if (targets.length === 0) console.log('  no queue record carries a downloadId');

  // An empty queue leaves the candidate shape unobserved. The same endpoint
  // takes `folder=` — what the *arr's own Manual Import page sends for a folder
  // on disk — so read one unmapped folder instead. Still a GET.
  const unmappedPath = findings.unmappedPaths?.[0];
  if (candidates.length === 0 && unmappedPath) {
    const byFolder = await probe(baseUrl, apiKey, 'api/v3/manualimport', { folder: unmappedPath, filterExistingFiles: false });
    const rows = byFolder.ok && Array.isArray(byFolder.body) ? byFolder.body : [];
    console.log(`  fallback folder= (one unmapped folder) → ${byFolder.ok ? `${rows.length} candidate(s)` : `HTTP ${byFolder.status}`}  (${byFolder.ms}ms)`);
    for (const c of rows.slice(0, 3)) {
      const mapped = isSonarr ? `series=${c.series ? 'resolved' : 'NONE'}` : `movie=${c.movie ? 'resolved' : 'NONE'}`;
      console.log(`      ${basename(c.path)}  ${mapped}  cfScore=${c.customFormatScore ?? '—'}`);
      for (const x of (c.rejections ?? []).slice(0, 2)) console.log(`        rejection ${x.type ?? '?'}: ${clip(x.reason, 60)}`);
    }
    candidates.push(...rows);

    // And whether `downloadId` is accepted at all when nothing is tracked.
    const hash = qbit ? [...qbit.byHash.keys()][0] : null;
    if (hash) {
      const byId = await probe(baseUrl, apiKey, 'api/v3/manualimport', { downloadId: hash.toUpperCase() });
      console.log(`  downloadId= for an untracked torrent → HTTP ${byId.status}, ${Array.isArray(byId.body) ? `${byId.body.length} row(s)` : clip(byId.detail, 80)}`);
    }
  }

  const candidateKeys = printKeys('candidate shape', candidates.slice(0, 50));
  findings.candidateKeys = [...candidateKeys.keys()];
  if (candidates.length) {
    printKeys('rejection entry', candidates.flatMap((c) => c.rejections ?? []).slice(0, 50));
    describeFormatEntries('candidates', candidates);
  }
  findings.candidates = candidates.length;

  /* ── OQ-5's write half: what a past ManualImport looked like ─────────── */
  section(`${K} — recent command records (OQ-5 payload shape)`);
  const commands = await probe(baseUrl, apiKey, 'api/v3/command');
  if (commands.ok && Array.isArray(commands.body)) {
    const cmds = commands.body;
    console.log(`  ${cmds.length} command record(s); names: ${tally(cmds.map((c) => c.name))}`);
    const manual = cmds.filter((c) => c.name === 'ManualImport');
    findings.pastManualImport = manual.length > 0;
    if (manual.length) {
      const c = manual[0];
      console.log(`  ManualImport seen: status=${c.status} result=${c.result}`);
      console.log(`    body keys: ${Object.keys(c.body ?? {}).sort().join(', ')}`);
      console.log(`    importMode: ${c.body?.importMode ?? '—'}`);
      printKeys('files[] entry', c.body?.files ?? []);
      for (const [k, v] of Object.entries(c.body?.files?.[0] ?? {})) {
        // Shape only: nested objects by their keys, scalars by their type.
        const shape = Array.isArray(v)
          ? `array of ${v.length ? (typeof v[0] === 'object' ? `{${Object.keys(v[0] ?? {}).join(', ')}}` : typeof v[0]) : '(empty)'}`
          : v && typeof v === 'object'
            ? `{${Object.keys(v).join(', ')}}`
            : typeof v;
        console.log(`      ${k.padEnd(20)} ${clip(shape, 80)}`);
      }
      console.log(`    statusMessages / message: ${clip(JSON.stringify(c.message ?? c.statusMessages ?? null), 120)}`);
    } else {
      console.log(`  no ManualImport in the visible window — the payload shape stays unobserved here.`);
    }
  } else {
    console.log(`  ✗ command HTTP ${commands.status} — ${commands.detail ?? 'unexpected body'}`);
  }

  /* ── OQ-6: files on disk carry their formats? and do they reconcile? ── */
  section(`${K} — file records and score reconciliation (OQ-6, FR13, FR15)`);
  const titlePath = isSonarr ? 'api/v3/series' : 'api/v3/movie';
  const titles = await probe(baseUrl, apiKey, titlePath);
  const withFile = (titles.ok && Array.isArray(titles.body) ? titles.body : []).filter((t) =>
    isSonarr ? (t.statistics?.episodeFileCount ?? 0) > 0 : Boolean(t.hasFile),
  );
  const profileOfTitle = new Map(withFile.map((t) => [t.id, t.qualityProfileId]));
  const sampleTitles = withFile.slice(0, 5);
  const files = [];
  for (const t of sampleTitles) {
    const r = await probe(baseUrl, apiKey, isSonarr ? 'api/v3/episodefile' : 'api/v3/moviefile', {
      [isSonarr ? 'seriesId' : 'movieId']: t.id,
    });
    if (r.ok && Array.isArray(r.body)) files.push(...r.body.slice(0, 10).map((f) => ({ ...f, _titleId: t.id })));
  }
  describeFormatEntries('file records', files);
  const fileRecon = reconcileScores(files, profilesById, (f) => profileOfTitle.get(f._titleId));
  console.log(
    `  profile-join vs reported total: ${fileRecon.agree} agree, ${fileRecon.disagree} disagree, ${fileRecon.skipped} not checkable`,
  );
  for (const m of fileRecon.misses) console.log(`    mismatch: ${m}`);
  findings.fileRecon = fileRecon;

  const queueRecon = reconcileScores(records, profilesById, (r) =>
    isSonarr ? r.series?.qualityProfileId : r.movie?.qualityProfileId,
  );
  console.log(
    `  queue records:  ${queueRecon.agree} agree, ${queueRecon.disagree} disagree, ${queueRecon.skipped} not checkable`,
  );
  findings.queueRecon = queueRecon;

  /* ── OQ-6: the release side, one interactive search ──────────────────── */
  section(`${K} — GET /api/v3/release, one item with a file (OQ-6, FR12)`);
  if (env('SPIKE_SKIP_RELEASE')) {
    console.log('  skipped (SPIKE_SKIP_RELEASE set)');
  } else {
    let params = null;
    let profileId = null;
    if (isSonarr) {
      const series = sampleTitles[0];
      const episodes = series ? await probe(baseUrl, apiKey, 'api/v3/episode', { seriesId: series.id }) : null;
      const ep = (episodes?.body ?? []).find((e) => e.hasFile);
      if (ep) params = { episodeId: ep.id };
      profileId = series?.qualityProfileId;
    } else if (sampleTitles[0]) {
      params = { movieId: sampleTitles[0].id };
      profileId = sampleTitles[0].qualityProfileId;
    }

    if (!params) {
      console.log('  no item with a file to search against');
    } else {
      console.log('  searching (queries your indexers; grabs nothing)…');
      const releases = await probe(baseUrl, apiKey, 'api/v3/release', params, 180_000);
      if (releases.ok && Array.isArray(releases.body)) {
        const rows = releases.body;
        console.log(`  ${rows.length} release(s)  (${releases.ms}ms)`);
        describeFormatEntries('releases', rows);
        const recon = reconcileScores(rows, profilesById, () => profileId);
        console.log(`  profile-join vs reported total: ${recon.agree} agree, ${recon.disagree} disagree, ${recon.skipped} not checkable`);
        for (const m of recon.misses) console.log(`    mismatch: ${m}`);
        findings.releaseRecon = recon;
        const reasons = rows.flatMap((r) => r.rejections ?? []).map((x) => (typeof x === 'string' ? x : x.reason));
        const fileReasons = reasons.filter((x) => /existing file|cutoff|custom format score/i.test(String(x)));
        console.log(`  rejection entry type: ${tally(rows.flatMap((r) => r.rejections ?? []).map((x) => typeof x))}`);
        console.log(`  existing-file / score rejections: ${fileReasons.length} of ${reasons.length}`);
        for (const x of [...new Set(fileReasons)].slice(0, 4)) console.log(`    “${clip(String(x), 100)}”`);
      } else {
        console.log(`  ✗ release HTTP ${releases.status} — ${releases.detail ?? 'unexpected body'}`);
      }
    }
  }

  findings.queueSnapshot = new Map(records.map((r) => [r.id, r.trackedDownloadState]));
  return findings;
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function readQbit() {
  const url = env('QBIT_URL');
  if (!url) return null;
  try {
    const form = new URLSearchParams({ username: env('QBIT_USER') ?? '', password: env('QBIT_PASS') ?? '' });
    const auth = await fetch(new URL('/api/v2/auth/login', url), {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(30_000),
    });
    // 5.1 renamed the session cookie to QBT_SID_<port>; read whatever came back.
    const cookie = (auth.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const info = await fetch(new URL('/api/v2/torrents/info', url), {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(30_000),
    });
    const torrents = await info.json();
    return { byHash: new Map(torrents.map((t) => [String(t.hash).toLowerCase(), t])), count: torrents.length };
  } catch (error) {
    console.log(`  qBittorrent unreadable — ${String(error?.message ?? error)}`);
    return null;
  }
}

async function main() {
  const instances = [
    ['sonarr', env('SONARR_URL'), env('SONARR_API_KEY')],
    ['radarr', env('RADARR_URL'), env('RADARR_API_KEY')],
  ].filter(([, url, key]) => url && key);

  if (instances.length === 0) {
    console.error('SONARR_URL/SONARR_API_KEY or RADARR_URL/RADARR_API_KEY are required.');
    console.error(envFile.found ? `  ${ENV_FILE} was read but does not set them.` : `  ${ENV_FILE} — ${envFile.reason}.`);
    process.exit(2);
  }

  console.log('');
  console.log('stuck-item-triage spike — READ-ONLY (GETs only, no command is ever posted)');
  console.log(
    envFile.found
      ? `env file: ${ENV_FILE} → ${envFile.applied.length ? envFile.applied.join(', ') : 'nothing new'}`
      : `env file: ${ENV_FILE} — ${envFile.reason}; using the shell environment`,
  );

  section('qBittorrent — torrent list (OQ-8 client evidence)');
  const qbit = await readQbit();
  console.log(qbit ? `  ${qbit.count} torrent(s)` : '  not configured or unreadable — OQ-8 runs on *arr evidence alone');

  const results = [];
  for (const [kind, url, key] of instances) results.push(await spikeArr(kind, url, key, qbit));

  /* ── OQ-8: does anything move between two reads? ─────────────────────── */
  if (RESAMPLE_SECONDS > 0) {
    section(`queue re-read after ${RESAMPLE_SECONDS}s (OQ-8 transience)`);
    await new Promise((r) => setTimeout(r, RESAMPLE_SECONDS * 1000));
    for (const [i, [kind, url, key]] of instances.entries()) {
      const before = results[i].queueSnapshot;
      if (!before) continue;
      const again = await readQueue(kind, url, key);
      const after = new Map((again.body?.records ?? []).map((r) => [r.id, r.trackedDownloadState]));
      const moved = [];
      for (const [id, state] of before) {
        const now = after.has(id) ? after.get(id) : '(gone)';
        if (now !== state) moved.push(`${state} → ${now}`);
      }
      const stayed = [...before.entries()].filter(([id, s]) => /^import/i.test(String(s)) && after.get(id) === s);
      console.log(`  ${kind}: ${moved.length} record(s) changed state — ${tally(moved)}`);
      console.log(`  ${kind}: import* records unchanged across the window: ${tally(stayed.map(([, s]) => s))}`);
    }
  }

  section('VERDICT');
  for (const r of results) {
    if (!r.reachable) {
      console.log(`  ${r.kind}: unreachable`);
      continue;
    }
    const roots = r.rootFolders ?? [];
    console.log(`  ${r.kind} ${r.version}`);
    console.log(
      `    OQ-7 unmappedFolders: ${roots.filter((x) => x.hasKey).length}/${roots.length} root(s) carry the key` +
        ` (${roots.filter((x) => !x.hasKey).length} absent)`,
    );
    console.log(`    OQ-5 candidates observed: ${r.candidates}; past ManualImport command seen: ${r.pastManualImport ? 'yes' : 'no'}`);
    const fmt = (x) => (x ? `${x.agree} agree / ${x.disagree} disagree` : 'unmeasured');
    console.log(`    OQ-6 profile-join reconciles: files ${fmt(r.fileRecon)}, queue ${fmt(r.queueRecon)}, releases ${fmt(r.releaseRecon)}`);
    console.log(`    OQ-8 states seen: ${r.states?.join(', ') || 'none'}`);
  }
  console.log('');
  console.log('  Not established by a read-only spike: that a ManualImport command with');
  console.log('  the observed candidate shape is accepted. That needs one real import.');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error(`spike failed: ${error?.message ?? error}`);
  process.exit(2);
});
