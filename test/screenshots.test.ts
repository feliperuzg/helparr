import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import {
  parsedSeries, startFakeArr, type FakeArr, type FakeGapRecord, type FakeQueueRecord,
} from './helpers/fakeArr';
import { startFakeProwlarr, type FakeProwlarr, type FakeRelease } from './helpers/fakeProwlarr';
import { startFakeQbit, type FakeQbit } from './helpers/fakeQbit';

/**
 * The README's screenshots, generated rather than captured by hand.
 *
 * A screenshot is a claim about what the app looks like, and a hand-captured
 * one rots the moment a screen changes — silently, because nothing checks it.
 * This file is the same browser lane the e2e suites use, pointed at the same
 * fakes, so the images come from the real standalone build driven through the
 * real API and go stale loudly: if a selector here stops matching, the run
 * fails instead of writing a stale picture.
 *
 * It also settles a second thing. Every title, path and release name below is
 * invented, so no screenshot in this repository can ever show what is in
 * anybody's actual library.
 *
 * Run with `npm run build:screenshots`; gated behind HELPARR_SHOTS so the
 * default lane never pays for a Chromium boot.
 */

const PORT = 3982;
const PASSWORD = 'setup-password-for-the-screenshot-run';
/** Changed during setup, so the "still using the setup password" banner is down. */
const ROTATED = 'rotated-password-for-the-screenshot-run';

const OUT_DIR = join(process.cwd(), 'docs', 'screenshots');
/**
 * Wide enough that the widest grid — the queue, at eight columns — fits without
 * its last column clipping. Narrower is a supported layout, not a flattering
 * screenshot.
 */
const VIEWPORT = { width: 1600, height: 900 };
/** Committed at 1280 — Github renders READMEs narrower than that anyway. */
const OUTPUT_WIDTH = 1280;

/* ── Fixture library ─────────────────────────────────────────────────────── */

const SERIES = [
  { id: 1, title: 'Northwind', path: '/tv/Northwind', qualityProfileId: 3, statistics: { episodeFileCount: 24 } },
  { id: 2, title: 'Salt Harbour', path: '/tv/Salt Harbour', qualityProfileId: 3, statistics: { episodeFileCount: 16 } },
  { id: 3, title: 'The Cartographer', path: '/tv/The Cartographer', qualityProfileId: 4, statistics: { episodeFileCount: 0 } },
];

const MOVIES = [
  { id: 7, title: 'Ember Road', year: 2024, hasFile: true },
  { id: 8, title: 'Vantage Point Nine', year: 2023, hasFile: true },
];

function grabbed(
  id: number,
  title: string,
  series: string,
  season: number,
  episode: number,
  indexer: string,
  sizeleft: number,
): FakeQueueRecord {
  return {
    id,
    title,
    size: 4_800_000_000,
    sizeleft,
    protocol: 'torrent',
    indexer,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    downloadId: `HASH${id}`,
    series: { title: series },
    episodes: [{ seasonNumber: season, episodeNumber: episode }],
  };
}

/** The row the Overview exists for: finished downloading, stuck on import. */
const STALLED: FakeQueueRecord = {
  id: 1,
  title: 'Northwind.S02E05.2160p.WEB-DL.DV.HDR10-ORBIT',
  size: 7_400_000_000,
  sizeleft: 0,
  protocol: 'torrent',
  indexer: 'Nebula',
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importBlocked',
  downloadId: 'HASH1',
  statusMessages: [{
    title: 'Northwind.S02E05.2160p.WEB-DL.DV.HDR10-ORBIT',
    messages: ['Found matching series via grab history, but series was not found in your library.'],
  }],
  series: { title: 'Northwind' },
  episodes: [{ seasonNumber: 2, episodeNumber: 5 }],
};

const SONARR_QUEUE: FakeQueueRecord[] = [
  STALLED,
  grabbed(2, 'Northwind.S02E06.2160p.WEB-DL.DV.HDR10-ORBIT', 'Northwind', 2, 6, 'Nebula', 1_900_000_000),
  grabbed(3, 'Salt.Harbour.S01E03.1080p.WEB-DL.DDP5.1-CASTLE', 'Salt Harbour', 1, 3, 'Driftwood', 620_000_000),
  grabbed(4, 'Salt.Harbour.S01E04.1080p.WEB-DL.DDP5.1-CASTLE', 'Salt Harbour', 1, 4, 'Driftwood', 3_100_000_000),
];

