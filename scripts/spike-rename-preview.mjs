#!/usr/bin/env node
/**
 * bulk-rename-preview / OQ-5, OQ-6 — spike the rename preview and the command
 * semantics against live Sonarr and Radarr.
 *
 * Two questions the proposal could not answer from documentation:
 *
 *   OQ-5  Does execution use `RenameFiles` with explicit file IDs (precise,
 *         honours per-row exclusions) or `RenameSeries`/`RenameMovie` with
 *         title IDs (fewer calls, but renames everything pending for that
 *         title, ignoring exclusions)? research.md says only `RenameFiles`
 *         can honour FR7 — this checks that the preview actually hands us the
 *         file IDs that command needs, on these versions.
 *   OQ-6  How does helparr observe per-file outcomes, given the command
 *         endpoint is asynchronous — poll the command status, re-run the
 *         preview and diff, or read them back out of history?
 *
 * It also measures what the plan has to size for: how long one preview call
 * takes, how many files a realistic scope yields (NFR4, NFR5), and whether
 * the preview carries the upstream warning FR6 promises to flag — that last
 * one is load-bearing, because FR6 is unimplementable if no such field exists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT IS READ-ONLY. It issues GETs only. It never posts a command,
 * never triggers a rescan, never renames anything. Nothing here adds, removes
 * or modifies anything in Sonarr or Radarr.
 *
 * That boundary is why OQ-5 comes back NARROWED rather than PROVEN: whether
 * `RenameFiles` honours an explicit file-ID list can only be established by
 * renaming a real file. What this establishes is whether the IDs that command
 * requires are present in the preview at all, and what the command and history
 * records of a PAST rename look like on your instances — which is what OQ-6
 * needs and what the plan has to choose between.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It prints no credentials and no API keys. Series, movie and file paths are
 * truncated and basenamed: a terminal log should not become an inventory of
 * the operator's library.
 *
 * Usage:
 *
 *   npm run spike:rename
 *
 * Credentials come from `~/.helparr-verify.env` — the same file the other
 * spikes use, kept outside the repo on purpose. Point `SPIKE_ENV_FILE`
 * elsewhere to use a different one. Anything already exported in the shell
 * wins over the file, so a single instance can still be overridden inline:
 *
 *   SONARR_URL=http://10.0.0.5:8989 npm run spike:rename
 *
 * RADARR_* is optional but leaves the movie half of FR1/FR2 unmeasured.
 * SPIKE_TITLE_SAMPLE overrides how many titles get a preview read
 * (default 25; each is one request).
 *
 * Exit codes: 0 = spike produced answers, 2 = could not run (missing config,
 * unreachable host).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const env = (name) => process.env[name]?.trim() || null;

const ENV_FILE = resolve(process.env.SPIKE_ENV_FILE?.trim() || `${homedir()}/.helparr-verify.env`);

/**
 * Load the out-of-repo credentials file.
 *
 * An already-exported variable wins, so the file is a default rather than an
 * override — that keeps `SONARR_URL=… npm run spike:rename` working for a
 * one-off against a different host. Returns the key names it supplied, never
 * the values: this function's whole job is handling secrets, and the caller
 * only ever prints the names.
 */
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
    if (!match) continue; // blank lines and `#` comments

    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value === '') continue;
    if (process.env[key]?.trim()) continue; // the shell already set it

    process.env[key] = value;
    applied.push(key);
  }
  return { found: true, applied };
}

const envFile = loadEnvFile(ENV_FILE);

const TITLE_SAMPLE = Number(env('SPIKE_TITLE_SAMPLE') ?? 25);

const clip = (s, n = 44) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

/** Paths are the payload here, but the library is not the spike's business. */
const basename = (p) => (typeof p === 'string' ? clip(p.split('/').pop() ?? '', 58) : '');

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a');

/**
 * A GET that reports the failure instead of throwing it away.
 *
 * An empty 200 from `/rename` is an ANSWER here (FR5 — nothing pending), and
 * so is a 404 on an endpoint a given version does not have, so status and body
 * come back as data rather than as an exception. Error bodies from the *arr
 * APIs carry no credentials; the request key is never echoed back.
 */
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

  if (!response.ok) {
    return { ok: false, status: response.status, ms, bytes: text.length, detail: clip(text, 300) };
  }
  if (text.trim() === '') {
    return { ok: true, status: response.status, ms, bytes: 0, body: null, empty: true };
  }
  try {
    return { ok: true, status: response.status, ms, bytes: text.length, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, ms, bytes: text.length, detail: 'body was not JSON' };
  }
}

