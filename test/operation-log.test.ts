import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupTestDir } from './helpers/env';
import { startFakeArr, type FakeArr } from './helpers/fakeArr';
import { resetConfigCache } from '@/server/config';
import { closeDb, getDb } from '@/server/db';
import { createInstance, deleteInstance } from '@/server/instances/registry';
import { logger } from '@/server/logging/redact';
import { countOperations, listOperations, purgeOperations } from '@/server/operations/log';
import { disposeAllBreakers } from '@/server/resilience/breaker';
import { grab } from '@/server/search/grab';

/**
 * T24 / REQ-OPS-001..005, NFR2, NFR3; ADR-6, ADR-7.
 *
 * The log is the only durable record that helparr wrote anything, so the three
 * things that would quietly destroy it are each asserted here rather than
 * assumed:
 *
 * 1. **One row per attempt.** Not per success — a rejected grab and a 502 are
 *    both attempts, and both are the ones the operator comes looking for.
 * 2. **Append-only.** Asserted statically, by reading the module's source. A
 *    behavioural test can only show that today's code paths do not update a
 *    row; the source says no code path can.
 * 3. **No credential, anywhere.** The download URL is proxied through Prowlarr
 *    and carries Prowlarr's own API key — the credential to the whole
 *    application. It must be absent from the row and from the log output at the
 *    most verbose level helparr can be run at.
 */

const APIKEY = 'PROWLARR-API-KEY-2f8c41ab';
const DOWNLOAD_URL = `http://prowlarr.example:9696/4/download?apikey=${APIKEY}&guid=1`;

const RELEASE = {
  title: 'Show.S01E01.1080p.WEB-DL-GROUP',
  downloadUrl: DOWNLOAD_URL,
  protocol: 'torrent' as const,
  publishDate: '2026-09-01T00:00:00Z',
  indexer: 'TorrentDay',
  entityRef: 'Show — S01E01',
};

const REJECTIONS = [
  'Existing file meets cutoff: WEBDL-1080p',
  'Not a preferred word upgrade for existing episode file(s)',
];

const created: string[] = [];

