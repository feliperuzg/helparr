import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { login, seedInstance, startApp, type AppServer } from './helpers/appServer';
import { parsedSeries, startFakeArr, type FakeArr } from './helpers/fakeArr';
import { fakeReleases, startFakeProwlarr, type FakeProwlarr } from './helpers/fakeProwlarr';

/**
 * T23 / FR7, FR8; REQ-OPS-006, -007; REQ-SEARCH-006; ADR-3.
 *
 * The browser half of "nothing is sent before the operator confirms". The other
 * half is `grab-semantics.test.ts`, which proves the orchestration sends one
 * push and no more; this one proves the UI never reaches that orchestration
 * until the confirming click, and that what it says in between is true.
 *
 * Four properties, all of them invisible to a component harness because they
 * are claims about the whole path row → inspector → dialog → confirm:
 *
 * 1. Opening the confirmation sends nothing — asserted by counting the pushes
 *    the real Sonarr received, not by reading the handler.
 * 2. The confirmation names what the *destination* resolved, and says so in the
 *    destination's words — including when the answer is "nothing".
 * 3. There is no optimistic success: while the push is in flight the dialog
 *    says it is sending, and the outcome only appears once Sonarr has answered.
 * 4. A rejection's reasons reach Activity verbatim — the toast counts them, the
 *    log carries the text.
 *
 * Gated behind HELPARR_E2E_TEST (set by `npm run test:e2e`).
 */

const PORT = 3992;
const PASSWORD = 'operator-password-for-the-grab-run';

const RELEASES = fakeReleases(4, 'TorrentDay', 3);

const REJECTIONS = [
  'Existing file meets cutoff: WEBDL-1080p',
  'Not a preferred word upgrade for existing episode file(s)',
  'Quality WEBDL-1080p is not wanted in profile',
];

let app: AppServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let prowlarr: FakeProwlarr;
let sonarr: FakeArr;

const modal = () => page.locator('.modal[role="dialog"]');

/** Reloads the screen and runs the one search the operator asked for. */
async function search() {
  await page.goto(`${app.origin}/search`);
  await page.fill('#search-query', 'show');
  await page.click('form.stoolbar button[type="submit"]');
  await expect.poll(() => page.locator('.rgrid__body-row').count(), { timeout: 20_000 }).toBe(3);
}

/**
 * Row → inspector → dialog. The only path to a write (FR7).
 *
 * Returns once the dialog has settled into one of its two resolved states —
 * the target card or the "could not match" warning. Asserting before that would
 * be asserting against "Resolving…", which is neither.
 */
async function openConfirmation(title: string) {
  await page.click(`.rgrid__body-row:has-text("${title}")`);
  await page.waitForSelector('.inspector');
  await page.click('.inspector__foot .btn-primary');
  await page.waitForSelector('.modal[role="dialog"]');
  await page.waitForSelector('.modal .grab-target, .modal .grab-resolve .callout');
}

