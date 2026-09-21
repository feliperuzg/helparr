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
async function capture(name: string): Promise<number> {
  // Fonts and any entry transition have to have finished, or two runs of this
  // file produce two different images from the same state.
  await page.waitForTimeout(400);
  const raw = await page.screenshot({ type: 'png' });
  const info = await sharp(raw)
    .resize({ width: OUTPUT_WIDTH })
    .png({ compressionLevel: 9, palette: true })
    .toFile(join(OUT_DIR, `${name}.png`));
  return info.size;
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
});