describe('operation log integrity', () => {
  let sonarr: FakeArr;
  let sonarrId: string;

  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
  });

  afterEach(() => {
    for (const id of created.splice(0)) deleteInstance(id);
    sonarr.pushes.length = 0;
    sonarr.setPushResult({});
    purgeOperations();
    disposeAllBreakers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    closeDb();
    await sonarr.close();
    cleanupTestDir();
  });

  function register(): string {
    const dto = createInstance({
      kind: 'sonarr',
      label: 'Sonarr',
      baseUrl: sonarr.url,
      credential: { type: 'api-key', apiKey: 'sonarr-key' },
    });
    created.push(dto.id);
    sonarrId = dto.id;
    return dto.id;
  }

  /** One of each: accepted, rejected, and a transport failure. */
  async function threeAttempts() {
    register();

    sonarr.setPushResult({ rejected: false, rejections: [] });
    await grab({ instanceId: sonarrId, ...RELEASE, title: 'Accepted.S01E01' });

    sonarr.setPushResult({ rejected: true, rejections: REJECTIONS });
    await grab({ instanceId: sonarrId, ...RELEASE, title: 'Rejected.S01E02' });

    sonarr.setPushResult(502);
    await grab({ instanceId: sonarrId, ...RELEASE, title: 'Broken.S01E03' });
  }

  it('records one row per attempt, with the outcome the upstream gave', async () => {
    await threeAttempts();

    const { operations, counts } = listOperations();
    expect(operations).toHaveLength(3);
    expect(countOperations()).toBe(3);
    // Three pushes, three rows. An attempt that left no trace is the thing the
    // log exists to prevent (ADR-6).
    expect(sonarr.pushes).toHaveLength(3);

    const byTitle = new Map(operations.map((row) => [row.entityTitle, row]));

    expect(byTitle.get('Accepted.S01E01')).toMatchObject({
      outcome: 'succeeded', rejected: false, detail: [],
    });
    // Recorded as "failed" verbatim (REQ-OPS-001); `rejected` is what splits
    // "your profile said no" from "Sonarr returned 502".
    expect(byTitle.get('Rejected.S01E02')).toMatchObject({
      outcome: 'failed', rejected: true, detail: REJECTIONS,
    });
    const broken = byTitle.get('Broken.S01E03')!;
    expect(broken.outcome).toBe('failed');
    expect(broken.rejected).toBe(false);
    expect(broken.detail).toHaveLength(1);

    expect(counts).toEqual({ all: 3, succeeded: 1, rejected: 1, failed: 1 });
  });

  it('keeps every row across a restart', async () => {
    await threeAttempts();
    const before = listOperations().operations;

    // The closest thing to a restart the persistence layer has: the handle is
    // dropped and the next read reopens the file from disk. REQ-OPS-002 is a
    // claim about the database, not about a cache.
    closeDb();

    const after = listOperations().operations;
    expect(after).toEqual(before);
    // Ids and timestamps included — a "durable" log that renumbered its rows
    // would break every reference made to it.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.find((row) => row.rejected)?.detail).toEqual(REJECTIONS);
  });

  it('filters to one bucket while the counts keep describing the whole table', async () => {
    await threeAttempts();

    const succeeded = listOperations('succeeded');
    expect(succeeded.operations.map((row) => row.entityTitle)).toEqual(['Accepted.S01E01']);
    // The chips have to keep reading "Failed 1" while the operator is looking
    // at the successes — otherwise the filter erases the evidence it was opened
    // to find (REQ-OPS-005).
    expect(succeeded.counts).toEqual({ all: 3, succeeded: 1, rejected: 1, failed: 1 });

    expect(listOperations('rejected').operations.map((row) => row.entityTitle))
      .toEqual(['Rejected.S01E02']);
    expect(listOperations('failed').operations.map((row) => row.entityTitle))
      .toEqual(['Broken.S01E03']);

    // The two failure buckets partition the failures — neither row appears in
    // both, and none is invisible to every filter.
    expect(listOperations('failed').operations.some((row) => row.rejected)).toBe(false);
    expect(listOperations('rejected').operations.every((row) => row.rejected)).toBe(true);
  });

  it('contains no UPDATE against the operation table, in the source', () => {
    const source = readFileSync('src/server/operations/log.ts', 'utf8')
      // Comments say the module is append-only; the SQL has to prove it. They
      // are stripped so the prose cannot satisfy — or fail — the assertion.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/\bUPDATE\b/i);
    // Exactly one INSERT into `operation`, and the only DELETE is the
    // operator-triggered purge.
    //
    // Scoped to the table rather than counting INSERTs outright: this module
    // also writes `rename_file_outcome`, the per-file detail a rename operation
    // carries (NFR7). That row is appended in the same call as its parent and
    // is never updated either, so the invariant is unchanged — but an
    // unqualified count would read a second append-only table as a violation.
    expect(source.match(/\bINSERT\s+INTO\s+operation\b/gi)).toHaveLength(1);
    expect(source.match(/\bINSERT\s+INTO\b/gi)).toHaveLength(2);
    expect(source.match(/\bDELETE\s+FROM\s+operation\b/gi)).toHaveLength(1);

    // Nothing outside this module touches the table either — a second writer
    // would be a second place for the rules above to be broken.
    const others = readdirSync('src/server', { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && file !== join('operations', 'log.ts'))
      .map((file) => readFileSync(join('src/server', file), 'utf8'));

    for (const file of others) {
      expect(file).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+operation\b/i);
    }
  });

  it('stores a fingerprint of the download URL and never the URL itself', async () => {
    register();
    sonarr.setPushResult({ rejected: false });
    await grab({ instanceId: sonarrId, ...RELEASE });

    const [row] = listOperations().operations;
    expect(row.urlSha256).toBe(createHash('sha256').update(DOWNLOAD_URL).digest('hex'));
    // The host is kept because "which Prowlarr sent this" is a question the
    // operator asks; the query string is where the credential lives.
    expect(row.urlHost).toBe('prowlarr.example:9696');

    const serialized = JSON.stringify(listOperations());
    expect(serialized).not.toContain(APIKEY);
    expect(serialized).not.toContain('apikey=');
    expect(serialized).not.toContain(DOWNLOAD_URL);

    // Structural, not incidental: there is no column to write a URL to, so no
    // future call site can start writing one (ADR-7).
    const columns = (getDb().prepare('PRAGMA table_info(operation)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toContain('url_sha256');
    expect(columns).toContain('url_host');
    expect(columns.filter((name) => name.includes('url')).sort())
      .toEqual(['url_host', 'url_sha256']);
  });

  it('keeps the credential out of the log at the most verbose level', async () => {
    const previousLevel = process.env.HELPARR_LOG_LEVEL;
    process.env.HELPARR_LOG_LEVEL = 'debug';
    // The configuration is parsed once and cached for the process lifetime, so
    // changing the environment underneath it is only meaningful in a test, and
    // only when the cache is dropped alongside it.
    resetConfigCache();

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { lines.push(args.join(' ')); });

    try {
      register();
      sonarr.setPushResult({ rejected: false });
      await grab({ instanceId: sonarrId, ...RELEASE });

      // A failed push is the noisier path — an upstream error can echo the
      // request back, so it is the one most likely to print the URL.
      sonarr.setPushResult(502);
      await grab({ instanceId: sonarrId, ...RELEASE, title: 'Broken.S01E02' });

      // Non-vacuous: the grab registered the URL as a secret before sending it,
      // so even a call site that logs it verbatim cannot print it.
      logger.debug('deliberate leak attempt', { url: DOWNLOAD_URL, message: DOWNLOAD_URL });
      expect(lines.some((line) => line.includes('deliberate leak attempt'))).toBe(true);

      const output = lines.join('\n');
      expect(output).not.toContain(APIKEY);
      expect(output).not.toContain(DOWNLOAD_URL);
      expect(output).not.toMatch(/apikey=(?!\[redacted\])/i);
    } finally {
      if (previousLevel === undefined) delete process.env.HELPARR_LOG_LEVEL;
      else process.env.HELPARR_LOG_LEVEL = previousLevel;
      resetConfigCache();
    }
  });
});