/**
 * The download id whose torrent is given no peers and no speed below.
 *
 * Sonarr reports it `ok` — it handed the release to the client and has nothing
 * further to say — and helparr disagrees from the client's own evidence. That
 * disagreement is the reason the Overview exists, so it belongs in the picture
 * of it.
 */
const STALLED_HASH = 'HASH4';

const RADARR_QUEUE: FakeQueueRecord[] = [
  {
    id: 20,
    title: 'Ember.Road.2024.2160p.UHD.BluRay.x265-SENTINEL',
    size: 24_000_000_000,
    sizeleft: 9_800_000_000,
    protocol: 'torrent',
    indexer: 'Nebula',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    downloadId: 'HASH20',
    movie: { title: 'Ember Road', year: 2024 },
  },
];

function episode(
  id: number, seriesId: number, season: number, number_: number, title: string, aired: string,
): FakeGapRecord {
  return {
    id,
    seriesId,
    seasonNumber: season,
    episodeNumber: number_,
    title,
    airDateUtc: aired,
    monitored: true,
    hasFile: false,
  };
}

const WANTED: FakeGapRecord[] = [
  episode(101, 1, 2, 7, 'The Long Watch', '2026-02-11T00:00:00Z'),
  episode(102, 1, 2, 8, 'Low Tide', '2026-02-18T00:00:00Z'),
  episode(201, 2, 1, 5, 'Breakwater', '2026-03-02T00:00:00Z'),
  episode(301, 3, 1, 1, 'First Survey', '2026-04-06T00:00:00Z'),
  episode(302, 3, 1, 2, 'Contour Lines', '2026-04-13T00:00:00Z'),
];

const MISSING_FILM: FakeGapRecord = {
  id: 9,
  title: 'Vantage Point Nine',
  year: 2023,
  status: 'released',
  monitored: true,
  hasFile: false,
  path: '/films/Vantage Point Nine (2023)',
  qualityProfileId: 1,
};

function release(
  guid: string, title: string, indexerId: number, indexer: string,
  size: number, seeders: number, ageHours: number,
): FakeRelease {
  return {
    guid,
    title,
    indexerId,
    indexer,
    protocol: 'torrent',
    size,
    seeders,
    leechers: Math.max(1, Math.round(seeders / 8)),
    ageHours,
    publishDate: '2026-09-01T00:00:00Z',
    infoHash: guid,
    indexerFlags: [],
    downloadUrl: `http://prowlarr.invalid/download?guid=${guid}`,
  };
}

const NEBULA_RESULTS: FakeRelease[] = [
  release('nebula-1', 'Northwind.S02E05.2160p.WEB-DL.DV.HDR10.Atmos-ORBIT', 4, 'Nebula', 7_400_000_000, 148, 6),
  release('nebula-2', 'Northwind.S02E05.1080p.WEB-DL.DDP5.1-ORBIT', 4, 'Nebula', 3_200_000_000, 96, 6),
  release('nebula-3', 'Northwind.S02E05.2160p.WEB.H265-MERIDIAN', 4, 'Nebula', 6_100_000_000, 31, 9),
  release('drift-1', 'Northwind.S02E05.1080p.WEB.h264-CASTLE', 7, 'Driftwood', 2_700_000_000, 54, 11),
  release('drift-2', 'Northwind.S02E05.REPACK.1080p.WEB-DL.DDP5.1-CASTLE', 7, 'Driftwood', 2_900_000_000, 18, 4),
  release('drift-3', 'Northwind.S02E05.720p.WEB-DL.AAC2.0-LANTERN', 7, 'Driftwood', 1_400_000_000, 7, 20),
];

/** One Sonarr `/rename` preview row, in the shape a real instance returns. */
function previewRow(fileId: number, season: number, existing: string, proposed: string): unknown {
  return {
    seriesId: 1,
    seasonNumber: season,
    episodeNumbers: [fileId - 100],
    episodeFileId: fileId,
    existingPath: existing,
    newPath: proposed,
  };
}