/** Report every key present across a sample, so a missing FR6 field is visible. */
function keyUnion(rows) {
  const keys = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      const seen = keys.get(k) ?? { count: 0, types: new Set(), sample: undefined };
      seen.count += 1;
      seen.types.add(Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
      if (seen.sample === undefined && v !== null && v !== '') seen.sample = v;
      keys.set(k, seen);
    }
  }
  return keys;
}

function printKeys(label, rows) {
  const keys = keyUnion(rows);
  if (keys.size === 0) {
    console.log(`  ${label}: no rows to inspect`);
    return keys;
  }
  console.log(`  ${label} — ${rows.length} row(s), ${keys.size} distinct key(s):`);
  for (const [k, info] of [...keys.entries()].sort()) {
    const types = [...info.types].join('|');
    const sample = typeof info.sample === 'string' ? clip(info.sample, 30) : JSON.stringify(info.sample);
    console.log(
      `    ${k.padEnd(22)} ${types.padEnd(16)} present in ${String(info.count).padStart(4)}/${rows.length}  e.g. ${clip(String(sample), 34)}`,
    );
  }
  return keys;
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function spikeArr(kind, baseUrl, apiKey) {
  const isSonarr = kind === 'sonarr';
  const titlePath = isSonarr ? 'api/v3/series' : 'api/v3/movie';
  const idParam = isSonarr ? 'seriesId' : 'movieId';
  const filePath = isSonarr ? 'api/v3/episodefile' : 'api/v3/moviefile';

  section(`${kind.toUpperCase()} — reachability and version`);
  const status = await probe(baseUrl, apiKey, 'api/v3/system/status');
  if (!status.ok) {
    console.log(`  ✗ system/status HTTP ${status.status} — ${status.detail}`);
    return { reachable: false };
  }
  console.log(`  version ${status.body?.version}  (${status.ms}ms)`);

  /* ── the library, to choose a scope from ─────────────────────────────── */
  section(`${kind.toUpperCase()} — library size (FR1 scope selection)`);
  const titles = await probe(baseUrl, apiKey, titlePath);
  if (!titles.ok || !Array.isArray(titles.body)) {
    console.log(`  ✗ ${titlePath} HTTP ${titles.status} — ${titles.detail ?? 'unexpected body'}`);
    return { reachable: true };
  }
  const all = titles.body;
  const withFiles = all.filter((t) =>
    isSonarr ? (t.statistics?.episodeFileCount ?? 0) > 0 : Boolean(t.hasFile),
  );
  console.log(`  ${all.length} title(s), ${withFiles.length} with at least one file  (${titles.ms}ms, ${titles.bytes} bytes)`);
  console.log(`  NFR4 note: a 50-title plan is 50 sequential calls of the cost measured below`);

  /* ── the preview itself: OQ-5's file IDs, FR6's warning field ────────── */
  section(`${kind.toUpperCase()} — GET /api/v3/rename (FR2, FR5, FR6, OQ-5)`);
  const sample = withFiles.slice(0, Math.max(1, TITLE_SAMPLE));
  console.log(`  probing ${sample.length} title(s), one call each…`);

  const rows = [];
  const timings = [];
  let empties = 0;
  let pending = 0;

  for (const title of sample) {
    const result = await probe(baseUrl, apiKey, 'api/v3/rename', { [idParam]: title.id });
    timings.push(result.ms);
    if (!result.ok) {
      console.log(`  ✗ ${clip(title.title, 30).padEnd(32)} HTTP ${result.status} — ${result.detail}`);
      continue;
    }
    const body = Array.isArray(result.body) ? result.body : [];
    if (body.length === 0) {
      empties += 1;
    } else {
      pending += 1;
      rows.push(...body);
    }
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)] ?? 0;
  const slowest = timings.at(-1) ?? 0;

  console.log('');
  console.log(`  ${pending} title(s) with a pending rename, ${empties} with nothing pending (${pct(empties, sample.length)})`);
  console.log(`  ${rows.length} file row(s) total across the sample`);
  console.log(`  per-call latency: median ${median}ms, slowest ${slowest}ms`);
  console.log(`  → 50 titles sequentially ≈ ${((median * 50) / 1000).toFixed(1)}s  (NFR4 needs progress, not a spinner)`);
  console.log('');
  console.log(`  FR5 check — an empty response is ${empties > 0 ? 'REAL and must be reported, not dropped' : 'untested here: every sampled title had a rename pending'}`);
  console.log('');

  const keys = printKeys('preview row shape', rows.slice(0, 200));

  console.log('');
  const fileIdKey = isSonarr ? 'episodeFileId' : 'movieFileId';
  const hasFileId = keys.has(fileIdKey);
  console.log(`  OQ-5 — \`${fileIdKey}\` present in the preview: ${hasFileId ? 'YES' : 'NO'}`);
  console.log(
    hasFileId
      ? `         RenameFiles has the IDs it needs; FR7 exclusions are expressible.`
      : `         Without it, per-row exclusion (FR7) has no handle and the plan must fall back to title-scope.`,
  );

  const warningKeys = [...keys.keys()].filter((k) => /warn|error|issue|reject|message/i.test(k));
  console.log('');
  console.log(`  FR6 — warning-shaped field(s) in the preview: ${warningKeys.length ? warningKeys.join(', ') : 'NONE FOUND'}`);
  if (!warningKeys.length) {
    console.log(`         FR6 promises to flag files "whose rename carries a warning from the upstream".`);
    console.log(`         If nothing here carries one, FR6 needs a different source or needs amending.`);
  }

  if (rows.length) {
    console.log('');
    console.log('  sample rows (basenames only):');
    for (const row of rows.slice(0, 3)) {
      console.log(`    − ${basename(row.existingPath)}`);
      console.log(`    + ${basename(row.newPath)}`);
      console.log('');
    }
  }

  /* ── OQ-3's preconditions: what a file record can pin ────────────────── */
  section(`${kind.toUpperCase()} — file record fields (OQ-3 preconditions)`);
  const anyTitle = sample[0];
  if (anyTitle) {
    const files = await probe(baseUrl, apiKey, filePath, { [idParam]: anyTitle.id });
    if (files.ok && Array.isArray(files.body)) {
      console.log(`  ${files.body.length} file record(s) for one title  (${files.ms}ms)`);
      printKeys('file record shape', files.body.slice(0, 20));
      console.log('');
      console.log(`  ADR-3 chose file ID + existing path, both free in the preview above.`);
      console.log(`  The size/dateAdded alternative would cost one of THESE calls per file row.`);
    } else {
      console.log(`  ✗ ${filePath} HTTP ${files.status} — ${files.detail ?? 'unexpected body'}`);
    }
  }

  /* ── OQ-6: how a finished command reports itself ─────────────────────── */
  section(`${kind.toUpperCase()} — command records (OQ-6, FR12, FR13)`);
  const commands = await probe(baseUrl, apiKey, 'api/v3/command');
  if (commands.ok && Array.isArray(commands.body)) {
    const cmds = commands.body;
    console.log(`  ${cmds.length} command record(s) visible  (${commands.ms}ms)`);
    const names = new Map();
    for (const c of cmds) names.set(c.name, (names.get(c.name) ?? 0) + 1);
    console.log(`  names seen: ${[...names.entries()].map(([n, c]) => `${n}×${c}`).join(', ') || 'none'}`);

    const renames = cmds.filter((c) => /rename/i.test(c.name ?? ''));
    console.log('');
    console.log(`  Rename* commands in the visible window: ${renames.length}`);
    if (renames.length) {
      printKeys('rename command record', renames);
      for (const r of renames.slice(0, 2)) {
        console.log('');
        console.log(`    name=${r.name} status=${r.status} result=${r.result}`);
        console.log(`    body keys: ${Object.keys(r.body ?? {}).join(', ')}`);
        console.log(`    statusMessages: ${JSON.stringify(r.statusMessages ?? []).slice(0, 200)}`);
        console.log(`    duration=${r.duration} queued=${r.queued} started=${r.started} ended=${r.ended}`);
      }
      console.log('');
      console.log(`  OQ-6 — the command record ${renames.some((r) => (r.statusMessages ?? []).length) ? 'DOES' : 'does NOT'} carry per-file statusMessages.`);
    } else {
      console.log(`  No rename has run recently on this instance — the command record's`);
      console.log(`  per-file granularity stays untested. The history probe below is the fallback.`);
    }

    const rescans = cmds.filter((c) => /rescan|refresh/i.test(c.name ?? '') && c.duration);
    if (rescans.length) {
      console.log('');
      console.log(`  OQ-2 cost — past Rescan/Refresh durations: ${rescans.slice(0, 5).map((r) => `${r.name}=${r.duration}`).join(', ')}`);
      console.log(`  ADR-2 has helparr triggering these before every plan; that is the per-title price.`);
    }
  } else {
    console.log(`  ✗ api/v3/command HTTP ${commands.status} — ${commands.detail ?? 'unexpected body'}`);
  }

  /* ── OQ-6's other candidate: history as the per-file record ──────────── */
  section(`${kind.toUpperCase()} — history rename events (OQ-6, NFR7)`);
  const history = await probe(baseUrl, apiKey, 'api/v3/history', {
    page: 1,
    pageSize: 200,
    sortKey: 'date',
    sortDirection: 'descending',
  });
  if (history.ok && Array.isArray(history.body?.records)) {
    const records = history.body.records;
    const types = new Map();
    for (const r of records) types.set(r.eventType, (types.get(r.eventType) ?? 0) + 1);
    console.log(`  ${records.length} record(s) in the last page  (${history.ms}ms)`);
    console.log(`  eventTypes seen: ${[...types.entries()].map(([t, c]) => `${t}×${c}`).join(', ')}`);

    const renameEvents = records.filter((r) => /rename/i.test(String(r.eventType)));
    console.log('');
    console.log(`  rename-shaped eventType present: ${renameEvents.length ? 'YES' : 'not in this window'}`);
    if (renameEvents.length) {
      printKeys('rename history record', renameEvents.slice(0, 20));
      console.log('');
      console.log(`  data keys on one: ${Object.keys(renameEvents[0]?.data ?? {}).join(', ')}`);
      console.log(`  → If this carries the old and new path per file, OQ-6 is answered by history:`);
      console.log(`    poll the command to completion, then read back the per-file truth (NFR7).`);
    } else {
      console.log(`  → Without a rename event here, per-file outcomes must come from`);
      console.log(`    re-running the preview after apply and diffing (the expensive option).`);
    }
  } else {
    console.log(`  ✗ api/v3/history HTTP ${history.status} — ${history.detail ?? 'unexpected body'}`);
  }

  return { reachable: true, rows: rows.length, median, hasFileId, warningKeys };
}

