#!/usr/bin/env node
/**
 * bulk-rename-preview / R1 — does `RenameFiles` honour an explicit file-ID
 * list, or does it rename everything pending for the title?
 *
 * This is the one question the read-only spike could not answer, and the plan
 * makes it a gate on T6: if the command ignores the list, then every per-row
 * exclusion helparr offers is a lie, and the whole feature has to be
 * re-designed around per-title scope before the batch path is built.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ANSWERED 2026-09-17: the list IS honoured.
 *
 * A `--commit` run sent `{name:'RenameFiles', seriesId:8, files:[2191]}` to a
 * series with two pending renames. Sonarr logged `Renaming 1 files for Accel
 * World` and attempted only `[2191]`; `2190` was never touched. That run's
 * rename then *failed* (its destination was already occupied), so this script's
 * own witness check reported INCONCLUSIVE — the answer came from the instance's
 * debug log, which separates scope from outcome where the API does not.
 *
 * The script is kept for re-verification against a future *arr release. Note
 * that the witness check alone cannot distinguish "the list was honoured" from
 * "the command did nothing at all"; read the log when it reports inconclusive.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS SCRIPT WRITES. It renames exactly ONE real file in your library, and
 * that rename is NOT reversible by this script or by the *arr API.
 *
 * What it does, in order:
 *   1. Finds a series (or movie) with at least TWO files pending a rename.
 *   2. Prints both proposed renames and asks you to confirm by typing the
 *      file's new name — the same typed-confirmation shape the feature uses.
 *   3. Issues `RenameFiles` naming ONE of those file IDs.
 *   4. Waits for the command, re-runs the preview, and reports whether the
 *      other file is STILL pending.
 *
 *   Other file still pending  →  the ID list was honoured. R1 resolved, T6
 *                                proceeds as planned.
 *   Other file also renamed   →  the ID list was ignored. STOP: ADR-6 is
 *                                wrong and exclusions cannot be implemented
 *                                as designed.
 *
 * Nothing else is touched. It renames one file and stops, whatever the result.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * It prints no credentials and no API keys. Paths are basenamed and clipped —
 * a terminal log should not become an inventory of the operator's library.
 * The one exception is the file being renamed, whose before/after names are
 * printed in full, because you cannot consent to a rename you cannot read.
 *
 * Usage:
 *
 *   node scripts/verify-rename-scope.mjs            # dry run: finds and prints the candidate, renames nothing
 *   node scripts/verify-rename-scope.mjs --commit   # asks for confirmation, then renames one file
 *
 * Credentials come from `~/.helparr-verify.env`, same as the spike. Point
 * `SPIKE_ENV_FILE` elsewhere to use a different one; anything already exported
 * in the shell wins over the file.
 *
 * Exit codes: 0 = answered (or dry run completed), 2 = could not run,
 *             3 = the ID list was NOT honoured (R1 materialised).
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const env = (name) => process.env[name]?.trim() || null;
const ENV_FILE = resolve(process.env.SPIKE_ENV_FILE?.trim() || `${homedir()}/.helparr-verify.env`);
const COMMIT = process.argv.includes('--commit');

/** Identical to the spike's loader — returns key names, never values. */
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

const clip = (s, n = 58) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const basename = (p) => (typeof p === 'string' ? clip(p.split('/').pop() ?? '') : '');

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(2);
}

/* ── Transport ────────────────────────────────────────────────────────────── */