const RENAME_PREVIEW = [
  previewRow(101, 1, 'northwind.s01e01.1080p.web.mkv', 'Season 01/Northwind - S01E01 - The Turning [WEBDL-1080p].mkv'),
  previewRow(102, 1, 'northwind.s01e02.1080p.web.mkv', 'Season 01/Northwind - S01E02 - Nine Degrees [WEBDL-1080p].mkv'),
  previewRow(103, 1, 'northwind.s01e03.1080p.web.mkv', 'Season 01/Northwind - S01E03 - Cold Front [WEBDL-1080p].mkv'),
  previewRow(104, 1, 'northwind.s01e04.1080p.web.mkv', 'Season 01/Northwind - S01E04 - The Long Watch [WEBDL-1080p].mkv'),
  previewRow(105, 1, 'northwind.s01e05.1080p.web.mkv', 'Season 01/Northwind - S01E05 - Low Tide [WEBDL-1080p].mkv'),
];

/* ── Triage fixture (T27, stuck-item-triage) ─────────────────────────────── */

/**
 * The triage screenshots live beside the README's rather than among them.
 * `npm run site` copies `docs/screenshots/` verbatim into the published site,
 * and `site/weight-baseline.json` accounts for exactly the four files there —
 * a fifth would fail `site-weight` without the page ever referencing it.
 */
const TRIAGE_OUT_DIR = join(process.cwd(), 'docs', 'triage');

/** A season pack Sonarr finished downloading and then declined to import. */
const REJECTED_HASH = 'HASH5';
const EXISTING_FILE_ID = 701;
const PACK_DIR = '/downloads/Northwind.S02.2160p.WEB-DL.DV.HDR10-ORBIT';
const NOT_AN_UPGRADE =
  'Not an upgrade for existing episode file(s). Existing quality: WEBDL-2160p. New Quality WEBDL-2160p.';
/** Two of the three files; the one that would replace a file starts excluded. */
const PACK_INCLUDED = 2;

const WEBDL_2160P = {
  quality: { id: 18, name: 'WEBDL-2160p', source: 'web', resolution: 2160 },
  revision: { version: 1, real: 0, isRepack: false },
};

const REJECTED: FakeQueueRecord = {
  id: 5,
  title: 'Northwind.S02.2160p.WEB-DL.DV.HDR10-ORBIT',
  size: 22_000_000_000,
  sizeleft: 0,
  protocol: 'torrent',
  indexer: 'Nebula',
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importPending',
  downloadId: REJECTED_HASH,
  statusMessages: [{ title: 'Northwind.S02E01.2160p.WEB-DL.DV.HDR10-ORBIT.mkv', messages: [NOT_AN_UPGRADE] }],
  series: { title: 'Northwind' },
  episodes: [{ seasonNumber: 2, episodeNumber: 1 }],
};

const CUSTOM_FORMATS = [
  { id: 1, name: 'DV HDR10' },
  { id: 2, name: 'Atmos' },
  { id: 3, name: 'Tier 1 group' },
];

/** WEB-2160p in full, so the comparison states real thresholds. */
const PROFILE_DETAIL = {
  id: 3,
  name: 'WEB-2160p',
  upgradeAllowed: true,
  cutoff: 18,
  items: [{ quality: { id: 18, name: 'WEBDL-2160p' }, allowed: true }],
  minFormatScore: 0,
  cutoffFormatScore: 1500,
  minUpgradeFormatScore: 10,
  formatItems: [
    { format: 1, name: 'DV HDR10', score: 1000 },
    { format: 2, name: 'Atmos', score: 500 },
    { format: 3, name: 'Tier 1 group', score: 150 },
  ],
};

const EXISTING_FILE = {
  id: EXISTING_FILE_ID,
  path: '/tv/Northwind/Season 02/Northwind - S02E01 - Undertow [WEBDL-2160p].mkv',
  relativePath: 'Season 02/Northwind - S02E01 - Undertow [WEBDL-2160p].mkv',
  sceneName: 'Northwind.S02E01.2160p.WEB-DL.DV.HDR10.Atmos-LANTERN',
  size: 8_100_000_000,
  quality: WEBDL_2160P,
  customFormats: [{ id: 1, name: 'DV HDR10' }, { id: 2, name: 'Atmos' }],
  customFormatScore: 1500,
  languages: [{ id: 1, name: 'English' }],
  qualityCutoffNotMet: false,
};

