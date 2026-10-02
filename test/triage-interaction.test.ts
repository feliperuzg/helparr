import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import {
  startFakeArr, type FakeArr, type FakeGapRecord, type FakeQueueRecord,
} from './helpers/fakeArr';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';
import { startFakeQbit, type FakeQbit } from './helpers/fakeQbit';

/**
 * T26 — the stuck-item-triage interaction lane, in a real browser against the
 * real standalone build and real loopback fakes.
 *
 * The claims here are the ones only a browser can settle:
 *
 *  1. **A cause is read, not guessed.** An import-rejected record carries its
 *     badge and the instance's own words; force import is offered for it and
 *     *not* for a record whose payload the download client reports gone.
 *  2. **Nothing is imported before the typed count.** Counted at the fake —
 *     zero `ManualImport` commands through every gate state, exactly one after.
 *  3. **A moved candidate set refuses the whole import**, and Rebuild is the
 *     only way forward.
 *  4. **The explainer is one component from three doors** — search, queue and
 *     gaps — and every door shows both sides, both scores with their source,
 *     the profile thresholds, and the instance's verbatim reason.
 *  5. **Unmapped: unknown is never none**, the list is keyboard-operable and
 *     reachable by `7`, and one unreadable instance costs only itself.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3999;
const PASSWORD = 'operator-password-for-the-triage-run';

/* ── Shared decision-engine config ─────────────────────────────────────────── */

const WEBDL = { quality: { id: 3, name: 'WEBDL-1080p' }, revision: { version: 1, real: 0, isRepack: false } };
const BLURAY = { quality: { id: 7, name: 'Bluray-1080p' }, revision: { version: 1, real: 0, isRepack: false } };

const CUSTOM_FORMATS = [{ id: 1, name: 'x265' }, { id: 2, name: 'Proper' }];

const PROFILE = {
  id: 3,
  name: 'HD-1080p',
  upgradeAllowed: true,
  cutoff: 7,
  items: [
    { quality: { id: 3, name: 'WEBDL-1080p' }, allowed: true },
    { quality: { id: 7, name: 'Bluray-1080p' }, allowed: true },
  ],
  minFormatScore: 10,
  cutoffFormatScore: 100,
  formatItems: [
    { format: 1, name: 'x265', score: -50 },
    { format: 2, name: 'Proper', score: 20 },
  ],
};

/** The file already on disk for Reacher S01E01. No `sceneName`: scored from its filename. */
const EXISTING_FILE_ID = 501;
const EXISTING_FILE = {
  id: EXISTING_FILE_ID,
  path: '/tv/Reacher/Season 01/Reacher.S01E01.Bluray-1080p.mkv',
  relativePath: 'Season 01/Reacher.S01E01.Bluray-1080p.mkv',
  size: 4_000_000_000,
  quality: BLURAY,
  customFormats: [{ id: 2, name: 'Proper' }],
  customFormatScore: 20,
  languages: [{ id: 1, name: 'English' }],
};

/* ── Queue ─────────────────────────────────────────────────────────────────── */

const REJECTION_MESSAGE = 'Not an upgrade for existing episode file(s). Existing quality: Bluray-1080p. New Quality WEBDL-1080p.';

/** Completed, warned, with a matched completed torrent — rule 4: import-rejected, reported. */
const REJECTED: FakeQueueRecord = {
  id: 1,
  title: 'Reacher.S01.1080p.WEB-DL-GROUP',
  size: 2_000_000_000,
  sizeleft: 0,
  protocol: 'torrent',
  indexer: 'Indexer',
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importBlocked',
  downloadId: 'HASH1',
  statusMessages: [{ title: 'Reacher.S01E01.1080p.WEB-DL-GROUP.mkv', messages: [REJECTION_MESSAGE] }],
  series: { title: 'Reacher' },
  episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
};

/** The download client reports the payload gone — rule 2: payload-missing, no force import. */
const GHOST: FakeQueueRecord = {
  id: 2,
  title: 'Ghost.Payload.S01E02.1080p.WEB-DL',
  size: 2_000_000_000,
  sizeleft: 1_000_000_000,
  protocol: 'torrent',
  indexer: 'Indexer',
  status: 'downloading',
  trackedDownloadStatus: 'ok',
  trackedDownloadState: 'downloading',
  downloadId: 'HASH2',
  series: { title: 'Ghost' },
  episodes: [{ seasonNumber: 1, episodeNumber: 2 }],
};

const TORRENTS = [
  // Lowercase, as qBittorrent reports it; matched against the uppercase downloadId.
  { hash: 'hash1', progress: 1, num_seeds: 3, num_leechs: 0, dlspeed: 0, eta: 0, state: 'stalledUP', completion_on: 1_700_000_000 },
  { hash: 'hash2', progress: 0.5, num_seeds: 0, num_leechs: 0, dlspeed: 0, eta: 8640000, state: 'missingFiles', completion_on: -1 },
];