/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  const sonarrUrl = env('SONARR_URL');
  const sonarrKey = env('SONARR_API_KEY');
  const radarrUrl = env('RADARR_URL');
  const radarrKey = env('RADARR_API_KEY');

  if (!sonarrUrl || !sonarrKey) {
    console.error('SONARR_URL and SONARR_API_KEY are required.');
    console.error('');
    console.error(
      envFile.found
        ? `  ${ENV_FILE} was read but does not set them.`
        : `  ${ENV_FILE} — ${envFile.reason}.`,
    );
    console.error('');
    console.error('  Put them in that file, or pass them inline:');
    console.error('    SONARR_URL=http://host:8989 SONARR_API_KEY=… npm run spike:rename');
    process.exit(2);
  }

  console.log('');
  console.log('bulk-rename-preview spike — READ-ONLY (GETs only, no command is ever posted)');
  console.log(
    envFile.found
      ? `env file: ${ENV_FILE} → ${envFile.applied.length ? envFile.applied.join(', ') : 'nothing new (shell already set everything)'}`
      : `env file: ${ENV_FILE} — ${envFile.reason}; using the shell environment`,
  );
  console.log(`title sample: ${TITLE_SAMPLE} per instance`);

  const results = {};
  results.sonarr = await spikeArr('sonarr', sonarrUrl, sonarrKey);

  if (radarrUrl && radarrKey) {
    results.radarr = await spikeArr('radarr', radarrUrl, radarrKey);
  } else {
    section('RADARR — skipped');
    console.log('  RADARR_URL / RADARR_API_KEY not set; the movie half of FR1/FR2 is unmeasured.');
  }

  section('VERDICT');
  for (const [kind, r] of Object.entries(results)) {
    if (!r?.reachable) {
      console.log(`  ${kind}: unreachable`);
      continue;
    }
    console.log(`  ${kind}: ${r.rows} pending file row(s) in the sample, preview median ${r.median}ms`);
    console.log(`          OQ-5 file IDs in preview: ${r.hasFileId ? 'present' : 'ABSENT — FR7 is at risk'}`);
    console.log(`          FR6 warning field(s): ${r.warningKeys?.length ? r.warningKeys.join(', ') : 'NONE — FR6 needs amending'}`);
  }
  console.log('');
  console.log('  Not established by a read-only spike: whether RenameFiles honours an');
  console.log('  explicit file-ID list rather than renaming everything pending. That');
  console.log('  needs one real rename, and the plan treats it as the risk it is.');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error(`spike failed: ${error?.message ?? error}`);
  process.exit(2);
});
