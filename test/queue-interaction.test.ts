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

/**
 * Enough rows for "row 3 to row 8" (queue-triage-ergonomics AC8), with one row
 * a `Show.S01` filter hides sitting in the middle of them — the row a range
 * computed over the unfiltered list would wrongly sweep in (AC13).
 */
const ODD_ONE: FakeQueueRecord = {
  ...fakeQueue(1, 5)[0],
  title: 'Odd.One.Out.S01E05.1080p.WEB-DL',
  series: { title: 'Odd' },
};
const SONARR_QUEUE = [BLOCKED, ...fakeQueue(3, 2), ODD_ONE, ...fakeQueue(5, 6)];
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
const selectedRows = () => page.locator('.qgrid__body-row[aria-selected="true"]');
const checkbox = (row: number) => rows().nth(row).locator('input[type="checkbox"]');
/** The episode code each row carries, in display order — unique per fixture row. */
const codes = () => rows().evaluateAll((els) => els.map((el) => /S01E\d\d/.exec(el.textContent ?? '')?.[0] ?? ''));
const announcer = () => page.locator('main [role="status"][aria-live="polite"]').filter({ hasText: 'selected' });
const inspectorTitle = () => page.locator('.inspector .inspector__title').textContent();

/**
 * A box's width once it stops moving. `.main` animates its columns, so a read
 * taken straight after opening or expanding lands somewhere mid-transition.
 */
async function settledWidth(selector: string): Promise<number> {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    const width = (await page.locator(selector).boundingBox())?.width ?? 0;
    if (width > 0 && width === last) return width;
    last = width;
    await page.waitForTimeout(50);
  }
  return last;
}

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
  /* ── Range selection and the expandable inspector (queue-triage-ergonomics) ─ */

  it('selects row 3 to row 8 with a click and a shift+click, and says so', async () => {
    await checkbox(2).click();
    await checkbox(7).click({ modifiers: ['Shift'] });

    await page.waitForSelector('.bulkbar');
    expect(await page.textContent('.bulkbar__count')).toBe('6 items selected');
    const selected = await rows().evaluateAll((els) => els.map((el) => el.getAttribute('aria-selected') === 'true'));
    expect(selected.map((on, i) => (on ? i : -1)).filter((i) => i >= 0)).toEqual([2, 3, 4, 5, 6, 7]);
    await expect.poll(async () => (await announcer().textContent())?.trim()).toBe('6 items selected');

    // The shift+click painted no text selection and left focus off the input,
    // so the very next `j` is a command — the cursor followed the click to row 8.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
    await page.keyboard.press('j');
    expect(await cursorText()).toBe(await rows().nth(8).textContent());
  });

  it('never sweeps a row the filter hides into a range', async () => {
    const order = await codes();
    const odd = order.indexOf('S01E05');
    const from = order[odd - 2];
    const to = order[odd + 2];

    await page.locator('.qgrid__body-row', { hasText: `Show.${from}` }).locator('input[type="checkbox"]').click();
    await page.fill('#list-search', 'Show.S01');
    await expect.poll(() => rows().count()).toBe(TOTAL_ROWS - 2);
    await page.locator('.qgrid__body-row', { hasText: `Show.${to}` })
      .locator('input[type="checkbox"]').click({ modifiers: ['Shift'] });
    await expect.poll(() => page.textContent('.bulkbar__count')).toBe('4 items selected');

    await page.fill('#list-search', '');
    await expect.poll(() => rows().count()).toBe(TOTAL_ROWS);
    expect(await selectedRows().count()).toBe(4);
    expect(await page.locator('.qgrid__body-row', { hasText: 'Odd.One.Out' }).getAttribute('aria-selected')).toBe('false');
  });

  it('extends with Shift+J and selects anchor to cursor with Shift+Space', async () => {
    await page.keyboard.press(' ');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+J');
    await expect.poll(() => page.textContent('.bulkbar__count')).toBe('6 items selected');
    expect(await cursorText()).toBe(await rows().nth(5).textContent());

    // Escape clears; then Space anchors row 1, j×3 moves without selecting,
    // and Shift+Space takes rows 1 to 4.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.bulkbar').count()).toBe(0);
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    expect(await selectedRows().count()).toBe(1);
    await page.keyboard.press('Shift+Space');
    await expect.poll(() => page.textContent('.bulkbar__count')).toBe('4 items selected');
  });

  it('leaves the shifted keys to the filter while it has focus', async () => {
    await page.keyboard.press('/');
    await page.keyboard.press('Shift+J');
    await page.keyboard.press('Shift+K');
    await page.keyboard.press('Shift+Space');
    expect(await page.inputValue('#list-search')).toBe('JK ');
    expect(await page.locator('.bulkbar').count()).toBe(0);
    await page.keyboard.press('Escape');
  });

  it('expands the inspector by control and by key, keeps it across a reload, and collapses before closing', async () => {
    await page.keyboard.press('Enter');
    const inspector = page.locator('.inspector');
    await expect.poll(() => inspector.getAttribute('data-expanded')).toBe('false');

    // Wider than the old 380px, beside the list — no modal.
    const narrow = await settledWidth('.inspector');
    expect(narrow).toBeGreaterThan(380);
    expect(await page.locator('[role="dialog"]').count()).toBe(0);

    await page.keyboard.press('e');
    await expect.poll(() => inspector.getAttribute('data-expanded')).toBe('true');
    expect(await page.locator('main.is-expanded').count()).toBe(1);
    // Polled first: the column transition may not have begun on the first read.
    await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(narrow);
    expect(await settledWidth('.inspector')).toBeGreaterThan(narrow);
    expect(await settledWidth('main .content')).toBeGreaterThanOrEqual(359);

    // The cursor still drives it, and it stays expanded.
    const before = await inspectorTitle();
    await page.keyboard.press('j');
    await expect.poll(inspectorTitle).not.toBe(before);
    expect(await inspector.getAttribute('data-expanded')).toBe('true');

    // The control does the same thing as the key.
    await page.click('.inspector__expand');
    await expect.poll(() => inspector.getAttribute('data-expanded')).toBe('false');
    await page.click('.inspector__expand');
    await expect.poll(() => inspector.getAttribute('data-expanded')).toBe('true');

    // Persisted per browser: a reload opens the next inspector expanded.
    await openOverview();
    await page.keyboard.press('Enter');
    await expect.poll(() => inspector.getAttribute('data-expanded')).toBe('true');

    // One Escape collapses, the next closes.
    await page.keyboard.press('Escape');
    await expect.poll(() => inspector.getAttribute('data-expanded')).toBe('false');
    expect(await inspector.count()).toBe(1);
    await page.keyboard.press('Escape');
    expect(await inspector.count()).toBe(0);
  });
});