function makeClient(baseUrl, apiKey) {
  const root = baseUrl.replace(/\/+$/, '');
  const call = async (method, path, body) => {
    const response = await fetch(`${root}/api/v3${path}`, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status} ${response.statusText}`);
    }
    return response.json();
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
  };
}

const dirOf = (path) => {
  const cut = path.replace(/\\/g, '/').lastIndexOf('/');
  return cut <= 0 ? '' : path.slice(0, cut);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function awaitCommand(client, commandId, label) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const record = await client.get(`/command/${commandId}`);
    if (record.status === 'completed') return;
    if (record.status === 'failed' || record.status === 'aborted') {
      fail(`${label} command ${record.status}: ${record.message ?? '(no message)'}`);
    }
    await sleep(1000);
  }
  fail(`${label} command did not finish within five minutes.`);
}

/* ── Candidate search ─────────────────────────────────────────────────────── */

/**
 * The first title with ≥2 files pending a rename.
 *
 * Two is the minimum the question needs: one file to name in the command, one
 * to watch. A title with exactly one pending rename cannot distinguish "the
 * list was honoured" from "everything was renamed" — they produce the same
 * result.
 */
async function findCandidate(client, kind) {
  const titles = await client.get(kind === 'series' ? '/series' : '/movie');
  const sample = titles.slice(0, Number(env('VERIFY_TITLE_SAMPLE') ?? 60));
  let skippedForCollision = 0;

  for (const title of sample) {
    const query = kind === 'series' ? `seriesId=${title.id}` : `movieId=${title.id}`;
    let rows;
    try {
      rows = await client.get(`/rename?${query}`);
    } catch {
      continue;
    }
    if (!Array.isArray(rows) || rows.length < 2) continue;

    const mapped = rows.map((row) => ({
      fileId: kind === 'series' ? row.episodeFileId : row.movieFileId,
      existingPath: row.existingPath,
      newPath: row.newPath,
    }));

    // Skip rows whose destination is already occupied by something that is not
    // itself moving away. The first run of this script found exactly that case
    // and learned nothing about R1 from it: Sonarr accepted the command,
    // reported it completed and successful, and renamed nothing
    // (DestinationAlreadyExistsException in its own log). A candidate that
    // cannot possibly move is not a test of whether the ID list is honoured.
    //
    // The occupant is read from /filesystem, not /episodefile, because in the
    // observed case Sonarr had never imported it — it was on disk and in no
    // library listing at all. The trailing slash on the path is required:
    // without it the endpoint answers about the parent directory instead.
    const root = String(title.path ?? '').replace(/[/\\]+$/, '');
    if (!root) continue;

    const occupied = new Set();
    for (const dir of new Set(mapped.map((row) => dirOf(row.newPath)))) {
      const absolute = dir === '' ? `${root}/` : `${root}/${dir}/`;
      let listing;
      try {
        listing = await client.get(
          `/filesystem?path=${encodeURIComponent(absolute)}&includeFiles=true`,
        );
      } catch {
        continue;
      }
      for (const file of listing?.files ?? []) {
        if (file?.name) occupied.add(dir === '' ? file.name : `${dir}/${file.name}`);
      }
    }

    const vacating = new Set(mapped.map((row) => row.existingPath));

    const usable = mapped.filter(
      (row) => !occupied.has(row.newPath) || vacating.has(row.newPath),
    );

    if (usable.length < 2) {
      if (mapped.length >= 2) skippedForCollision += 1;
      continue;
    }

    return { kind, titleId: title.id, titleLabel: title.title, rows: usable, skippedForCollision };
  }
  console.log(`(skipped ${skippedForCollision} title(s) whose destinations are already occupied)`);
  return null;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  section('Configuration');
  console.log(`env file: ${ENV_FILE} — ${envFile.found ? `supplied ${envFile.applied.length} key(s)` : envFile.reason}`);
  if (envFile.found && envFile.applied.length > 0) {
    console.log(`supplied: ${envFile.applied.join(', ')}`);
  }
  console.log(`mode: ${COMMIT ? 'COMMIT — one file will be renamed' : 'dry run — nothing will be renamed'}`);

  const backends = [
    { kind: 'series', url: env('SONARR_URL'), key: env('SONARR_API_KEY'), name: 'Sonarr' },
    { kind: 'movie', url: env('RADARR_URL'), key: env('RADARR_API_KEY'), name: 'Radarr' },
  ].filter((backend) => backend.url && backend.key);

  if (backends.length === 0) fail('No SONARR_URL/SONARR_API_KEY or RADARR_URL/RADARR_API_KEY available.');

  section('Finding a candidate title (≥2 files pending a rename)');
  let candidate = null;
  let client = null;
  let backendName = '';
  for (const backend of backends) {
    const probe = makeClient(backend.url, backend.key);
    console.log(`scanning ${backend.name}…`);
    const found = await findCandidate(probe, backend.kind);
    if (found) {
      candidate = found;
      client = probe;
      backendName = backend.name;
      break;
    }
  }

  if (!candidate) {
    console.log('\nNo title with two or more pending renames was found in the sample.');
    console.log('R1 cannot be settled without one — widen VERIFY_TITLE_SAMPLE, or');
    console.log('temporarily change a naming format so two files become pending.');
    process.exit(2);
  }

  const [target, witness] = candidate.rows;

  section(`Candidate — ${backendName}: ${clip(candidate.titleLabel, 50)}`);
  console.log('The file this run would rename:');
  console.log(`  id ${target.fileId}`);
  console.log(`  −  ${target.existingPath}`);
  console.log(`  +  ${target.newPath}`);
  console.log('');
  console.log('The witness — NOT named in the command. It must stay pending:');
  console.log(`  id ${witness.fileId}`);
  console.log(`  −  ${basename(witness.existingPath)}`);
  console.log(`  +  ${basename(witness.newPath)}`);
  console.log('');
  console.log(`(${candidate.rows.length} file(s) pending for this title in total.)`);

  if (!COMMIT) {
    console.log('\nDry run. Nothing was renamed. Re-run with --commit to settle R1.');
    return;
  }

  section('Confirmation');
  const expected = (target.newPath.split('/').pop() ?? '').trim();
  console.log('This rename is not reversible. To proceed, type the new file name exactly:');
  console.log(`  ${expected}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question('> ')).trim();
  rl.close();
  if (typed !== expected) {
    console.log('\nDid not match. Nothing was renamed.');
    process.exit(0);
  }

  section('Issuing RenameFiles with ONE file id');
  const payload = candidate.kind === 'series'
    ? { name: 'RenameFiles', seriesId: candidate.titleId, files: [target.fileId] }
    : { name: 'RenameFiles', movieId: candidate.titleId, files: [target.fileId] };
  console.log(`payload: ${JSON.stringify(payload)}`);

  const command = await client.post('/command', payload);
  console.log(`command id ${command.id} accepted — waiting…`);
  await awaitCommand(client, command.id, 'RenameFiles');
  console.log('command completed.');

  section('Verdict');
  const query = candidate.kind === 'series'
    ? `seriesId=${candidate.titleId}`
    : `movieId=${candidate.titleId}`;
  const after = await client.get(`/rename?${query}`);
  const stillPending = new Set(
    after.map((row) => (candidate.kind === 'series' ? row.episodeFileId : row.movieFileId)),
  );

  const targetRenamed = !stillPending.has(target.fileId);
  const witnessRenamed = !stillPending.has(witness.fileId);

  console.log(`named file  (${target.fileId}): ${targetRenamed ? 'renamed' : 'STILL PENDING'}`);
  console.log(`witness     (${witness.fileId}): ${witnessRenamed ? 'ALSO RENAMED' : 'still pending'}`);
  console.log(`pending before: ${candidate.rows.length} → after: ${after.length}`);

  if (targetRenamed && !witnessRenamed) {
    console.log('\n✓ R1 RESOLVED — `RenameFiles` honoured the explicit ID list.');
    console.log('  ADR-6 holds; per-row exclusions are implementable as designed.');
    return;
  }
  if (!targetRenamed) {
    console.log('\n? INCONCLUSIVE — the named file was not renamed either.');
    console.log('  The command completed but changed nothing; investigate before trusting T6.');
    process.exit(2);
  }
  console.log('\n✗ R1 MATERIALISED — the witness was renamed too.');
  console.log('  `RenameFiles` ignored the ID list. ADR-6 is wrong and per-row');
  console.log('  exclusions cannot be honoured. STOP and re-plan before T6 ships.');
  process.exit(3);
}

main().catch((error) => fail(String(error?.message ?? error)));