/* ── Force import candidates for HASH1 ─────────────────────────────────────── */

function candidate(
  path: string,
  episode: { id: number; number: number; hasFile?: boolean; fileId?: number | null },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path,
    relativePath: path.split('/').pop(),
    size: 1_000_000_000,
    quality: WEBDL,
    languages: [{ id: 1, name: 'English' }],
    releaseGroup: 'GROUP',
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    customFormats: [],
    customFormatScore: 0,
    rejections: [],
    downloadId: 'HASH1',
    series: { id: 1, title: 'Reacher', qualityProfileId: 3 },
    seasonNumber: 1,
    episodes: [{
      id: episode.id,
      seasonNumber: 1,
      episodeNumber: episode.number,
      title: null,
      hasFile: episode.hasFile ?? false,
      episodeFileId: episode.fileId ?? null,
    }],
    ...extra,
  };
}

const DIR = '/downloads/Reacher.S01.1080p.WEB-DL-GROUP';
const SAMPLE_REJECTION = 'Unable to determine if file is a sample';

const CAND_A = candidate(`${DIR}/Reacher.S01E02.1080p.WEB-DL-GROUP.mkv`, { id: 12, number: 2 }, {
  rejections: [SAMPLE_REJECTION],
});
const CAND_B = candidate(`${DIR}/Reacher.S01E03.1080p.WEB-DL-GROUP.mkv`, { id: 13, number: 3 });
/** Its episode already has a file — a replacement, excluded by default (ADR-8). */
const CAND_REPLACE = candidate(`${DIR}/Reacher.S01E04.1080p.WEB-DL-GROUP.mkv`, {
  id: 14, number: 4, hasFile: true, fileId: 504,
});
/** Appears between preview and confirm in the drift scenario. */
const CAND_LATE = candidate(`${DIR}/Reacher.S01E05.1080p.WEB-DL-GROUP.mkv`, { id: 15, number: 5 });

const IMPORT_SET = [CAND_A, CAND_B, CAND_REPLACE];

/** No episode resolved — no target, so it starts excluded and a bulk include skips it. */
const CAND_UNMAPPED = candidate(`${DIR}/Reacher.S01.Extras.1080p.WEB-DL-GROUP.mkv`, { id: 0, number: 0 }, {
  episodes: [],
});

/**
 * A season pack where 51 of 53 files would replace one already on disk — the
 * shape that made "include them one by one" the bug (queue-triage-ergonomics AC4).
 */
const PACK_FRESH = [CAND_A, CAND_B];
const PACK_REPLACEMENTS = Array.from({ length: 51 }, (_, i) => {
  const number = i + 4;
  const code = `S01E${String(number).padStart(2, '0')}`;
  return candidate(`${DIR}/Reacher.${code}.1080p.WEB-DL-GROUP.mkv`, {
    id: 100 + number, number, hasFile: true, fileId: 600 + number,
  });
});
const PACK = [...PACK_FRESH, ...PACK_REPLACEMENTS];

/** The one the queue explainer compares: rejected, and its episode has the file on disk. */
const QUEUE_EXPLAIN_CANDIDATE = candidate(`${DIR}/Reacher.S01E01.1080p.WEB-DL-GROUP.mkv`, {
  id: 11, number: 1, hasFile: true, fileId: EXISTING_FILE_ID,
}, {
  customFormats: [{ id: 1, name: 'x265' }],
  customFormatScore: -50,
  rejections: [REJECTION_MESSAGE],
});

/* ── Search / gaps release candidate ───────────────────────────────────────── */

const CF_REJECTION = "Custom Formats x265 have score -50 below Series's minimum 10";

/** The release Sonarr's own search returns; matches Prowlarr's first result by infoHash. */
const RELEASE_CANDIDATE = {
  title: 'Show.S01E01.1080p.WEB-DL-GROUP',
  infoHash: 'hash-4-1',
  guid: 'TorrentDay-4-1',
  indexer: 'TorrentDay',
  quality: WEBDL,
  customFormats: [{ id: 1, name: 'x265' }],
  customFormatScore: -50,
  rejections: [CF_REJECTION],
  episodes: [{ id: 11 }],
};

/** `/parse` for the search side: resolved, with the profile and the episode's file. */
const PARSE_BODY = {
  series: { id: 1, title: 'Reacher', qualityProfileId: 3 },
  episodes: [{ id: 11, seasonNumber: 1, episodeNumber: 1, hasFile: true, episodeFileId: EXISTING_FILE_ID }],
  parsedEpisodeInfo: {
    quality: { quality: { name: 'WEBDL-1080p' } },
    releaseGroup: 'GROUP',
    seasonNumber: 1,
  },
};

const SERIES = [{ id: 1, title: 'Reacher', path: '/tv/Reacher', qualityProfileId: 3 }];