describe('grab confirmation', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    prowlarr = await startFakeProwlarr({
      apiKey: 'prowlarr-key',
      indexers: [{ id: 4, name: 'TorrentDay' }],
    });
    prowlarr.setResults(4, RELEASES);
    sonarr = await startFakeArr({ apiKey: 'sonarr-key' });
    app = await startApp({ port: PORT, password: PASSWORD });

    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    await login(page, app.origin, PASSWORD);
    await seedInstance(page, 'prowlarr', 'Prowlarr', prowlarr.url, { type: 'api-key', apiKey: 'prowlarr-key' });
    await seedInstance(page, 'sonarr', 'Sonarr', sonarr.url, { type: 'api-key', apiKey: 'sonarr-key' });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await prowlarr?.close();
    await sonarr?.close();
  });

  beforeEach(async () => {
    sonarr.hits.length = 0;
    sonarr.pushes.length = 0;
    sonarr.setDelay(0);
    sonarr.setParse(parsedSeries());
    sonarr.setPushResult({ rejected: false, rejections: [] });
  });

  it('opens the confirmation, names what Sonarr resolved, and sends nothing', async () => {
    await search();
    await openConfirmation('Show.S01E01');

    const text = (await modal().textContent()) ?? '';
    // The destination's answer, not the operator's selection (REQ-OPS-007).
    expect(text).toContain('Sonarr will attach this to');
    expect(text).toContain('Show — S01E01');
    expect(text).toContain('WEBDL-1080p');
    // Said out loud, because it is the property the whole dialog exists for.
    expect(text).toContain('helparr has sent nothing yet.');

    // And it is true: the only traffic the confirmation caused was the read.
    expect(sonarr.pushes).toHaveLength(0);
    expect(sonarr.hits.some((hit) => hit.path.startsWith('/api/v3/parse'))).toBe(true);
    expect(sonarr.hits.every((hit) => hit.method === 'GET')).toBe(true);

    // Cancelling is not a write either — the operator can back out of the one
    // screen in helparr that precedes a write, at no cost.
    await page.click('.modal__foot .btn-ghost');
    await expect.poll(() => modal().count()).toBe(0);
    expect(sonarr.pushes).toHaveLength(0);
  });

  it('says so when Sonarr cannot place the release, and labels the button with the risk', async () => {
    // A name Sonarr resolves to nothing. The release would be accepted and then
    // never imported, so the dialog has to name that outcome rather than offer
    // the same confident button.
    sonarr.setParse(null);
    await search();
    await openConfirmation('Show.S01E02');

    const text = (await modal().textContent()) ?? '';
    expect(text).toContain('could not match this release to anything it tracks');
    expect(text).toContain('downloads and sits there');

    const confirm = page.locator('.modal__foot button:not(.btn-ghost)');
    expect((await confirm.textContent())?.trim()).toBe('Grab anyway');
    // Still offered — the operator may know something Sonarr does not — but not
    // as the primary action.
    expect(await confirm.getAttribute('class')).toContain('btn-outline');
    expect(sonarr.pushes).toHaveLength(0);

    await page.keyboard.press('Escape');
    await expect.poll(() => modal().count()).toBe(0);
    expect(sonarr.pushes).toHaveLength(0);
  });

  it('claims no success until Sonarr has answered', async () => {
    await search();
    await openConfirmation('Show.S01E01');

    // The push stalls, so the in-flight state is observable rather than raced
    // past. The parse has already returned by now, so only the write is slow.
    sonarr.setDelay(1200);
    await page.click('.modal__foot button:not(.btn-ghost)');

    await page.waitForSelector('.modal [role="status"][aria-busy="true"]');
    const inFlight = (await modal().textContent()) ?? '';
    // What is happening, not what it hopes will happen (FR8, REQ-OPS-006).
    expect(inFlight).toContain('Sending to Sonarr…');
    expect(inFlight).not.toContain('Grabbed');
    expect(await page.locator('.toast').count()).toBe(0);

    // The outcome arrives from the response, and only then does the dialog go.
    await expect.poll(async () => (await page.locator('.toast-stack').textContent()) ?? '', {
      timeout: 15_000,
    }).toContain('Grabbed into Sonarr — Show — S01E01');
    expect(await modal().count()).toBe(0);

    // Once. A push is not idempotent from the operator's side, so a confirmed
    // grab is one request and the UI never re-sends it.
    expect(sonarr.pushes).toHaveLength(1);
    sonarr.setDelay(0);
  });

  it('counts the rejections in the toast and writes them to Activity verbatim', async () => {
    sonarr.setPushResult({ rejected: true, rejections: REJECTIONS });
    await search();
    await openConfirmation('Show.S01E03');
    await page.click('.modal__foot button:not(.btn-ghost)');

    // A toast that vanishes in four seconds is no place for three sentences the
    // operator has to read carefully — so it counts them and points at the log.
    await expect.poll(async () => (await page.locator('.toast-stack').textContent()) ?? '', {
      timeout: 15_000,
    }).toContain('Sonarr declined the release — 3 reasons. See Activity.');
    expect(sonarr.pushes).toHaveLength(1);

    await page.goto(`${app.origin}/operations`);
    const row = page.locator('.oplog__row', { hasText: 'Show.S01E03' }).first();
    await row.waitFor({ timeout: 15_000 });

    // Recorded as an attempt that failed, with Sonarr's words untouched:
    // three reasons, three lines, no summary and no sentence-casing.
    expect((await row.textContent()) ?? '').toContain('Grab into Sonarr — Show — S01E01');
    const detail = await row.locator('.oplog__detail li').allTextContents();
    expect(detail).toEqual(REJECTIONS);
  });
});
