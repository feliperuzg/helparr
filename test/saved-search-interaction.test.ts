import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * T16 / AC14, AC15 — FR11, FR12; REQ-SEARCH-011, -012, -013, -014, -015; ADR-6.
 *
 * The node lane already proves the store and the resolution rule. What only a
 * real browser against a real server can prove is the sequence they exist for:
 *
 *  1. an operator saves the search they are looking at,
 *  2. the app server restarts — the definition is still there, scope and all,
 *  3. an indexer leaves Prowlarr,
 *  4. selecting the saved search says so **before** anything is queried, and
 *  5. running it queries only what is left, rather than silently widening to
 *     every indexer (ADR-1) or failing with nothing to read.
 *
 * Step 4 is the one this file exists for. "No indexer is queried by selecting a
 * saved search" (REQ-SEARCH-012) is a claim about a request that was *not*
 * made, and the only honest way to assert it is to watch the upstream and see
 * nothing arrive.
 *
 * The tests run in order and share one page on purpose — the sequence above is
 * the subject, and splitting it into independent cases would mean asserting
 * each step against a state no operator ever passes through.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3985;
const PASSWORD = 'operator-password-for-the-saved-search-run';

const TORRENTDAY = fakeReleases(4, 'TorrentDay', 3);
const NYAA = fakeReleases(7, 'Nyaa', 2);

const FULL_ROSTER = [{ id: 4, name: 'TorrentDay' }, { id: 7, name: 'Nyaa' }];
const WITHOUT_NYAA = [{ id: 4, name: 'TorrentDay' }];

let app: AppServer;
let dataDir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let prowlarr: FakeProwlarr;

const savedChip = (name: string) => page.locator(`.saved .filter-chip:has-text("${name}")`);

/** The one sentence naming what is missing, if there is one on screen. */
const savedNote = () => page.locator('.saved .callout > div');

const submitButton = () => page.locator('form.stoolbar button[type="submit"]');

/** Reloads the screen and waits for the roster the chips are drawn from. */
async function openSearch() {
  await page.goto(`${app.origin}/search`);
  await page.waitForSelector('form.stoolbar');
  // A saved scope is resolved in the browser against exactly these chips.
  // Asserting before they arrive would be asserting against an empty roster,
  // which the screen correctly refuses to draw any conclusion from.
  await page.waitForSelector('.stoolbar .filter-chip:has-text("TorrentDay")');
  await page.waitForSelector('.saved');
}

/** Saves whatever the toolbar currently holds, under `name`. */
async function saveCurrent(name: string) {
  await page.click('.saved__actions button:has-text("Save this search")');
  await page.fill('#saved-search-name', name);
  await page.click('.modal button.btn-primary');
  await expect.poll(() => savedChip(name).count()).toBe(1);
}