/** A missing episode of the same series — the gap the third door opens from. */
const GAP: FakeGapRecord = {
  id: 16,
  seriesId: 1,
  seasonNumber: 1,
  episodeNumber: 6,
  title: 'Episode 6',
  airDateUtc: '2025-01-01T00:00:00Z',
  monitored: true,
  hasFile: false,
};

/* ── Unmapped ──────────────────────────────────────────────────────────────── */

const SONARR_ROOTS = [
  {
    id: 1,
    path: '/media/tv',
    accessible: true,
    freeSpace: 500_000_000_000,
    unmappedFolders: [
      { name: 'Severance', path: '/media/tv/Severance', relativePath: 'Severance' },
      { name: 'Andor', path: '/media/tv/Andor', relativePath: 'Andor' },
    ],
  },
  // The key omitted entirely: the instance ran out of scan budget — unknown.
  { id: 2, path: '/media/slow', accessible: true, freeSpace: 100_000_000_000 },
  // The key present and empty: a confirmed zero.
  { id: 3, path: '/media/empty', accessible: true, freeSpace: 100_000_000_000, unmappedFolders: [] },
];

const RADARR_ROOTS = [
  {
    id: 1,
    path: '/media/films',
    accessible: true,
    freeSpace: 800_000_000_000,
    unmappedFolders: [{ name: 'Arrival (2016)', path: '/media/films/Arrival (2016)', relativePath: 'Arrival (2016)' }],
  },
];

/* ── Harness ───────────────────────────────────────────────────────────────── */

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let radarr: FakeArr;
let qbit: FakeQbit;
let prowlarr: FakeProwlarr;

const manualImports = () => sonarr.commands.filter((command) => command.body.name === 'ManualImport');

const queueRow = (text: string) => page.locator('.qgrid__body-row', { hasText: text });

/** Loads the queue and waits until both records have their causes. */
async function openQueue(): Promise<void> {
  await page.goto(app.origin);
  await expect.poll(() => page.locator('.qgrid__body-row').count(), { timeout: 15_000 }).toBe(2);
}

/** Opens the force-import screen for REJECTED from its inspector, as an operator would. */
async function openForceImport(): Promise<void> {
  await openQueue();
  await queueRow(REJECTED.title).click();
  await page.waitForSelector('.inspector');
  await page.click('.inspector a:has-text("Force import")');
  await page.waitForURL(/\/import\?/);
  await expect.poll(() => page.locator('.ribbon__title').first().textContent(), { timeout: 20_000 })
    .toBe('PREVIEW — nothing has been imported');
}

/** Candidate grid row for a file, by its basename. */
const gridRow = (path: string) => page.locator('table[role="grid"] tbody tr', { hasText: path.split('/').pop() as string });

interface ComparisonRead {
  candidate: Record<string, string>;
  onDisk: Record<string, string>;
  onDiskText: string;
  profile: Record<string, string>;
  text: string;
}

/**
 * Reads a rendered comparison: both side columns, the profile thresholds and
 * the full text. Keyed on the visible labels, so a renamed label fails here.
 */
async function readComparison(scope: Locator): Promise<ComparisonRead> {
  return scope.evaluate((root) => {
    const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const kv = (dl: Element | null | undefined) => {
      const out: Record<string, string> = {};
      if (!dl) return out;
      for (const key of Array.from(dl.querySelectorAll('.kv__k'))) {
        out[norm(key.textContent)] = norm(key.nextElementSibling?.textContent);
      }
      return out;
    };
    const column = (title: string) => Array.from(root.querySelectorAll('.eyebrow'))
      .find((node) => norm(node.textContent) === title)?.parentElement ?? null;
    const candidateColumn = column('Candidate');
    const onDiskColumn = column('On disk');
    const profileList = Array.from(root.querySelectorAll('dl.kv'))
      .find((dl) => (dl.textContent ?? '').includes('Cutoff quality'));
    return {
      candidate: kv(candidateColumn?.querySelector('dl.kv')),
      onDisk: kv(onDiskColumn?.querySelector('dl.kv')),
      onDiskText: norm(onDiskColumn?.textContent),
      profile: kv(profileList),
      text: norm(root.textContent),
    };
  });
}