/** One file that would replace a file on disk, two that land on empty episodes. */
function packCandidates(): Array<Record<string, unknown>> {
  const titles = ['Undertow', 'Slack Water', 'The Sounding'];
  return titles.map((title, i) => {
    const n = i + 1;
    const name = `Northwind.S02E0${n}.2160p.WEB-DL.DV.HDR10-ORBIT.mkv`;
    const replaces = n === 1;
    return {
      path: `${PACK_DIR}/${name}`,
      relativePath: name,
      name,
      size: 7_300_000_000 + n,
      quality: WEBDL_2160P,
      languages: [{ id: 1, name: 'English' }],
      releaseGroup: 'ORBIT',
      indexerFlags: 0,
      releaseType: 'singleEpisode',
      customFormats: [{ id: 1, name: 'DV HDR10' }, { id: 3, name: 'Tier 1 group' }],
      customFormatScore: 1150,
      rejections: replaces ? [{ reason: NOT_AN_UPGRADE, type: 'permanent' }] : [],
      downloadId: REJECTED_HASH,
      series: { id: 1, title: 'Northwind', qualityProfileId: 3 },
      seasonNumber: 2,
      episodes: [{
        id: 400 + n,
        seasonNumber: 2,
        episodeNumber: n,
        title,
        hasFile: replaces,
        episodeFileId: replaces ? EXISTING_FILE_ID : null,
      }],
    };
  });
}

/** Sonarr's own search over the same releases Prowlarr returned, each with its verdict. */
function releaseCandidates(): unknown[] {
  return NEBULA_RESULTS.map((result, i) => ({
    title: result.title,
    guid: result.guid,
    infoHash: result.infoHash,
    indexer: result.indexer,
    quality: WEBDL_2160P,
    customFormats: i === 0
      ? [{ id: 1, name: 'DV HDR10' }, { id: 2, name: 'Atmos' }]
      : [{ id: 3, name: 'Tier 1 group' }],
    customFormatScore: i === 0 ? 1500 : 150,
    rejections: [{
      reason: i === 0
        ? 'Existing file on disk is of equal or higher preference: WEBDL-2160p v1'
        : 'Existing file on disk has a equal or higher Custom Format score: 1500',
      type: 'permanent',
    }],
    episodes: [{ id: 405 }],
  }));
}

/** Sonarr's reading of Northwind S02E05 — an episode it already has a file for. */
const PARSED_WITH_FILE = {
  series: { id: 1, title: 'Northwind', qualityProfileId: 3 },
  episodes: [{
    id: 405, seasonNumber: 2, episodeNumber: 5, hasFile: true, episodeFileId: EXISTING_FILE_ID,
  }],
  parsedEpisodeInfo: {
    quality: { quality: { name: 'WEBDL-2160p' } },
    releaseGroup: 'ORBIT',
    seasonNumber: 2,
  },
};

/** One root Sonarr lists folders under, and one it never reported on. */
const SONARR_ROOTS = [
  {
    id: 1,
    path: '/tv',
    accessible: true,
    freeSpace: 3_400_000_000_000,
    unmappedFolders: [
      { name: 'Lighthouse Keepers', path: '/tv/Lighthouse Keepers', relativePath: 'Lighthouse Keepers' },
      { name: 'Meridian (2019)', path: '/tv/Meridian (2019)', relativePath: 'Meridian (2019)' },
      { name: 'Tidewater', path: '/tv/Tidewater', relativePath: 'Tidewater' },
    ],
  },
  { id: 2, path: '/archive/tv', accessible: true, freeSpace: 900_000_000_000 },
];

/** Radarr's one root, with nothing unmapped under it — "none", not "unknown". */
const RADARR_ROOTS = [
  { id: 1, path: '/films', accessible: true, freeSpace: 2_100_000_000_000, unmappedFolders: [] },
];

