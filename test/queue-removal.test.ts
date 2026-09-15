import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { startFakeArr, type FakeArr, type FakeQueueRecord } from './helpers/fakeArr';

/**
 * T23 / REQ-QUEUE-013, -014 — the destructive path, driven end to end.
 *
 * Three properties, each of which is a lie the screen must never tell: that
 * something was sent when it was not, that a row is gone when it is still
 * queued, and that a removal succeeded when the upstream refused it. All three
 * are only observable against the real route handler and a real upstream, which
 * is why this runs in the browser lane rather than under jsdom.
 *
 * Assertions poll through vitest's `expect.poll` rather than Playwright's
 * web-first matchers — those live in `@playwright/test`, and this suite runs on
 * the same vitest runner as the rest.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`) because it needs
 * `next build` plus a downloaded Chromium.
 */

const PORT = 3988;
const PASSWORD = 'operator-password-for-the-removal-e2e';

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;

function record(id: number, title: string): FakeQueueRecord {
  return {
    id,
    title,
    size: 2_000_000_000,
    sizeleft: 800_000_000,
    protocol: 'torrent',
    indexer: 'Indexer',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    downloadId: `HASH${id}`,
    series: { title: 'Show' },
    episodes: [{ seasonNumber: 3, episodeNumber: id }],
  };
}

const RECORDS = [
  record(1, 'Show.S03E01.1080p.WEB-DL'),
  record(2, 'Show.S03E02.1080p.WEB-DL'),
  record(3, 'Show.S03E03.1080p.WEB-DL'),
];

const rows = () => page.locator('.qgrid__body-row');
const rowFor = (title: string) => page.locator('.qgrid__body-row', { hasText: title });

/** Class list of a single row, '' while it is absent, for `toContain` checks. */
const classesOf = async (row: Locator) => {
  try {
    return (await row.getAttribute('class')) ?? '';
  } catch {
    return '';
  }
};

const textOf = async (locator: Locator) => {
  try {
    return (await locator.textContent()) ?? '';
  } catch {
    return '';
  }
};

/** Opens the confirmation dialog for one row, by release title. */
async function openPreviewFor(title: string) {
  await page.click(`input[aria-label="Select ${title}"]`);
  await page.click('.bulkbar .btn-danger');
  await page.waitForSelector('[role="dialog"]');
}

describe('queue removal', () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: RECORDS });

    // Five seconds is the configured floor; the poll has to be fast enough that
    // "the row is gone" converges inside a test, and slow enough that it is not
    // what makes the row disappear.
    app = await startApp({
      port: PORT,
      password: PASSWORD,
      env: { HELPARR_QUEUE_REFRESH_SECONDS: '5' },
    });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, {
      type: 'api-key', apiKey: 'sonarr-key',
    });
  }, 120_000);

  beforeEach(async () => {
    sonarr.setQueue(RECORDS);
    sonarr.setRemovalDelay(0);
    sonarr.failRemovals([]);
    sonarr.removals.length = 0;
    await page.goto(app.origin);
    await page.waitForSelector('.qgrid__body-row');
    await expect.poll(() => rows().count(), { timeout: 15_000 }).toBe(3);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
  });

  it('sends nothing until the operator confirms', async () => {
    await openPreviewFor('Show.S03E01.1080p.WEB-DL');

    // Every affected item is named, not counted (REQ-QUEUE-013).
    expect(await page.locator('.removal-list li').count()).toBe(1);
    expect(await textOf(page.locator('.removal-list li').first()))
      .toContain('Show.S03E01.1080p.WEB-DL');

    // The dialog is up, the flags are visible, and the upstream has heard
    // nothing at all. This is the assertion the whole preview exists for.
    expect(sonarr.removals).toEqual([]);

    await page.click('.modal__foot .btn-ghost');
    await page.waitForSelector('[role="dialog"]', { state: 'detached' });

    // Cancelling sends nothing either, and the row is untouched.
    expect(sonarr.removals).toEqual([]);
    expect(await rows().count()).toBe(3);
  }, 30_000);

  it('keeps the row on screen until the upstream confirms, then drops it', async () => {
    // Slow enough to observe the in-flight state. No optimistic update: the row
    // must still be there, marked, while the request is outstanding.
    sonarr.setRemovalDelay(1_500);
    await openPreviewFor('Show.S03E02.1080p.WEB-DL');
    await page.click('.modal__foot .btn-danger-solid');

    const row = rowFor('Show.S03E02.1080p.WEB-DL');
    await expect.poll(() => classesOf(row), { timeout: 5_000 }).toContain('is-pending');
    expect(await textOf(row)).toContain('Removing…');
    expect(await rows().count()).toBe(3);

    // The flags cross the wire exactly as the dialog presented them — the one
    // destructive default checked, the two after-effects off (ADR-4).
    await expect.poll(() => sonarr.removals.length, { timeout: 10_000 }).toBe(1);
    expect(sonarr.removals[0]).toEqual({
      recordId: 2,
      flags: { removeFromClient: 'true', blocklist: 'false', skipRedownload: 'false' },
    });

    await expect.poll(() => textOf(page.locator('.toast--ok')), { timeout: 10_000 })
      .toContain('Removed 1 item');

    // And it is the refetch, not the click, that finally removes the row.
    await expect.poll(() => rows().count(), { timeout: 15_000 }).toBe(2);
    expect(await row.count()).toBe(0);
  }, 40_000);

  it('leaves the row in place when the upstream refuses, and says why', async () => {
    sonarr.failRemovals([3]);
    await openPreviewFor('Show.S03E03.1080p.WEB-DL');
    await page.click('.modal__foot .btn-danger-solid');

    await expect.poll(() => sonarr.removals.length, { timeout: 10_000 }).toBe(1);

    // The error is attributed to the item by name — a failed removal never
    // silently disappears, and never hides behind a batch-level verdict.
    const toast = page.locator('.toast--error');
    await expect.poll(() => textOf(toast), { timeout: 10_000 })
      .toContain('Show.S03E03.1080p.WEB-DL');
    expect(await textOf(toast)).toContain('500');
    expect(await page.locator('.toast--ok').count()).toBe(0);

    // The row is still queued, still there, and out of the pending state, so
    // the operator can try again.
    const row = rowFor('Show.S03E03.1080p.WEB-DL');
    await expect.poll(async () => (await classesOf(row)).includes('is-pending'), {
      timeout: 10_000,
    }).toBe(false);
    expect(await row.count()).toBe(1);
    expect(await rows().count()).toBe(3);
  }, 40_000);
});