describe('saved searches', { timeout: 150_000 }, () => {
  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({ apiKey: 'prowlarr-key', indexers: FULL_ROSTER });
    prowlarr.setResults(4, TORRENTDAY);
    prowlarr.setResults(7, NYAA);
    prowlarr.setResults(null, [...TORRENTDAY, ...NYAA]);

    // Owned by the suite rather than by either server: a server that made its
    // own directory also removes it on close, and the restart below would then
    // boot against an empty database — which reads as "the saved searches did
    // not survive" when in fact nothing survived, instance registration
    // included.
    dataDir = mkdtempSync(join(tmpdir(), 'helparr-saved-search-'));
    app = await startApp({ port: PORT, password: PASSWORD, dataDir });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, {
      type: 'api-key', apiKey: 'prowlarr-key',
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await prowlarr?.close();
    // Owned by this suite from the moment it was handed back to `startApp`.
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('saves the search on screen, scope and all', async () => {
    await openSearch();

    await page.fill('#search-query', 'the expanse');
    await page.click('.stoolbar .filter-chip:has-text("TorrentDay")');
    await page.click('.stoolbar .filter-chip:has-text("Nyaa")');
    await submitButton().click();
    await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 }).toBe(5);

    await saveCurrent('Weekly sweep');

    // Selected on save, because the operator is looking at exactly what was
    // stored — anything else would make the next Search ambiguous.
    await expect.poll(() => savedChip('Weekly sweep').getAttribute('aria-pressed')).toBe('true');
  });

  it('saves a second search scoped to one indexer, while that indexer exists', async () => {
    await openSearch();

    await page.fill('#search-query', 'cowboy bebop');
    await page.click('.stoolbar .filter-chip:has-text("Nyaa")');
    await saveCurrent('Nyaa alone');

    // Saving spends nothing upstream: a definition is stored verbatim and
    // resolved at run time (ADR-6), so there is nothing to ask Prowlarr yet.
    expect(prowlarr.searches.filter((hit) => hit.query === 'cowboy bebop')).toHaveLength(0);
  });

  it('still has both definitions after the app server restarts', async () => {
    // REQ-SEARCH-013 asks for the definition after a restart, and a restart is
    // exactly the moment an operator reaches for a saved search — so this runs
    // against a genuinely new process on the same database file, not a reload.
    await app.close();
    app = await startApp({ port: PORT, password: PASSWORD, dataDir });

    // A restart invalidates every session on purpose: the signing material is
    // process-local (REQ-AUTH-006), which is the conservative direction for an
    // app whose whole job is holding other systems' credentials.
    await login(page, app.origin, PASSWORD);
    await openSearch();

    await expect.poll(() => page.locator('.saved .filter-chip').count()).toBe(2);

    prowlarr.searches.length = 0;
    await savedChip('Weekly sweep').click();

    // The definition came back whole: the query and both scoped indexers.
    await expect.poll(() => page.inputValue('#search-query')).toBe('the expanse');
    await expect
      .poll(() => page.locator('.stoolbar .filter-chip[aria-pressed="true"]').allTextContents())
      .toEqual(expect.arrayContaining([
        expect.stringContaining('TorrentDay'),
        expect.stringContaining('Nyaa'),
      ]));

    // And nothing was queried to find that out (REQ-SEARCH-012).
    expect(prowlarr.searches).toHaveLength(0);
  });

  it('names an indexer that has left Prowlarr before a single query is spent', async () => {
    prowlarr.setIndexers(WITHOUT_NYAA);

    await openSearch();
    prowlarr.searches.length = 0;
    await savedChip('Weekly sweep').click();

    // Named, not counted. "1 indexer is gone" only tells the operator to go and
    // find out which, which is the work this sentence exists to save.
    await expect.poll(() => savedNote().textContent())
      .toBe('Nyaa is no longer in Prowlarr. This search will run without it.');
    expect(prowlarr.searches).toHaveLength(0);

    // Still runnable on what is left, so Search is still offered.
    await expect.poll(() => submitButton().isDisabled()).toBe(false);
  });

  it('runs the degraded search against what is left, and only that', async () => {
    await submitButton().click();
    await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 }).toBe(3);

    const hit = prowlarr.searches.at(-1);
    // Not the saved pair, and — the failure that matters — not the empty list
    // the search route reads as *every* indexer (ADR-1).
    expect(hit?.indexerIds).toEqual(['4']);
  });

  it('refuses a search whose whole scope is gone rather than widening it', async () => {
    await openSearch();
    prowlarr.searches.length = 0;
    await savedChip('Nyaa alone').click();

    await expect.poll(() => savedNote().textContent())
      .toBe('Nyaa is no longer in Prowlarr, and this search was scoped to nothing else.');

    // Refused here, next to the sentence that says why, rather than costing a
    // round trip to be refused server-side.
    await expect.poll(() => submitButton().isDisabled()).toBe(true);
    expect(prowlarr.searches).toHaveLength(0);
  });

  it('names the search it is about to delete, and forgets only that one', async () => {
    await page.click('.saved__actions button:has-text("Delete")');

    // REQ-SEARCH-015: the name is in the sentence and on the button, because a
    // confirmation that says "delete this?" is one the operator answers about
    // whichever row they think is selected.
    await expect.poll(() => page.locator('.modal').textContent()).toContain('Nyaa alone');
    await page.click('.modal button.btn-danger-solid');

    await expect.poll(() => savedChip('Nyaa alone').count()).toBe(0);
    await expect.poll(() => savedChip('Weekly sweep').count()).toBe(1);
  });
});