/* ── Harness ─────────────────────────────────────────────────────────────── */

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let radarr: FakeArr;
let prowlarr: FakeProwlarr;
let qbit: FakeQbit;

/**
 * Writes one screenshot, downscaled and palette-encoded.
 *
 * A raw 1440×900 truecolor capture of a flat UI is ~400 kB; the same image as a
 * 1280-wide indexed PNG is a fifth of that and indistinguishable in a README.
 * The repository carries these forever, so the encoding is not a detail.
 */
async function capture(name: string, dir = OUT_DIR): Promise<number> {
  // Fonts and any entry transition have to have finished, or two runs of this
  // file produce two different images from the same state.
  await page.waitForTimeout(400);
  const raw = await page.screenshot({ type: 'png' });
  const info = await sharp(raw)
    .resize({ width: OUTPUT_WIDTH })
    .png({ compressionLevel: 9, palette: true })
    .toFile(join(dir, `${name}.png`));
  return info.size;
}

/** The Overview's inspector, open on the rejected season pack. */
async function openRejectedInspector() {
  await page.goto(`${app.origin}/`);
  await page.click('.qgrid__body-row:has-text("Northwind.S02.2160p")', { timeout: 60_000 });
  await page.waitForSelector('.inspector :text("Cause")');
}

/** A fresh force-import preview of the rejected pack, from the inspector's own link. */
async function openForceImport() {
  await openRejectedInspector();
  const href = await page.getAttribute('.inspector a:has-text("Force import")', 'href');
  expect(href, 'the inspector offered no Force import link').toBeTruthy();
  await page.goto(new URL(href as string, app.origin).toString());
  await page.waitForSelector('.ribbon--preview', { timeout: 60_000 });
  await expect.poll(() => page.textContent('.bulkbar--apply .bulkbar__count'), { timeout: 60_000 })
    .toContain(`${PACK_INCLUDED} included`);
}

/** Preview → typed confirmation, with the right count typed. */
async function confirmImport() {
  await page.click('.bulkbar--apply .btn-danger-solid');
  await page.fill('#import-typed-count', String(PACK_INCLUDED));
  await expect.poll(() => page.isDisabled('.modal__foot .btn-danger-solid')).toBe(false);
}