describe('stuck-item triage interaction', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: [REJECTED, GHOST] });
    sonarr.setProfiles([PROFILE]);
    sonarr.setCustomFormats(CUSTOM_FORMATS);
    sonarr.setExistingFile(EXISTING_FILE_ID, EXISTING_FILE);
    sonarr.setSeries(SERIES);
    sonarr.setWanted([GAP]);
    sonarr.setParse(PARSE_BODY);
    sonarr.setCandidates([RELEASE_CANDIDATE]);
    sonarr.setRootFolders(SONARR_ROOTS);

    radarr = await startFakeArr({ apiKey: 'radarr-key' });
    radarr.setRootFolders(RADARR_ROOTS);

    qbit = await startFakeQbit({ username: 'admin', password: 'adminadmin', torrents: TORRENTS });

    prowlarr = await startFakeProwlarr({ apiKey: 'prowlarr-key', indexers: [{ id: 4, name: 'TorrentDay' }] });
    prowlarr.setResults(4, fakeReleases(4, 'TorrentDay', 2));

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
    await seedInstance(page, 'radarr', 'Radarr', radarr.url, { type: 'api-key', apiKey: 'radarr-key' });
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, { type: 'api-key', apiKey: 'prowlarr-key' });
    await seedInstance(page, 'download-client', 'qBittorrent', qbit.url, {
      type: 'userpass', username: 'admin', password: 'adminadmin',
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
    await radarr?.close();
    await qbit?.close();
    await prowlarr?.close();
  });

  beforeEach(() => {
    sonarr.commands.length = 0;
    sonarr.setImportCandidates(IMPORT_SET);
    sonarr.setImportHook(null);
  });

  it('names an import-rejected cause with its evidence, and offers force import only where there is a payload', async () => {
    await openQueue();

    // The Cause column carries the badge for both records.
    const headers = await page.locator('.qgrid__head [role="columnheader"]').allTextContents();
    // The sort caret rides on the active column's label; it is not part of the name.
    expect(headers.map((h) => h.replace(/[▲▼]/g, '').trim())).toContain('Cause');
    await expect.poll(() => queueRow(REJECTED.title).textContent()).toContain('Rejected');
    await expect.poll(() => queueRow(GHOST.title).textContent()).toContain('No payload');

    await queueRow(REJECTED.title).click();
    await page.waitForSelector('.inspector');
    const inspector = page.locator('.inspector');
    const text = (await inspector.textContent()) ?? '';

    // The Cause group, with the instance's own words, attributed to it.
    expect(text).toContain('Evidence — verbatim, from Sonarr');
    expect(text).toContain(`${REJECTED.statusMessages![0].title}: ${REJECTION_MESSAGE}`);
    expect(text).toContain("Reported by Sonarr — not helparr's reading.");

    // Offered, and it carries a record — never a plan, never a file list.
    const link = inspector.locator('a:has-text("Force import")');
    expect(await link.count()).toBe(1);
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/import\?instanceId=[^&]+&recordId=1$/);

    await page.click('[aria-label="Close inspector (Esc)"]');
    await expect.poll(() => page.locator('.inspector').count()).toBe(0);

    // No payload: no force import, and the reason it is not offered is said.
    await queueRow(GHOST.title).click();
    await page.waitForSelector('.inspector');
    const ghostText = (await page.locator('.inspector').textContent()) ?? '';
    expect(ghostText).toContain('state missingFiles');
    expect(ghostText).toContain('Force import is not offered — there is no payload to import.');
    expect(await page.locator('.inspector a:has-text("Force import")').count()).toBe(0);
    expect(await page.locator('.inspector a[href^="/import"]').count()).toBe(0);

    await page.click('[aria-label="Close inspector (Esc)"]');
    expect(manualImports()).toHaveLength(0);
  });

  it('lists every candidate verbatim, excludes replacements, and sends nothing until the typed count matches', async () => {
    sonarr.setImportHook((files) => ({
      succeeded: Object.fromEntries(files.map((file) => [
        file.path as string,
        `/tv/Reacher/Season 01/${(file.path as string).split('/').pop() as string}`,
      ])),
    }));

    await openForceImport();

    // Every candidate, with the item Sonarr resolved and its rejections verbatim.
    expect(await page.locator('table[role="grid"] tbody tr').count()).toBe(IMPORT_SET.length);
    expect(await page.locator('.totals__main').textContent()).toBe('3 candidates');
    expect(await gridRow(CAND_A.path as string).textContent()).toContain('Reacher — S01E02');
    expect(await gridRow(CAND_B.path as string).textContent()).toContain('Reacher — S01E03');
    expect(await gridRow(CAND_REPLACE.path as string).textContent()).toContain('Reacher — S01E04');
    const rejectedRow = gridRow(CAND_A.path as string);
    expect(await rejectedRow.textContent()).toContain('Sonarr rejected it, verbatim:');
    expect(await rejectedRow.locator('ul.msg-list li').allTextContents()).toEqual([SAMPLE_REJECTION]);
    expect(await gridRow(CAND_B.path as string).textContent()).toContain('no rejections');

    // The replacement starts excluded, and the screen says so twice.
    const replaceRow = gridRow(CAND_REPLACE.path as string);
    expect(await replaceRow.textContent()).toContain('Replaces existing file:');
    expect(await replaceRow.textContent()).toContain('Starts excluded — include it explicitly to replace that file.');
    expect(await replaceRow.locator('input[type="checkbox"]').isChecked()).toBe(false);
    expect(await gridRow(CAND_A.path as string).locator('input[type="checkbox"]').isChecked()).toBe(true);
    expect(await gridRow(CAND_B.path as string).locator('input[type="checkbox"]').isChecked()).toBe(true);
    const warning = page.locator('.callout--warn', { hasText: 'would replace a file already in your library' });
    expect(await warning.count()).toBe(1);
    expect(await warning.textContent()).toContain('1 candidate would replace a file already in your library.');
    expect(await warning.textContent()).toContain('Reacher.S01E04.1080p.WEB-DL-GROUP.mkv');
    expect(await warning.textContent()).toContain('— excluded');
    expect(await page.locator('.bulkbar__count').textContent()).toBe('2 included');

    // Review costs nothing.
    expect(manualImports()).toHaveLength(0);

    await page.click('.bulkbar--apply button:has-text("Import 2 files")');
    const dialog = page.locator('.modal[role="dialog"]');
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain('Import these files?');
    const confirm = dialog.locator('.btn-danger-solid');
    const hint = page.locator('#import-typed-hint');

    // State 1: empty — disabled, and says what will unlock it.
    expect(await hint.textContent()).toBe('Nothing is sent until this field reads 2.');
    expect(await confirm.isDisabled()).toBe(true);
    expect(await confirm.textContent()).toContain('Import 2 files');
    expect(manualImports()).toHaveLength(0);

    // State 2: the wrong number — still disabled, and says so.
    await page.fill('#import-typed-count', '3');
    expect(await hint.textContent()).toBe('That is not 2. The import stays disabled until it matches.');
    expect(await confirm.isDisabled()).toBe(true);
    expect(await page.getAttribute('#import-typed-count', 'aria-invalid')).toBe('true');
    expect(manualImports()).toHaveLength(0);

    // State 3: the exact count — enabled. Still nothing sent until it is pressed.
    await page.fill('#import-typed-count', '2');
    expect(await hint.textContent()).toBe('Confirmed.');
    expect(await confirm.isEnabled()).toBe(true);
    expect(manualImports()).toHaveLength(0);

    await confirm.click();

    await expect.poll(() => manualImports().length, { timeout: 20_000 }).toBe(1);
    const sent = manualImports()[0].body;
    expect(sent.importMode).toBe('auto');
    const sentPaths = (sent.files as Array<Record<string, unknown>>).map((file) => file.path).sort();
    expect(sentPaths).toEqual([CAND_A.path, CAND_B.path].sort());

    await expect.poll(
      () => page.locator('.ribbon__title').first().textContent(),
      { timeout: 30_000 },
    ).toBe('IMPORT COMPLETE — this is an applied result, not a preview');
    expect(await page.locator('#main').textContent()).toContain('2 of 2 files imported.');

    // Exactly one, still — the done screen does not re-send.
    expect(manualImports()).toHaveLength(1);
  });

  it('refuses the whole import when the candidate set moves between preview and confirm', async () => {
    await openForceImport();
    expect(await page.locator('table[role="grid"] tbody tr').count()).toBe(IMPORT_SET.length);

    // Sonarr's set moves under the open preview.
    sonarr.setImportCandidates([...IMPORT_SET, CAND_LATE]);

    await page.click('.bulkbar--apply button:has-text("Import 2 files")');
    const dialog = page.locator('.modal[role="dialog"]');
    await dialog.waitFor();
    await page.fill('#import-typed-count', '2');
    await dialog.locator('.btn-danger-solid').click();

    await expect.poll(
      () => page.locator('.ribbon__title').first().textContent(),
      { timeout: 20_000 },
    ).toBe('IMPORT REFUSED — nothing was imported');
    expect(await page.locator('.refusal__title').textContent())
      .toBe('Import refused — the candidate set changed since this preview');
    const changes = await page.locator('.refusal__paths li').allTextContents();
    expect(changes.some((change) => change.includes(CAND_LATE.path as string))).toBe(true);

    // Rebuild is the only control. No import button anywhere on the screen.
    expect((await page.locator('.refusal button').allTextContents()).map((t) => t.trim()))
      .toEqual(['Rebuild preview']);
    expect(await page.locator('#main button', { hasText: /^\s*Import/ }).count()).toBe(0);
    expect(await page.locator('.bulkbar--apply').count()).toBe(0);

    // And nothing reached the instance.
    expect(manualImports()).toHaveLength(0);

    // Rebuild reads the new set; still nothing sent.
    await page.click('.refusal button:has-text("Rebuild preview")');
    await expect.poll(() => page.locator('table[role="grid"] tbody tr').count(), { timeout: 20_000 })
      .toBe(IMPORT_SET.length + 1);
    expect(manualImports()).toHaveLength(0);
  });

  /* ── Bulk inclusion (queue-triage-ergonomics AC4–AC7, AC9) ─────────────── */

  const bulkGroup = () => page.locator('[role="group"][aria-label="Bulk actions"]');
  const included = () => page.locator('.bulkbar__count').textContent();

  it('includes 51 replacements in one action, and the gate then asks for 53', async () => {
    sonarr.setImportCandidates(PACK);
    sonarr.setImportHook((files) => ({
      succeeded: Object.fromEntries(files.map((file) => [
        file.path as string,
        `/tv/Reacher/Season 01/${(file.path as string).split('/').pop() as string}`,
      ])),
    }));

    await openForceImport();
    expect(await page.locator('table[role="grid"] tbody tr').count()).toBe(PACK.length);
    expect(await included()).toBe('2 included');

    const button = bulkGroup().locator('button', { hasText: 'Include all replacements' });
    expect(await button.textContent()).toBe('Include all replacements (51)');

    let patches = 0;
    const countPatch = (request: Request) => {
      if (request.method() === 'PATCH' && request.url().includes('/api/import/plan/')) patches += 1;
    };
    page.on('request', countPatch);
    await button.click();
    await expect.poll(included, { timeout: 10_000 }).toBe('53 included');
    page.off('request', countPatch);
    // One action, one edit: not 51 row PATCHes behind a single button.
    expect(patches).toBe(1);
    expect(await page.locator('.bulk-include__outcome').textContent()).toContain('Included 51 files.');
    expect(await button.textContent()).toBe('Include all replacements (0)');
    // A bulk edit is a plan edit, not an import.
    expect(manualImports()).toHaveLength(0);

    await page.click('.bulkbar--apply button:has-text("Import 53 files")');
    const dialog = page.locator('.modal[role="dialog"]');
    await dialog.waitFor();
    expect(await page.locator('#import-typed-hint').textContent()).toBe('Nothing is sent until this field reads 53.');
    await page.fill('#import-typed-count', '2');
    expect(await dialog.locator('.btn-danger-solid').isDisabled()).toBe(true);
    expect(manualImports()).toHaveLength(0);

    await page.fill('#import-typed-count', '53');
    expect(manualImports()).toHaveLength(0);
    await dialog.locator('.btn-danger-solid').click();

    await expect.poll(() => manualImports().length, { timeout: 20_000 }).toBe(1);
    expect((manualImports()[0].body.files as unknown[]).length).toBe(53);
    await expect.poll(
      () => page.locator('.ribbon__title').first().textContent(),
      { timeout: 30_000 },
    ).toBe('IMPORT COMPLETE — this is an applied result, not a preview');
  });

  it('skips an unmapped file on Include all and says how many and why', async () => {
    sonarr.setImportCandidates([...IMPORT_SET, CAND_UNMAPPED]);
    await openForceImport();
    expect(await included()).toBe('2 included');

    await bulkGroup().locator('button', { hasText: /^Include all$/ }).click();
    await expect.poll(included, { timeout: 10_000 }).toBe('3 included');
    expect(await page.locator('.bulk-include__outcome').textContent())
      .toContain('Included 1 · skipped 1 — no target');
    expect(await gridRow(CAND_UNMAPPED.path as string).locator('input[type="checkbox"]').isChecked()).toBe(false);
    await expect.poll(() => page.locator('main [role="status"]').filter({ hasText: 'now included' }).textContent())
      .toContain('3 of 4 files now included');
    expect(manualImports()).toHaveLength(0);
  });

  it('leaves every row as it was when a bulk edit fails', async () => {
    await openForceImport();
    const states = () => Promise.all(IMPORT_SET.map((c) => gridRow(c.path as string).locator('input[type="checkbox"]').isChecked()));
    const before = await states();
    expect(before).toEqual([true, true, false]);

    await page.route('**/api/import/plan/*', (route) => (
      route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()
    ));
    try {
      await bulkGroup().locator('button', { hasText: 'Exclude all' }).click();
      await expect.poll(() => page.locator('.bulk-include__outcome').textContent(), { timeout: 10_000 })
        .toContain('Nothing changed');
      expect(await states()).toEqual(before);
      expect(await included()).toBe('2 included');
    } finally {
      await page.unroute('**/api/import/plan/*');
    }

    // And the server agrees: a reload reads the same plan.
    await page.reload();
    await expect.poll(() => page.locator('table[role="grid"] tbody tr').count(), { timeout: 20_000 })
      .toBe(IMPORT_SET.length);
    expect(await states()).toEqual(before);
    expect(manualImports()).toHaveLength(0);
  });

  it('includes a shift+click range in one edit, replacements and all', async () => {
    await openForceImport();
    await bulkGroup().locator('button', { hasText: 'Exclude all' }).click();
    await expect.poll(included, { timeout: 10_000 }).toBe('0 included');

    const box = (c: Record<string, unknown>) => gridRow(c.path as string).locator('input[type="checkbox"]');
    await box(CAND_A).click();
    await expect.poll(included, { timeout: 10_000 }).toBe('1 included');

    await box(CAND_REPLACE).click({ modifiers: ['Shift'] });
    await expect.poll(included, { timeout: 10_000 }).toBe('3 included');
    expect(await box(CAND_B).isChecked()).toBe(true);
    expect(await box(CAND_REPLACE).isChecked()).toBe(true);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    // The click left focus off the checkbox, so the list keys still work.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
    expect(manualImports()).toHaveLength(0);
  });

  describe('decision explainer from three entry points', () => {
    it('search: release inspector → Evaluate → Compare with file on disk', async () => {
      await page.goto(`${app.origin}/search`);
      await page.fill('#search-query', 'show');
      await page.click('form.stoolbar button[type="submit"]');
      await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 }).toBe(2);

      await page.locator('.rgrid__body-row', { hasText: RELEASE_CANDIDATE.title }).click();
      await page.waitForSelector('.inspector');
      expect(await page.textContent('.inspector__title')).toBe(RELEASE_CANDIDATE.title);

      await page.locator('#evaluate-target').selectOption({ label: 'Sonarr' });
      await page.click('.evaluate-row button');
      const inspector = page.locator('.inspector');
      await expect.poll(() => inspector.textContent(), { timeout: 20_000 })
        .toContain('Rejected by Sonarr — 1 reason.');
      expect(await inspector.locator('ul.msg-list li').allTextContents()).toContain(CF_REJECTION);

      await inspector.locator('button:has-text("Compare with file on disk")').click();
      const section = inspector.locator('section[aria-label="Candidate compared with the file on disk"]');
      await expect.poll(() => section.textContent(), { timeout: 20_000 }).toContain('Candidate vs. on disk');

      const read = await readComparison(section);
      expect(read.candidate.Quality).toBe('WEBDL-1080p');
      expect(read.candidate['Total CF']).toBe('-50 (from release name)');
      expect(read.onDisk.Quality).toBe('Bluray-1080p');
      expect(read.onDisk['Total CF']).toBe('20 (from filename)');
      expect(read.profile['Cutoff quality']).toBe('Bluray-1080p');
      expect(read.profile['Min. CF score']).toBe('10');
      expect(read.text).toContain('Profile: HD-1080p');

      // The comparison supplements the reason; it does not replace it.
      expect(await inspector.locator('ul.msg-list li').allTextContents()).toContain(CF_REJECTION);
      await page.click('[aria-label="Close inspector (Esc)"]');
    });

    it('queue: import-rejected → Compare with the files on disk', async () => {
      sonarr.setImportCandidates([QUEUE_EXPLAIN_CANDIDATE]);

      await openQueue();
      await queueRow(REJECTED.title).click();
      await page.waitForSelector('.inspector');
      const inspector = page.locator('.inspector');

      await inspector.locator('button:has-text("Compare with the files on disk")').click();
      const section = inspector.locator('section[aria-label="Rejected files compared with the files on disk"]');
      await expect.poll(() => section.textContent(), { timeout: 20_000 }).toContain('Candidate vs. on disk');

      const sectionText = (await section.textContent()) ?? '';
      expect(sectionText).toContain('Reacher.S01E01.1080p.WEB-DL-GROUP.mkv');
      expect(sectionText).toContain('Rejected by Sonarr — 1 reason.');
      expect(await section.locator('ul.msg-list li').allTextContents()).toContain(REJECTION_MESSAGE);

      const read = await readComparison(section);
      expect(read.candidate.Quality).toBe('WEBDL-1080p');
      // An import candidate is scored from its file name, and says so (ADR-12).
      expect(read.candidate['Total CF']).toBe('-50 (from filename)');
      expect(read.onDisk.Quality).toBe('Bluray-1080p');
      expect(read.onDisk['Total CF']).toBe('20 (from filename)');
      expect(read.profile['Cutoff quality']).toBe('Bluray-1080p');
      expect(read.profile['Min. CF score']).toBe('10');

      // The Cause group's verbatim evidence is still on screen beside it.
      expect(await inspector.textContent()).toContain(`${REJECTED.statusMessages![0].title}: ${REJECTION_MESSAGE}`);
      await page.click('[aria-label="Close inspector (Esc)"]');
    });

    it('gaps: inspector → Evaluate releases → expand → comparison', async () => {
      await page.goto(`${app.origin}/gaps`);
      await expect.poll(() => page.locator('.ggrid__body-row').count(), { timeout: 30_000 }).toBe(1);
      await page.locator('.ggrid__body-row').first().click();
      await page.waitForSelector('.inspector');
      const inspector = page.locator('.inspector');

      // The quota warning is on screen before the button is pressed.
      expect(await inspector.textContent()).toContain('Nothing is searched until you press the button.');
      await inspector.locator('button:has-text("Evaluate releases")').click();

      const rejectedList = inspector.locator('ul[aria-label="Releases Sonarr rejected"]');
      await expect.poll(() => rejectedList.count(), { timeout: 20_000 }).toBe(1);
      const disclosure = rejectedList.locator('button[aria-expanded]').first();
      expect(await disclosure.getAttribute('aria-expanded')).toBe('false');
      await disclosure.click();
      expect(await disclosure.getAttribute('aria-expanded')).toBe('true');

      const section = rejectedList.locator('section[aria-label="Candidate compared with the file on disk"]');
      await expect.poll(() => section.textContent(), { timeout: 20_000 }).toContain('Candidate vs. on disk');

      const read = await readComparison(section);
      expect(read.candidate.Quality).toBe('WEBDL-1080p');
      expect(read.candidate['Total CF']).toBe('-50 (from release name)');
      // A gap has no file by construction — stated in words, never a zero.
      expect(read.onDiskText).toContain('No file on disk');
      expect(read.profile['Cutoff quality']).toBe('Bluray-1080p');
      expect(read.profile['Min. CF score']).toBe('10');

      expect(await rejectedList.locator('ul.msg-list li').allTextContents()).toContain(CF_REJECTION);
      await page.click('[aria-label="Close inspector (Esc)"]');
    });
  });

  describe('unmapped', () => {
    it('is reached by key 7, keeps unknown distinct from none, and moves by keyboard', async () => {
      await openQueue();
      await page.locator('#main').focus();
      await page.keyboard.press('7');
      await page.waitForURL(/\/unmapped$/);

      await expect.poll(() => page.locator('.ggrid__body-row').count(), { timeout: 20_000 }).toBe(3);

      // Unknown: the badge and a sentence naming the instance and the likely cause.
      const slow = page.locator('div:has(> h3:has-text("/media/slow"))');
      const slowText = (await slow.textContent()) ?? '';
      expect(slowText).toContain('unknown');
      expect(slowText).toContain('Unknown — Sonarr did not report unmapped folders for this root folder.');
      expect(await slow.locator('.badge-warn').count()).toBe(1);
      expect(slowText).not.toContain('0 unmapped');

      // None: a plain zero and a plain sentence, no warning badge.
      const empty = page.locator('div:has(> h3:has-text("/media/empty"))');
      const emptyText = (await empty.textContent()) ?? '';
      expect(emptyText).toContain('0 unmapped');
      expect(emptyText).toContain('Sonarr reported none.');
      expect(await empty.locator('.badge-warn').count()).toBe(0);
      expect(emptyText).not.toContain('Unknown');

      // Listed, on both instances.
      const listed = page.locator('div:has(> h3:has-text("/media/tv"))');
      expect(await listed.textContent()).toContain('2 unmapped');

      // Keyboard: j/k move one cursor through the folders in the order they
      // render, across the instance boundary (two instances, three folders).
      const names = (await page.locator('.ggrid__body-row .truncate[title]:not(.mono)').allTextContents())
        .map((name) => name.trim());
      expect([...names].sort()).toEqual(['Andor', 'Arrival (2016)', 'Severance']);
      const cursor = async () => ((await page.locator('.ggrid__body-row.is-cursor .truncate:not(.mono)').textContent()) ?? '').trim();
      await page.keyboard.press('Home');
      expect(await cursor()).toBe(names[0]);
      await page.keyboard.press('j');
      expect(await cursor()).toBe(names[1]);
      await page.keyboard.press('j');
      expect(await cursor()).toBe(names[2]);
      await page.keyboard.press('k');
      expect(await cursor()).toBe(names[1]);
      expect(await page.locator('.ggrid__body-row.is-cursor').count()).toBe(1);

      // Enter opens helparr's own search for that folder — a link, never a write.
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.pathname === '/search'
        && url.searchParams.get('q') === names[1]);
      expect(sonarr.commands).toHaveLength(0);
      expect(radarr.commands).toHaveLength(0);
    });

    it('still renders Sonarr when Radarr cannot be read, and names Radarr', async () => {
      radarr.setMode('server-error');
      try {
        await page.goto(`${app.origin}/unmapped`);
        await expect.poll(() => page.locator('.banner').count(), { timeout: 20_000 }).toBe(1);

        const banner = (await page.locator('.banner').textContent()) ?? '';
        expect(banner).toContain('Radarr');
        expect(banner).toContain('did not respond');
        expect(banner).not.toContain('Sonarr');

        // Radarr in its own place: not read, unknown — never empty.
        const radarrSection = page.locator('section:has(h2:has-text("Radarr"))').last();
        const radarrText = (await radarrSection.textContent()) ?? '';
        expect(radarrText).toContain('not read');
        expect(radarrText).toContain('Its root folders are unknown, not empty.');

        // Sonarr's folders are all still there.
        const rows = await page.locator('.ggrid__body-row').allTextContents();
        expect(rows).toHaveLength(2);
        expect(rows.join(' ')).toContain('Severance');
        expect(rows.join(' ')).toContain('Andor');
        expect(rows.join(' ')).not.toContain('Arrival');
        expect(await page.locator('#main').textContent()).not.toContain('Nothing unmapped across any instance');
      } finally {
        radarr.setMode('ok');
      }
    });
  });
});
