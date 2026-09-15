import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeQueue, startFakeArr, type FakeArr, type FakeQueueRecord } from './helpers/fakeArr';

/**
 * The four acceptance criteria the other browser suites do not reach: the
 * inspector's four upstream channels, the degraded banner naming its instance,
 * the keyboard layer, and the bulk bar's count.
 *
 * All four are properties of the assembled screen rather than of any one
 * component — a keyboard handler bound to `window`, a banner fed by the read's
 * `errors` array, a count derived from a selection reconciled against the last
 * refetch. Testing them against a component harness would be testing the
 * harness's wiring instead of the screen's.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3991;
const PASSWORD = 'operator-password-for-the-interaction-run';

/**
 * The row the inspector test reads. Every one of the four upstream channels
 * carries a *different* value, so a panel that collapsed them into one derived
 * sentence — which is what REQ-QUEUE-004 forbids — cannot pass by accident.
 */
const BLOCKED: FakeQueueRecord = {
  id: 1,
  title: 'Blocked.Import.S01E01.1080p.WEB-DL',
  size: 2_000_000_000,
  sizeleft: 0,
  protocol: 'torrent',
  indexer: 'Indexer',
  status: 'completed',
  trackedDownloadStatus: 'warning',
  trackedDownloadState: 'importBlocked',
  downloadId: 'HASH1',
  statusMessages: [{
    title: 'Blocked.Import.S01E01.1080p.WEB-DL',
    messages: ['Found matching series via grab history, but series was not found in your library.'],
  }],
  series: { title: 'Blocked' },
  episodes: [{ seasonNumber: 1, episodeNumber: 1 }],
};

const SONARR_QUEUE = [BLOCKED, ...fakeQueue(4, 2)];
const RADARR_QUEUE = fakeQueue(2, 20);
const TOTAL_ROWS = SONARR_QUEUE.length + RADARR_QUEUE.length;

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sonarr: FakeArr;
let radarr: FakeArr;

const rows = () => page.locator('.qgrid__body-row');
const cursorText = async () => (await page.locator('.qgrid__body-row.is-cursor').textContent()) ?? '';

async function openOverview() {
  await page.goto(app.origin);
  await expect.poll(() => rows().count(), { timeout: 15_000 }).toBe(TOTAL_ROWS);
}

describe('queue interaction', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    sonarr = await startFakeArr({ apiKey: 'sonarr-key', queue: SONARR_QUEUE });
    radarr = await startFakeArr({ apiKey: 'radarr-key', queue: RADARR_QUEUE });
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
    await seedInstance(page, 'radarr', 'Radarr', radarr.url, { type: 'api-key', apiKey: 'radarr-key' });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await sonarr?.close();
    await radarr?.close();
  });

  beforeEach(async () => {
    await openOverview();
  });

  it('shows all four upstream channels in the inspector, separately and verbatim', async () => {
    await page.click('.qgrid__body-row:has-text("Blocked.Import.S01E01")');
    await page.waitForSelector('.inspector');

    const fields = await page.locator('.inspector .kv').evaluateAll((lists) => {
      const out: Record<string, string> = {};
      for (const list of lists) {
        const keys = list.querySelectorAll('.kv__k');
        const values = list.querySelectorAll('.kv__v');
        keys.forEach((key, i) => { out[key.textContent ?? ''] = values[i]?.textContent ?? ''; });
      }
      return out;
    });

    // Four channels, four distinct values. `status: completed` next to
    // `trackedDownloadState: importBlocked` is the diagnosis, and it only
    // exists because neither was collapsed into the other.
    expect(fields.status).toBe('completed');
    expect(fields.trackedDownloadStatus).toBe('warning');
    expect(fields.trackedDownloadState).toBe('importBlocked');
    expect(fields.statusMessages).toContain('series was not found in your library');

    await page.click('[aria-label="Close inspector (Esc)"]');
  });

  it('drives the grid from the keyboard, and yields the keys to a text field', async () => {
    // The cursor starts on the first row and `j`/`k` walk it.
    const first = await cursorText();
    await page.keyboard.press('j');
    const second = await cursorText();
    expect(second).not.toBe(first);
    await page.keyboard.press('k');
    expect(await cursorText()).toBe(first);

    // Space selects the cursor row without opening anything.
    await page.keyboard.press(' ');
    await page.waitForSelector('.bulkbar');
    expect(await page.locator('.qgrid__body-row[aria-selected="true"]').count()).toBe(1);
    expect(await page.locator('.inspector').count()).toBe(0);

    // Enter inspects it; Escape closes the inspector and leaves the selection,
    // because one press does one thing.
    await page.keyboard.press('Enter');
    await page.waitForSelector('.inspector');
    await page.keyboard.press('Escape');
    expect(await page.locator('.inspector').count()).toBe(0);
    expect(await page.locator('.bulkbar').count()).toBe(1);

    // Only then does Escape clear the selection.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.bulkbar').count()).toBe(0);

    // `/` focuses the filter from anywhere on the screen…
    await page.keyboard.press('/');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('list-search');

    // …and from there `j` and `k` are characters, not commands. This is the bug
    // the pattern always ships with: typing "jk" moving the cursor instead of
    // reaching the input.
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    expect(await page.inputValue('#list-search')).toBe('jk');
    await page.waitForSelector('text=Nothing matches that filter');

    // Escape still fires while typing — it is how the operator gets back out.
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('list-search');
  });

  it('counts exactly the selected rows in the bulk bar', async () => {
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');

    await page.waitForSelector('.bulkbar');
    expect(await page.textContent('.bulkbar__count')).toBe('3 items selected');
    expect(await page.locator('.qgrid__body-row[aria-selected="true"]').count()).toBe(3);

    await page.click('.bulkbar .btn-ghost');
    await expect.poll(() => page.locator('.bulkbar').count()).toBe(0);
  });

  it('names the unreadable instance and keeps the rest of the queue on screen', async () => {
    radarr.setMode('server-error');
    await page.click('.btn-outline:has-text("Refresh all")');

    const banner = page.locator('.banner');
    await expect.poll(async () => (await banner.textContent()) ?? '', { timeout: 15_000 })
      .toContain('Radarr');

    // Naming it is the point: the operator's next move is different for Radarr
    // being down than for the download client being down.
    const text = (await banner.textContent()) ?? '';
    expect(text).toMatch(/could not be read|is not being contacted/);
    expect(text).toContain(`Showing ${SONARR_QUEUE.length} rows`);

    // The screen narrows; it does not blank or error.
    expect(await rows().count()).toBe(SONARR_QUEUE.length);
    expect(await page.locator('.qgrid__body-row:has-text("Blocked.Import.S01E01")').count()).toBe(1);

    radarr.setMode('ok');
  });
});