describe('screenshots', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });

    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: SONARR_QUEUE });
    sonarr.setSeries(SERIES);
    sonarr.setSeriesDetail({ id: 1, title: 'Northwind', path: '/tv/Northwind' });
    sonarr.setWanted(WANTED);
    sonarr.setProfiles([{ id: 3, name: 'WEB-2160p' }, { id: 4, name: 'WEB-1080p' }]);
    sonarr.setParse(parsedSeries({ id: 1, title: 'Northwind', season: 2, episode: 5 }));
    sonarr.setRenamePreview(RENAME_PREVIEW);

    radarr = await startFakeArr({ apiKey: 'radarr-key', queue: RADARR_QUEUE });
    radarr.setMovies(MOVIES);
    radarr.setWanted([MISSING_FILM]);
    radarr.setProfiles([{ id: 1, name: 'UHD-2160p' }]);

    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'Nebula' }, { id: 7, name: 'Driftwood' }],
    });
    prowlarr.setResults(null, NEBULA_RESULTS);
    prowlarr.setResults(4, NEBULA_RESULTS.filter((r) => r.indexerId === 4));
    prowlarr.setResults(7, NEBULA_RESULTS.filter((r) => r.indexerId === 7));

    qbit = await startFakeQbit({
      username: 'admin',
      password: 'adminadmin',
      torrents: SONARR_QUEUE.concat(RADARR_QUEUE).map((record) => {
        const hash = String(record.downloadId);
        const progress = 1 - (record.sizeleft ?? 0) / (record.size ?? 1);
        if (hash === STALLED_HASH) {
          return { hash, progress, num_seeds: 0, num_leechs: 0, dlspeed: 0, eta: 8_640_000, state: 'stalledDL' };
        }
        return {
          hash,
          progress,
          num_seeds: 24,
          num_leechs: 3,
          dlspeed: 8_400_000,
          eta: 900,
          state: 'downloading',
        };
      }),
    });

    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: VIEWPORT });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);

    // Every screen carries a banner until the setup password is replaced. A
    // screenshot of a half-finished install is not what the README is claiming,
    // so the capture finishes the install the way an operator would.
    await page.evaluate(
      async ([current, next]) => {
        const response = await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword: current, newPassword: next }),
        });
        if (!response.ok) throw new Error(`password rotation failed: ${response.status}`);
      },
      [PASSWORD, ROTATED] as const,
    );

    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
    await seedInstance(page, 'radarr', 'Radarr', radarr.url, { type: 'api-key', apiKey: 'radarr-key' });
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, { type: 'api-key', apiKey: 'prowlarr-key' });
    await seedInstance(page, 'download-client', 'qBittorrent', qbit.url, {
      type: 'userpass', username: 'admin', password: 'adminadmin',
    });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
    await radarr?.close();
    await prowlarr?.close();
    await qbit?.close();
  });

  it('captures the overview', async () => {
    await page.goto(`${app.origin}/`);
    await expect.poll(() => page.locator('.qgrid__body-row').count(), { timeout: 60_000 })
      .toBe(SONARR_QUEUE.length + RADARR_QUEUE.length);
    expect(await capture('overview')).toBeGreaterThan(0);
  });

  it('captures an indexer search', async () => {
    await page.goto(`${app.origin}/search`);
    await page.fill('#search-query', 'Northwind S02E05');
    await page.click('form.stoolbar button[type="submit"]');
    await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 60_000 })
      .toBe(NEBULA_RESULTS.length);
    // Off the query field, so the caret is not blinking in the capture.
    await page.click('.rgrid__head');
    expect(await capture('search')).toBeGreaterThan(0);
  });

  it('captures the library gaps', async () => {
    await page.goto(`${app.origin}/gaps`);
    await expect.poll(() => page.locator('.ggrid__body-row').count(), { timeout: 60_000 })
      .toBe(WANTED.length + 1);
    expect(await capture('gaps')).toBeGreaterThan(0);
  });

  it('captures a rename preview', async () => {
    await page.goto(`${app.origin}/rename`);
    await page.waitForSelector('.scope__item', { timeout: 60_000 });
    await page.check('.scope__item:has-text("Northwind") input[type="checkbox"]');
    await page.click('.scope__foot button');
    await expect.poll(() => page.locator('.pgrid__body-row').count(), { timeout: 60_000 })
      .toBe(RENAME_PREVIEW.length);
    expect(await capture('rename')).toBeGreaterThan(0);
  });
  /*
   * T27 (stuck-item-triage): the screens an operator reaches when something is
   * stuck. Written to `docs/triage/`, not the README's directory — see
   * TRIAGE_OUT_DIR. The rejected pack joins the queue only here, so the four
   * captures above are of the same queue they always were.
   */
  describe('stuck-item triage', () => {
    beforeAll(() => {
      mkdirSync(TRIAGE_OUT_DIR, { recursive: true });

      sonarr.setQueue([...SONARR_QUEUE, REJECTED]);
      sonarr.setProfiles([PROFILE_DETAIL, { id: 4, name: 'WEB-1080p' }]);
      sonarr.setCustomFormats(CUSTOM_FORMATS);
      sonarr.setExistingFile(EXISTING_FILE_ID, EXISTING_FILE);
      sonarr.setImportCandidates(packCandidates());
      sonarr.setParse(PARSED_WITH_FILE);
      sonarr.setCandidates(releaseCandidates());
      sonarr.setRootFolders(SONARR_ROOTS);
      radarr.setRootFolders(RADARR_ROOTS);

      // Finished and seeding: the client has the whole payload, so the cause
      // the inspector names is Sonarr's refusal and nothing upstream of it.
      qbit.setTorrents([
        ...SONARR_QUEUE.concat(RADARR_QUEUE).map((record) => {
          const hash = String(record.downloadId);
          const progress = 1 - (record.sizeleft ?? 0) / (record.size ?? 1);
          return hash === STALLED_HASH
            ? { hash, progress, num_seeds: 0, num_leechs: 0, dlspeed: 0, eta: 8_640_000, state: 'stalledDL' }
            : { hash, progress, num_seeds: 24, num_leechs: 3, dlspeed: 8_400_000, eta: 900, state: 'downloading' };
        }),
        {
          hash: REJECTED_HASH,
          progress: 1,
          num_seeds: 0,
          num_leechs: 2,
          dlspeed: 0,
          eta: 8_640_000,
          state: 'uploading',
          completion_on: Math.floor(Date.now() / 1000) - 3 * 3600,
        },
      ]);
    });

    it('captures the cause inspector with the comparison open', async () => {
      await openRejectedInspector();
      await page.click('.inspector button:has-text("Compare with the files on disk")');
      await page.locator('.inspector :text("Candidate vs. on disk")').first().waitFor({ timeout: 60_000 });
      // The Cause group at the top of the panel, the comparison running on
      // below it: the picture is of the two together, not of either alone.
      await page.locator('.inspector__group-title:text-is("Cause")').evaluate((el) => {
        el.scrollIntoView({ block: 'start' });
        // scrollIntoView scrolls every ancestor, the document included; only
        // the panel's own scroll was wanted.
        document.scrollingElement?.scrollTo(0, 0);
      });
      expect(await capture('queue-cause', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
    });

    it('captures a force-import preview with a replacement row', async () => {
      await openForceImport();
      await page.waitForSelector('text=would replace a file');
      expect(await capture('import-review', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
    });

    it('captures the force-import confirmation', async () => {
      await openForceImport();
      await confirmImport();
      expect(await capture('import-confirm', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
    });

    it('captures a force import refused on drift', async () => {
      await openForceImport();
      // The third file leaves the candidate set between preview and confirm.
      sonarr.setImportCandidates(packCandidates().filter((c) => !String(c.path).includes('S02E03')));
      try {
        await confirmImport();
        await page.click('.modal__foot .btn-danger-solid');
        await page.waitForSelector('.refusal__paths li', { timeout: 60_000 });
        expect(await capture('import-refused', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
      } finally {
        sonarr.setImportCandidates(packCandidates());
      }
    });

    it('captures a completed force import', async () => {
      await openForceImport();
      sonarr.setImportHook((files) => ({
        succeeded: Object.fromEntries(files.map((file) => {
          const name = String(file.path).split('/').at(-1) ?? '';
          return [String(file.path), `/tv/Northwind/Season 02/${name}`];
        })),
      }));
      try {
        await confirmImport();
        await page.click('.modal__foot .btn-danger-solid');
        await page.waitForSelector('.ribbon--done', { timeout: 60_000 });
        await page.waitForSelector('table[aria-label="Files sent and what each one did"]');
        expect(await capture('import-done', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
      } finally {
        sonarr.setImportHook(null);
        sonarr.setImportCandidates(packCandidates());
      }
    });

    it('captures the decision explainer on a search result', async () => {
      await page.goto(`${app.origin}/search`);
      await page.fill('#search-query', 'Northwind S02E05');
      await page.click('form.stoolbar button[type="submit"]');
      await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 60_000 })
        .toBe(NEBULA_RESULTS.length);
      await page.click('.rgrid__body-row >> nth=0');
      await page.selectOption('#evaluate-target', { label: 'Sonarr' });
      await page.click('.evaluate-row button:has-text("Evaluate")');
      await page.click('.inspector button:has-text("Compare with file on disk")', { timeout: 60_000 });
      const verdict = page.locator(
        '.inspector section[aria-label="Candidate compared with the file on disk"] :text("Verdict")',
      );
      await verdict.waitFor({ timeout: 60_000 });
      await page.locator('.inspector :text("Candidate vs. on disk")').first().scrollIntoViewIfNeeded();
      expect(await capture('explainer', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
    });

    it('captures unmapped folders, listed, none and unknown', async () => {
      await page.goto(`${app.origin}/unmapped`);
      await page.waitForSelector('.badge.badge-warn:has-text("unknown")', { timeout: 60_000 });
      await page.waitForSelector('[role="grid"] .ggrid__body-row');
      await page.waitForSelector('text=Radarr reported none.');
      expect(await capture('unmapped', TRIAGE_OUT_DIR)).toBeGreaterThan(0);
    });
  });
});
